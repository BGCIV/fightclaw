import { spawn } from "node:child_process";

export const DEFAULT_DURABLE_TEST_TIMEOUT_MS = 120_000;
const TERMINATE_GRACE_MS = 1_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeTimeoutMs = (rawTimeoutMs) => {
	const timeoutMs = Number(rawTimeoutMs);

	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return DEFAULT_DURABLE_TEST_TIMEOUT_MS;
	}

	return timeoutMs;
};

const getRunFile = (run) => run.env?.VITEST_INCLUDE ?? run.args.join(" ");

const killChildProcess = (child, signal) => {
	if (!child.pid) {
		return;
	}

	if (process.platform !== "win32") {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {}
	}

	try {
		child.kill(signal);
	} catch {}
};

export const spawnVitestRun = (run, options = {}) => {
	const child = spawn(run.command ?? process.execPath, run.args, {
		stdio: options.stdio ?? "inherit",
		env: {
			...process.env,
			...run.env,
			...options.env,
		},
		detached: process.platform !== "win32",
	});

	const completion = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			resolve({
				exitCode: code ?? (signal ? 1 : 0),
				signal: signal ?? null,
			});
		});
	});

	return {
		completion,
		terminate: async (signal = "SIGKILL") => {
			killChildProcess(child, signal);
			await Promise.race([
				completion.catch(() => null),
				delay(TERMINATE_GRACE_MS),
			]);
		},
	};
};

const recordResult = (summary, outcome) => {
	switch (outcome.kind) {
		case "passed":
			summary.passed.push(outcome);
			return;
		case "failed":
			summary.failed.push(outcome);
			return;
		case "timedOut":
			summary.timedOut.push(outcome);
			return;
	}
};

export const runVitestRuns = async (runs, options = {}) => {
	const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
	const now = options.now ?? Date.now;
	const write = options.write ?? console.log;
	const spawnRun =
		options.spawnRun ??
		((run) =>
			spawnVitestRun(run, {
				env: options.env,
				stdio: options.stdio,
			}));

	const summary = {
		totalRuns: runs.length,
		durationMs: 0,
		exitCode: 0,
		passed: [],
		failed: [],
		timedOut: [],
	};
	const suiteStartedAt = now();

	for (const run of runs) {
		const file = getRunFile(run);
		const runStartedAt = now();
		const handle = spawnRun(run);
		let cleanupPromise = Promise.resolve();

		write(`[durable] starting ${file}`);

		const outcome = await new Promise((resolve) => {
			let settled = false;
			let timeoutId = null;
			let timedOut = false;

			const finish = (result) => {
				if (settled) {
					return;
				}

				settled = true;
				if (timeoutId !== null) {
					clearTimeout(timeoutId);
				}
				resolve(result);
			};

			timeoutId = setTimeout(() => {
				timedOut = true;
				finish({
					kind: "timedOut",
					file,
					durationMs: now() - runStartedAt,
					timeoutMs,
				});

				cleanupPromise = Promise.resolve(handle.terminate?.("SIGKILL")).catch(
					(error) => {
						write(`[durable] cleanup failed for ${file}: ${String(error)}`);
					},
				);
			}, timeoutMs);

			Promise.resolve(handle.completion).then(
				(result) => {
					if (timedOut) {
						return;
					}

					finish({
						kind: result.exitCode === 0 ? "passed" : "failed",
						file,
						durationMs: now() - runStartedAt,
						exitCode: result.exitCode ?? 1,
						signal: result.signal ?? null,
						error: null,
					});
				},
				(error) => {
					if (timedOut) {
						return;
					}

					finish({
						kind: "failed",
						file,
						durationMs: now() - runStartedAt,
						exitCode: 1,
						signal: null,
						error,
					});
				},
			);
		});

		recordResult(summary, outcome);

		if (outcome.kind === "timedOut") {
			await cleanupPromise;
		}

		if (outcome.kind === "passed") {
			write(`[durable] passed ${file} (${outcome.durationMs}ms)`);
			continue;
		}

		if (outcome.kind === "failed") {
			write(
				`[durable] failed ${file} (${outcome.durationMs}ms, exit=${outcome.exitCode}${outcome.signal ? `, signal=${outcome.signal}` : ""})`,
			);
			if (outcome.error) {
				write(String(outcome.error));
			}
			continue;
		}

		write(
			`[durable] timed out ${file} (${outcome.durationMs}ms, timeout=${outcome.timeoutMs}ms)`,
		);
	}

	summary.durationMs = now() - suiteStartedAt;
	summary.exitCode =
		summary.failed.length > 0 || summary.timedOut.length > 0 ? 1 : 0;

	return summary;
};

const formatBucket = (label, entries, detailFormatter) => {
	if (entries.length === 0) {
		return [`${label}: 0`];
	}

	return [`${label}: ${entries.length}`, ...entries.map(detailFormatter)];
};

export const formatDurableRunSummary = (summary) =>
	[
		"[durable] summary",
		`Total: ${summary.totalRuns}`,
		...formatBucket(
			"Passed",
			summary.passed,
			(entry) => `  - ${entry.file} (${entry.durationMs}ms)`,
		),
		...formatBucket(
			"Failed",
			summary.failed,
			(entry) =>
				`  - ${entry.file} (${entry.durationMs}ms, exit=${entry.exitCode}${entry.signal ? `, signal=${entry.signal}` : ""})`,
		),
		...formatBucket(
			"Timed out",
			summary.timedOut,
			(entry) =>
				`  - ${entry.file} (${entry.durationMs}ms, timeout=${entry.timeoutMs}ms)`,
		),
		`Duration: ${summary.durationMs}ms`,
	].join("\n");
