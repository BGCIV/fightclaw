import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

const SERVER_PORT = 3000;
const SERVER_BASE_URL = `http://127.0.0.1:${SERVER_PORT}`;
const ADMIN_KEY = "smoke-admin";
const RUNNER_KEY = "smoke-runner-key";
const TESTER_RUNNER_ID = "smoke-tester-runner";
const HOUSE_RUNNER_ID = "smoke-house-runner";
const API_KEY_PEPPER = "smoke-pepper";
const PROMPT_ENCRYPTION_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const SERVER_START_TIMEOUT_MS = 30_000;
const CLAIM_CODE_TIMEOUT_MS = 20_000;
const MATCH_PROGRESS_TIMEOUT_MS = 120_000;
const CLI_TIMEOUT_MS = 150_000;
const HOUSE_TIMEOUT_MS = 150_000;
const VERIFY_TIMEOUT_MS = 10_000;
const MIGRATION_TIMEOUT_MS = 30_000;
const NATURAL_END_TIMEOUT_MS = 60_000;

export const DEFAULT_SMOKE_PRESET_ID = "objective_beta";
export const DEFAULT_SMOKE_GATEWAY_CMD =
	"pnpm exec tsx scripts/gateway-move.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ensurePortAvailable = async (port) => {
	await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	});
};

const waitFor = async (fn, predicate, timeoutMs, label, intervalMs = 100) => {
	const endAt = Date.now() + timeoutMs;
	let last = await fn();
	while (Date.now() < endAt) {
		if (predicate(last)) return last;
		await sleep(intervalMs);
		last = await fn();
	}
	throw new Error(
		`Timed out waiting for ${label}. Last value: ${JSON.stringify(last)}`,
	);
};

const guardProcessWhileWaiting = (proc, label, waitLabel) => {
	return proc.result.then((result) => {
		if (result.timedOut) {
			throw new Error(`${label} timed out while waiting for ${waitLabel}.`);
		}
		if (result.code !== 0) {
			throw new Error(
				`${label} exited with code ${result.code ?? "unknown"} while waiting for ${waitLabel}.`,
			);
		}
		return new Promise(() => {});
	});
};

const waitForOrChildFailure = async ({
	fn,
	predicate,
	timeoutMs,
	label,
	intervalMs = 100,
	guards = [],
}) => {
	return await Promise.race([
		waitFor(fn, predicate, timeoutMs, label, intervalMs),
		...guards.map((guard) =>
			guardProcessWhileWaiting(guard.proc, guard.label, label),
		),
	]);
};

const waitForHealth = async () => {
	await waitFor(
		async () => {
			try {
				const res = await fetch(`${SERVER_BASE_URL}/health`);
				return {
					ok: res.ok,
					status: res.status,
					text: await res.text(),
				};
			} catch (error) {
				return {
					ok: false,
					status: null,
					text: error instanceof Error ? error.message : String(error),
				};
			}
		},
		(value) => value.ok === true && value.text === "OK",
		SERVER_START_TIMEOUT_MS,
		"local wrangler health",
	);
};

const createLogFiles = () => {
	const dir = mkdtempSync(path.join(tmpdir(), "fightclaw-openclaw-beta-"));
	const files = {
		dir,
		migrateStdout: path.join(dir, "migrate.stdout.log"),
		migrateStderr: path.join(dir, "migrate.stderr.log"),
		dbStdout: path.join(dir, "db.stdout.log"),
		dbStderr: path.join(dir, "db.stderr.log"),
		serverStdout: path.join(dir, "server.stdout.log"),
		serverStderr: path.join(dir, "server.stderr.log"),
		testerStdout: path.join(dir, "tester.stdout.log"),
		testerStderr: path.join(dir, "tester.stderr.log"),
		operatorStdout: path.join(dir, "operator.stdout.log"),
		operatorStderr: path.join(dir, "operator.stderr.log"),
		houseStdout: path.join(dir, "house.stdout.log"),
		houseStderr: path.join(dir, "house.stderr.log"),
	};
	for (const filePath of Object.values(files)) {
		if (filePath !== dir) {
			writeFileSync(filePath, "", "utf8");
		}
	}
	return files;
};

const appendLog = (filePath, chunk) => {
	writeFileSync(filePath, chunk, { encoding: "utf8", flag: "a" });
};

const writeJson = (filePath, value) => {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const toArtifactSnapshot = (snapshot, fallbackLabel) => {
	if (snapshot && typeof snapshot === "object") {
		return snapshot;
	}
	return {
		ok: false,
		status: null,
		error: `${fallbackLabel}_not_captured`,
		text: "",
		json: null,
	};
};

export const createBetaLoopSmokeArtifactBundle = ({ dir, logFiles }) => {
	const agentIdFile = path.join(dir, "agent-id.txt");
	const claimCodeFile = path.join(dir, "claim-code.txt");
	const matchIdFile = path.join(dir, "match-id.txt");
	const featuredUrlFile = path.join(dir, "featured-url.txt");
	const finalFeaturedFile = path.join(dir, "final-featured.json");
	const finalLogFile = path.join(dir, "final-log.json");
	const finalStateFile = path.join(dir, "final-state.json");
	const summaryFile = path.join(dir, "summary.json");

	let agentId = null;
	let claimCode = null;
	let matchId = null;
	let featuredUrl = null;
	let finalFeatured = toArtifactSnapshot(null, "final_featured");
	let finalLog = toArtifactSnapshot(null, "final_log");
	let finalState = toArtifactSnapshot(null, "final_state");

	const flushText = (filePath, value) => {
		writeFileSync(filePath, value ? `${value}\n` : "", "utf8");
	};
	const flushJson = (filePath, value) => {
		writeJson(filePath, value);
	};

	flushText(agentIdFile, agentId);
	flushText(claimCodeFile, claimCode);
	flushText(matchIdFile, matchId);
	flushText(featuredUrlFile, featuredUrl);
	flushJson(finalFeaturedFile, finalFeatured);
	flushJson(finalLogFile, finalLog);
	flushJson(finalStateFile, finalState);

	return {
		setAgentId(value) {
			agentId = typeof value === "string" && value.trim() ? value.trim() : null;
			flushText(agentIdFile, agentId);
		},
		setClaimCode(value) {
			claimCode =
				typeof value === "string" && value.trim() ? value.trim() : null;
			flushText(claimCodeFile, claimCode);
		},
		setMatchId(value) {
			matchId = typeof value === "string" && value.trim() ? value.trim() : null;
			flushText(matchIdFile, matchId);
		},
		setFeaturedUrl(value) {
			featuredUrl =
				typeof value === "string" && value.trim() ? value.trim() : null;
			flushText(featuredUrlFile, featuredUrl);
		},
		setFinalFeaturedSnapshot(snapshot) {
			finalFeatured = toArtifactSnapshot(snapshot, "final_featured");
			flushJson(finalFeaturedFile, finalFeatured);
		},
		setFinalLogSnapshot(snapshot) {
			finalLog = toArtifactSnapshot(snapshot, "final_log");
			flushJson(finalLogFile, finalLog);
		},
		setFinalStateSnapshot(snapshot) {
			finalState = toArtifactSnapshot(snapshot, "final_state");
			flushJson(finalStateFile, finalState);
		},
		async persistFailureArtifacts(failureMessage) {
			flushText(agentIdFile, agentId);
			flushText(claimCodeFile, claimCode);
			flushText(matchIdFile, matchId);
			flushText(featuredUrlFile, featuredUrl);
			flushJson(finalFeaturedFile, finalFeatured);
			flushJson(finalLogFile, finalLog);
			flushJson(finalStateFile, finalState);
			const summary = {
				failureMessage,
				agentId,
				claimCode,
				matchId,
				featuredUrl,
				agentIdFile,
				claimCodeFile,
				matchIdFile,
				featuredUrlFile,
				finalFeaturedFile,
				finalLogFile,
				finalStateFile,
				logFiles,
				finalFeatured,
				finalLog,
				finalState,
			};
			writeJson(summaryFile, summary);
			return {
				agentId,
				claimCode,
				matchId,
				featuredUrl,
				agentIdFile,
				claimCodeFile,
				matchIdFile,
				featuredUrlFile,
				finalFeaturedFile,
				finalLogFile,
				finalStateFile,
				summaryFile,
			};
		},
	};
};

const killProcessGroup = (child, signal) => {
	if (!child?.pid) return;
	try {
		if (process.platform !== "win32") {
			process.kill(-child.pid, signal);
			return;
		}
	} catch {
		// fall through
	}
	try {
		child.kill(signal);
	} catch {
		// ignore cleanup failures
	}
};

const spawnLoggedProcess = (command, args, options) => {
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: {
			...process.env,
			...options.env,
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});

	let stdout = "";
	let stderr = "";
	let settled = false;
	let timedOut = false;
	let killTimer = null;
	let forceKillTimer = null;

	child.stdout?.on("data", (chunk) => {
		const text = chunk.toString();
		stdout += text;
		appendLog(options.stdoutFile, text);
		options.onStdoutText?.(text, stdout);
	});
	child.stderr?.on("data", (chunk) => {
		const text = chunk.toString();
		stderr += text;
		appendLog(options.stderrFile, text);
		options.onStderrText?.(text, stderr);
	});

	const result = new Promise((resolve, reject) => {
		if (options.timeoutMs > 0) {
			killTimer = setTimeout(() => {
				timedOut = true;
				killProcessGroup(child, "SIGTERM");
				forceKillTimer = setTimeout(() => {
					killProcessGroup(child, "SIGKILL");
				}, 1_000);
			}, options.timeoutMs);
		}

		child.on("error", (error) => {
			if (killTimer) clearTimeout(killTimer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			reject(error);
		});

		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			resolve({
				code,
				signal,
				timedOut,
				stdout,
				stderr,
			});
		});
	});

	return {
		child,
		result,
		getStdout: () => stdout,
		getStderr: () => stderr,
		stop: () => {
			killProcessGroup(child, "SIGTERM");
			setTimeout(() => {
				killProcessGroup(child, "SIGKILL");
			}, 1_000);
		},
	};
};

const runCheckedCommand = async (command, args, options) => {
	const proc = spawnLoggedProcess(command, args, options);
	const result = await proc.result;
	if (result.timedOut) {
		throw new Error(`${options.label} timed out.`);
	}
	if (result.code !== 0) {
		throw new Error(
			`${options.label} exited with code ${result.code ?? "unknown"}.`,
		);
	}
	return result;
};

const fetchJson = async (url, init) => {
	const res = await fetch(url, init);
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = null;
	}
	return { res, text, json };
};

const captureSnapshot = async (url, init, fallbackLabel) => {
	try {
		const { res, text, json } = await fetchJson(url, init);
		return {
			ok: res.ok,
			status: res.status,
			text,
			json,
		};
	} catch (error) {
		return {
			ok: false,
			status: null,
			error: error instanceof Error ? error.message : String(error),
			text: "",
			json: null,
			label: fallbackLabel,
		};
	}
};

const parseDbJson = (stdout) => {
	const parsed = JSON.parse(stdout);
	if (
		!Array.isArray(parsed) ||
		!parsed[0] ||
		!Array.isArray(parsed[0].results)
	) {
		throw new Error(`Unexpected D1 JSON output: ${stdout}`);
	}
	return parsed[0].results;
};

const isSqliteBusyError = (text) =>
	typeof text === "string" &&
	(text.includes("SQLITE_BUSY") || text.includes("database is locked"));

const queryLocalDbJson = async (persistDir, sql, logFiles) => {
	let lastFailure = "Unknown local D1 query failure.";
	for (let attempt = 1; attempt <= 8; attempt += 1) {
		const result = await spawnLoggedProcess(
			"pnpm",
			[
				"-C",
				"apps/server",
				"exec",
				"wrangler",
				"d1",
				"execute",
				"DB",
				"--local",
				"--persist-to",
				persistDir,
				"--json",
				"--command",
				sql,
			],
			{
				cwd: repoRoot,
				timeoutMs: 10_000,
				stdoutFile: logFiles.dbStdout,
				stderrFile: logFiles.dbStderr,
			},
		).result;
		if (result.code === 0) {
			return parseDbJson(result.stdout);
		}
		lastFailure = result.stderr || result.stdout || lastFailure;
		if (isSqliteBusyError(lastFailure) && attempt < 8) {
			await sleep(attempt * 150);
			continue;
		}
		throw new Error(`Local D1 query failed: ${lastFailure}`);
	}
	throw new Error(`Local D1 query failed: ${lastFailure}`);
};

const getLastPrefixedLineValue = (text, prefix) => {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (lines[index].startsWith(prefix)) {
			return lines[index].slice(prefix.length).trim();
		}
	}
	return null;
};

const hasLine = (text, value) => {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.includes(value);
};

export const buildOpenClawBetaTesterCommand = ({
	baseUrl,
	runnerKey,
	runnerId,
	name = "SmokeTester",
	gatewayCmd = DEFAULT_SMOKE_GATEWAY_CMD,
	moveTimeoutMs = 2000,
}) => {
	return {
		command: "pnpm",
		args: [
			"-C",
			"apps/openclaw-runner",
			"exec",
			"tsx",
			"src/cli.ts",
			"beta",
			"--baseUrl",
			baseUrl,
			"--name",
			name,
			"--runnerKey",
			runnerKey,
			"--runnerId",
			runnerId,
			"--strategyPreset",
			DEFAULT_SMOKE_PRESET_ID,
			"--gatewayCmd",
			gatewayCmd,
			"--moveTimeoutMs",
			String(moveTimeoutMs),
			"--verifyPollMs",
			"250",
		],
	};
};

export const buildOpenClawOperatorVerifyCommand = ({
	baseUrl,
	claimCode,
	adminKey,
}) => {
	return {
		command: "pnpm",
		args: [
			"-C",
			"apps/agent-cli",
			"exec",
			"tsx",
			"src/cli.ts",
			"verify",
			"--baseUrl",
			baseUrl,
			"--claimCode",
			claimCode,
			"--adminKey",
			adminKey,
		],
	};
};

export const buildOpenClawHouseOpponentCommand = ({
	baseUrl,
	adminKey,
	runnerKey,
	runnerId,
	name = "SmokeHouseOpponent",
	gatewayCmd = DEFAULT_SMOKE_GATEWAY_CMD,
	moveTimeoutMs = 2000,
}) => {
	return {
		command: "pnpm",
		args: [
			"-C",
			"apps/openclaw-runner",
			"exec",
			"tsx",
			"src/cli.ts",
			"house-opponent",
			"--baseUrl",
			baseUrl,
			"--adminKey",
			adminKey,
			"--runnerKey",
			runnerKey,
			"--runnerId",
			runnerId,
			"--name",
			name,
			"--strategyPreset",
			DEFAULT_SMOKE_PRESET_ID,
			"--gatewayCmd",
			gatewayCmd,
			"--moveTimeoutMs",
			String(moveTimeoutMs),
		],
	};
};

const main = async () => {
	const logFiles = createLogFiles();
	const persistDir = path.join(logFiles.dir, "wrangler-state");
	mkdirSync(persistDir, { recursive: true });
	const artifacts = createBetaLoopSmokeArtifactBundle({
		dir: logFiles.dir,
		logFiles,
	});

	await ensurePortAvailable(SERVER_PORT);
	await runCheckedCommand(
		"pnpm",
		[
			"-C",
			"apps/server",
			"exec",
			"wrangler",
			"d1",
			"migrations",
			"apply",
			"DB",
			"--local",
			"--persist-to",
			persistDir,
		],
		{
			cwd: repoRoot,
			timeoutMs: MIGRATION_TIMEOUT_MS,
			stdoutFile: logFiles.migrateStdout,
			stderrFile: logFiles.migrateStderr,
			label: "Local D1 migrations",
		},
	);

	const server = spawnLoggedProcess(
		"pnpm",
		[
			"-C",
			"apps/server",
			"exec",
			"wrangler",
			"dev",
			"--local",
			"--ip",
			"127.0.0.1",
			"--port",
			String(SERVER_PORT),
			"--persist-to",
			persistDir,
			"--log-level",
			"warn",
			"--show-interactive-dev-session=false",
			"--var",
			`ADMIN_KEY:${ADMIN_KEY}`,
			"--var",
			`INTERNAL_RUNNER_KEY:${RUNNER_KEY}`,
			"--var",
			`API_KEY_PEPPER:${API_KEY_PEPPER}`,
			"--var",
			`PROMPT_ENCRYPTION_KEY:${PROMPT_ENCRYPTION_KEY}`,
			"--var",
			"TEST_MODE:true",
		],
		{
			cwd: repoRoot,
			timeoutMs: 0,
			stdoutFile: logFiles.serverStdout,
			stderrFile: logFiles.serverStderr,
		},
	);

	let tester = null;
	let house = null;
	let success = false;
	let observedMatchId = null;
	let observedAgentId = null;
	let observedClaimCode = null;
	let observedFeaturedUrl = null;

	try {
		await waitForHealth();

		const testerCommand = buildOpenClawBetaTesterCommand({
			baseUrl: SERVER_BASE_URL,
			runnerKey: RUNNER_KEY,
			runnerId: TESTER_RUNNER_ID,
		});
		tester = spawnLoggedProcess(testerCommand.command, testerCommand.args, {
			cwd: repoRoot,
			timeoutMs: CLI_TIMEOUT_MS,
			stdoutFile: logFiles.testerStdout,
			stderrFile: logFiles.testerStderr,
		});

		const claimState = await waitForOrChildFailure({
			fn: async () => {
				const stdout = tester.getStdout();
				return {
					waiting: hasLine(stdout, "waiting for operator verification"),
					agentId: getLastPrefixedLineValue(stdout, "agentId:"),
					claimCode: getLastPrefixedLineValue(stdout, "claimCode:"),
				};
			},
			predicate: (value) =>
				value.waiting === true &&
				typeof value.agentId === "string" &&
				typeof value.claimCode === "string",
			timeoutMs: CLAIM_CODE_TIMEOUT_MS,
			label: "tester claim code",
			guards: [{ proc: tester, label: "Tester beta command" }],
		});
		observedAgentId = claimState.agentId;
		observedClaimCode = claimState.claimCode;
		artifacts.setAgentId(observedAgentId);
		artifacts.setClaimCode(observedClaimCode);

		const verifyCommand = buildOpenClawOperatorVerifyCommand({
			baseUrl: SERVER_BASE_URL,
			claimCode: observedClaimCode,
			adminKey: ADMIN_KEY,
		});
		await runCheckedCommand(verifyCommand.command, verifyCommand.args, {
			cwd: repoRoot,
			timeoutMs: VERIFY_TIMEOUT_MS,
			stdoutFile: logFiles.operatorStdout,
			stderrFile: logFiles.operatorStderr,
			label: "Operator verify command",
		});

		await waitForOrChildFailure({
			fn: async () => hasLine(tester.getStdout(), "verified"),
			predicate: (value) => value === true,
			timeoutMs: CLAIM_CODE_TIMEOUT_MS,
			label: "tester verification acknowledgement",
			guards: [{ proc: tester, label: "Tester beta command" }],
		});

		const houseCommand = buildOpenClawHouseOpponentCommand({
			baseUrl: SERVER_BASE_URL,
			adminKey: ADMIN_KEY,
			runnerKey: RUNNER_KEY,
			runnerId: HOUSE_RUNNER_ID,
		});
		house = spawnLoggedProcess(houseCommand.command, houseCommand.args, {
			cwd: repoRoot,
			timeoutMs: HOUSE_TIMEOUT_MS,
			stdoutFile: logFiles.houseStdout,
			stderrFile: logFiles.houseStderr,
		});

		const testerMatchInfo = await waitForOrChildFailure({
			fn: async () => {
				const stdout = tester.getStdout();
				return {
					matchId: getLastPrefixedLineValue(stdout, "matchId:"),
					matchUrl: getLastPrefixedLineValue(stdout, "match URL:"),
					homepageUrl: getLastPrefixedLineValue(stdout, "homepage URL:"),
				};
			},
			predicate: (value) =>
				typeof value.matchId === "string" &&
				typeof value.matchUrl === "string" &&
				typeof value.homepageUrl === "string",
			timeoutMs: MATCH_PROGRESS_TIMEOUT_MS,
			label: "tester match summary",
			guards: [
				{ proc: tester, label: "Tester beta command" },
				{ proc: house, label: "House opponent command" },
			],
		});
		observedMatchId = testerMatchInfo.matchId;
		observedFeaturedUrl = testerMatchInfo.matchUrl;
		artifacts.setMatchId(observedMatchId);
		artifacts.setFeaturedUrl(observedFeaturedUrl);

		await waitForOrChildFailure({
			fn: async () => {
				const { res, json } = await fetchJson(`${SERVER_BASE_URL}/v1/featured`);
				return {
					ok: res.ok,
					matchId:
						json && typeof json === "object" && typeof json.matchId === "string"
							? json.matchId
							: null,
				};
			},
			predicate: (value) =>
				value.ok === true && value.matchId === observedMatchId,
			timeoutMs: MATCH_PROGRESS_TIMEOUT_MS,
			label: "featured match id",
			intervalMs: 200,
			guards: [
				{ proc: tester, label: "Tester beta command" },
				{ proc: house, label: "House opponent command" },
			],
		});

		let endedNaturally = false;
		let finisherAgentId = observedAgentId;
		const endAt = Date.now() + NATURAL_END_TIMEOUT_MS;
		while (Date.now() < endAt) {
			const state = await fetchJson(
				`${SERVER_BASE_URL}/v1/matches/${observedMatchId}/state`,
			);
			const payload = state.json?.state ?? null;
			if (
				payload &&
				typeof payload === "object" &&
				payload.players &&
				typeof payload.players === "object" &&
				payload.players.A &&
				typeof payload.players.A === "object" &&
				typeof payload.players.A.id === "string"
			) {
				finisherAgentId = payload.players.A.id;
			}
			if (
				payload &&
				typeof payload === "object" &&
				typeof payload.status === "string" &&
				payload.status === "ended"
			) {
				endedNaturally = true;
				break;
			}
			await sleep(250);
		}

		if (!endedNaturally) {
			if (!finisherAgentId) {
				throw new Error("Could not determine a finisher agentId.");
			}
			const finish = await fetchJson(
				`${SERVER_BASE_URL}/v1/matches/${observedMatchId}/finish`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-admin-key": ADMIN_KEY,
						"x-agent-id": finisherAgentId,
					},
					body: JSON.stringify({ reason: "forfeit" }),
				},
			);
			if (!finish.res.ok) {
				throw new Error(
					`Failed to finish beta smoke match (${finish.res.status}): ${finish.text}`,
				);
			}
		}

		const testerFinalStatus = await waitForOrChildFailure({
			fn: async () =>
				getLastPrefixedLineValue(tester.getStdout(), "final status:"),
			predicate: (value) => typeof value === "string" && value.length > 0,
			timeoutMs: MATCH_PROGRESS_TIMEOUT_MS,
			label: "tester final status",
			guards: [
				{ proc: tester, label: "Tester beta command" },
				{ proc: house, label: "House opponent command" },
			],
		});

		const testerResult = await tester.result;
		if (testerResult.timedOut) {
			throw new Error("Tester beta command timed out.");
		}
		if (testerResult.code !== 0) {
			throw new Error(
				`Tester beta command exited with code ${testerResult.code ?? "unknown"}.`,
			);
		}

		const houseResult = await house.result;
		if (houseResult.timedOut) {
			throw new Error("House opponent command timed out.");
		}
		if (houseResult.code !== 0) {
			throw new Error(
				`House opponent command exited with code ${houseResult.code ?? "unknown"}.`,
			);
		}

		const finalFeatured = await captureSnapshot(
			`${SERVER_BASE_URL}/v1/featured`,
			undefined,
			"final_featured",
		);
		artifacts.setFinalFeaturedSnapshot(finalFeatured);

		const finalState = await captureSnapshot(
			`${SERVER_BASE_URL}/v1/matches/${observedMatchId}/state`,
			undefined,
			"final_state",
		);
		artifacts.setFinalStateSnapshot(finalState);

		const finalLog = await captureSnapshot(
			`${SERVER_BASE_URL}/v1/matches/${observedMatchId}/log?limit=5000`,
			{
				headers: {
					"x-admin-key": ADMIN_KEY,
				},
			},
			"final_log",
		);
		artifacts.setFinalLogSnapshot(finalLog);

		if (!finalState.ok) {
			throw new Error(`Failed to fetch final state (${finalState.status}).`);
		}
		if (!finalLog.ok) {
			throw new Error(`Failed to fetch final log (${finalLog.status}).`);
		}
		const events = Array.isArray(finalLog.json?.events)
			? finalLog.json.events
			: [];
		if (!events.some((event) => event?.event === "match_ended")) {
			throw new Error("Canonical log did not record match_ended.");
		}
		const stateVersion =
			finalState.json &&
			typeof finalState.json === "object" &&
			finalState.json.state &&
			typeof finalState.json.state === "object" &&
			typeof finalState.json.state.stateVersion === "number"
				? finalState.json.state.stateVersion
				: -1;
		if (stateVersion <= 0) {
			throw new Error("Final state never advanced beyond the initial version.");
		}

		const matchPlayers = await queryLocalDbJson(
			persistDir,
			[
				"select agent_id, seat",
				"from match_players",
				`where match_id = '${observedMatchId}'`,
				"order by seat asc",
			].join(" "),
			logFiles,
		);
		if (!Array.isArray(matchPlayers) || matchPlayers.length !== 2) {
			throw new Error("Expected exactly two persisted match players.");
		}

		console.log(
			JSON.stringify(
				{
					ok: true,
					agentId: observedAgentId,
					claimCode: observedClaimCode,
					matchId: observedMatchId,
					featuredUrl: observedFeaturedUrl,
					finalStatus: testerFinalStatus,
					presetId: DEFAULT_SMOKE_PRESET_ID,
					logDir: logFiles.dir,
				},
				null,
				2,
			),
		);
		success = true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (observedMatchId) {
			artifacts.setFinalFeaturedSnapshot(
				await captureSnapshot(
					`${SERVER_BASE_URL}/v1/featured`,
					undefined,
					"final_featured",
				),
			);
			artifacts.setFinalStateSnapshot(
				await captureSnapshot(
					`${SERVER_BASE_URL}/v1/matches/${observedMatchId}/state`,
					undefined,
					"final_state",
				),
			);
			artifacts.setFinalLogSnapshot(
				await captureSnapshot(
					`${SERVER_BASE_URL}/v1/matches/${observedMatchId}/log?limit=5000`,
					{
						headers: {
							"x-admin-key": ADMIN_KEY,
						},
					},
					"final_log",
				),
			);
		}
		const writtenArtifacts = await artifacts.persistFailureArtifacts(message);
		console.error(message);
		if (writtenArtifacts.agentId) {
			console.error(`Resolved agentId: ${writtenArtifacts.agentId}`);
		}
		if (writtenArtifacts.claimCode) {
			console.error(`Resolved claimCode: ${writtenArtifacts.claimCode}`);
		}
		if (writtenArtifacts.matchId) {
			console.error(`Resolved matchId: ${writtenArtifacts.matchId}`);
		}
		if (writtenArtifacts.featuredUrl) {
			console.error(`Featured URL: ${writtenArtifacts.featuredUrl}`);
		}
		console.error(`Artifact summary: ${writtenArtifacts.summaryFile}`);
		console.error(`Migration stdout: ${logFiles.migrateStdout}`);
		console.error(`Migration stderr: ${logFiles.migrateStderr}`);
		console.error(`DB stdout: ${logFiles.dbStdout}`);
		console.error(`DB stderr: ${logFiles.dbStderr}`);
		console.error(`Server stdout: ${logFiles.serverStdout}`);
		console.error(`Server stderr: ${logFiles.serverStderr}`);
		console.error(`Tester stdout: ${logFiles.testerStdout}`);
		console.error(`Tester stderr: ${logFiles.testerStderr}`);
		console.error(`Operator stdout: ${logFiles.operatorStdout}`);
		console.error(`Operator stderr: ${logFiles.operatorStderr}`);
		console.error(`House stdout: ${logFiles.houseStdout}`);
		console.error(`House stderr: ${logFiles.houseStderr}`);
		process.exitCode = 1;
	} finally {
		if (tester) tester.stop();
		if (house) house.stop();
		server.stop();
		await sleep(500);
		if (success && process.env.SMOKE_KEEP_LOGS !== "1") {
			rmSync(logFiles.dir, { recursive: true, force: true });
		}
	}
};

const isDirectRun =
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
	await main();
}
