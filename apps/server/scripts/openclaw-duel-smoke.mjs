import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSmokeArtifactBundle } from "./openclaw-duel-smoke-artifacts.mjs";
import {
	buildOpenClawDuelCommand,
	DEFAULT_SMOKE_PRESET_ID,
} from "./openclaw-duel-smoke-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

const SERVER_PORT = 3041;
const SERVER_BASE_URL = `http://127.0.0.1:${SERVER_PORT}`;
const ADMIN_KEY = "smoke-admin";
const RUNNER_KEY = "smoke-runner-key";
const RUNNER_ID = "smoke-runner";
const API_KEY_PEPPER = "smoke-pepper";
const PROMPT_ENCRYPTION_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const SERVER_START_TIMEOUT_MS = 30_000;
const MATCH_PROGRESS_TIMEOUT_MS = 20_000;
const CLI_TIMEOUT_MS = 25_000;
const MIGRATION_TIMEOUT_MS = 30_000;
const NATURAL_END_TIMEOUT_MS = 15_000;

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
	const dir = mkdtempSync(path.join(tmpdir(), "fightclaw-openclaw-smoke-"));
	const files = {
		dir,
		migrateStdout: path.join(dir, "migrate.stdout.log"),
		migrateStderr: path.join(dir, "migrate.stderr.log"),
		dbStdout: path.join(dir, "db.stdout.log"),
		dbStderr: path.join(dir, "db.stderr.log"),
		serverStdout: path.join(dir, "server.stdout.log"),
		serverStderr: path.join(dir, "server.stderr.log"),
		cliStdout: path.join(dir, "cli.stdout.log"),
		cliStderr: path.join(dir, "cli.stderr.log"),
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

const killProcessGroup = (child, signal) => {
	if (!child?.pid) return;
	try {
		if (process.platform !== "win32") {
			process.kill(-child.pid, signal);
			return;
		}
	} catch {
		// fall back to direct child kill below
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
	});
	child.stderr?.on("data", (chunk) => {
		const text = chunk.toString();
		stderr += text;
		appendLog(options.stderrFile, text);
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
		stop: () => {
			killProcessGroup(child, "SIGTERM");
			setTimeout(() => {
				killProcessGroup(child, "SIGKILL");
			}, 1_000);
		},
	};
};

const parseCliJson = (stdout) => {
	const trimmed = stdout.trim();
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start === -1 || end === -1 || end < start) {
		throw new Error(`Missing JSON payload in CLI stdout:\n${stdout}`);
	}
	return JSON.parse(trimmed.slice(start, end + 1));
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

const main = async () => {
	const logFiles = createLogFiles();
	const persistDir = path.join(logFiles.dir, "wrangler-state");
	mkdirSync(persistDir, { recursive: true });
	const artifacts = createSmokeArtifactBundle({
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

	let cli = null;
	let success = false;
	let observedMatchId = null;

	try {
		await waitForHealth();
		const duelCommand = buildOpenClawDuelCommand({
			baseUrl: SERVER_BASE_URL,
			adminKey: ADMIN_KEY,
			runnerKey: RUNNER_KEY,
			runnerId: RUNNER_ID,
			moveTimeoutMs: 2000,
		});

		cli = spawnLoggedProcess(duelCommand.command, duelCommand.args, {
			cwd: repoRoot,
			timeoutMs: CLI_TIMEOUT_MS,
			stdoutFile: logFiles.cliStdout,
			stderrFile: logFiles.cliStderr,
		});

		const livePayload = await waitFor(
			async () => {
				const { res, json } = await fetchJson(`${SERVER_BASE_URL}/v1/live`);
				return {
					ok: res.ok,
					matchId:
						json && typeof json === "object" && typeof json.matchId === "string"
							? json.matchId
							: null,
					agentIds:
						json &&
						typeof json === "object" &&
						json.state &&
						typeof json.state === "object" &&
						json.state.players &&
						typeof json.state.players === "object" &&
						json.state.players.A &&
						typeof json.state.players.A === "object" &&
						typeof json.state.players.A.id === "string" &&
						json.state.players.B &&
						typeof json.state.players.B === "object" &&
						typeof json.state.players.B.id === "string"
							? [json.state.players.A.id, json.state.players.B.id]
							: [],
				};
			},
			(value) => value.ok === true && typeof value.matchId === "string",
			MATCH_PROGRESS_TIMEOUT_MS,
			"live match id",
		);
		observedMatchId = livePayload.matchId;
		artifacts.setMatchId(observedMatchId);
		const persistedPlayers = await waitFor(
			async () => {
				try {
					const rows = await queryLocalDbJson(
						persistDir,
						[
							"select agent_id, seat",
							"from match_players",
							`where match_id = '${observedMatchId}'`,
							"order by seat asc",
						].join(" "),
						logFiles,
					);
					return {
						agentIds: rows
							.map((row) =>
								row && typeof row.agent_id === "string" ? row.agent_id : null,
							)
							.filter((value) => typeof value === "string"),
					};
				} catch {
					return { agentIds: [] };
				}
			},
			(value) => Array.isArray(value.agentIds) && value.agentIds.length === 2,
			MATCH_PROGRESS_TIMEOUT_MS,
			"persisted match players",
			250,
		);

		const progressPayload = await waitFor(
			async () => {
				const state = await fetchJson(
					`${SERVER_BASE_URL}/v1/matches/${observedMatchId}/state`,
				);
				const log = await fetchJson(
					`${SERVER_BASE_URL}/v1/matches/${observedMatchId}/log?limit=200`,
				);
				const stateVersion =
					state.json &&
					typeof state.json === "object" &&
					state.json.state &&
					typeof state.json.state === "object" &&
					typeof state.json.state.stateVersion === "number"
						? state.json.state.stateVersion
						: -1;
				const stateStatus =
					state.json &&
					typeof state.json === "object" &&
					state.json.state &&
					typeof state.json.state === "object" &&
					typeof state.json.state.status === "string"
						? state.json.state.status
						: null;
				const agentIds =
					state.json &&
					typeof state.json === "object" &&
					state.json.state &&
					typeof state.json.state === "object" &&
					state.json.state.players &&
					typeof state.json.state.players === "object" &&
					state.json.state.players.A &&
					typeof state.json.state.players.A === "object" &&
					typeof state.json.state.players.A.id === "string" &&
					state.json.state.players.B &&
					typeof state.json.state.players.B === "object" &&
					typeof state.json.state.players.B.id === "string"
						? [state.json.state.players.A.id, state.json.state.players.B.id]
						: [];
				const events =
					log.json &&
					typeof log.json === "object" &&
					Array.isArray(log.json.events)
						? log.json.events
						: [];
				return {
					stateStatus,
					stateVersion,
					agentIds,
					hasEngineEvents: events.some(
						(event) => event?.event === "engine_events",
					),
				};
			},
			(value) => value.stateVersion > 0 || value.hasEngineEvents === true,
			MATCH_PROGRESS_TIMEOUT_MS,
			"match progress",
		);

		if (progressPayload.stateStatus !== "ended") {
			let finisherAgentId =
				typeof persistedPlayers.agentIds?.[0] === "string"
					? persistedPlayers.agentIds[0]
					: typeof livePayload.agentIds?.[0] === "string"
						? livePayload.agentIds[0]
						: typeof progressPayload.agentIds?.[0] === "string"
							? progressPayload.agentIds[0]
							: null;
			let endedNaturally = false;
			const naturalEndDeadline = Date.now() + NATURAL_END_TIMEOUT_MS;

			while (Date.now() < naturalEndDeadline) {
				const { json } = await fetchJson(
					`${SERVER_BASE_URL}/v1/matches/${observedMatchId}/state`,
				);
				const state = json?.state ?? null;
				if (
					state &&
					typeof state === "object" &&
					state.players &&
					typeof state.players === "object" &&
					state.players.A &&
					typeof state.players.A === "object" &&
					typeof state.players.A.id === "string"
				) {
					finisherAgentId = state.players.A.id;
				}
				if (
					state &&
					typeof state === "object" &&
					typeof state.status === "string" &&
					state.status === "ended"
				) {
					endedNaturally = true;
					break;
				}
				await sleep(250);
			}

			if (!endedNaturally) {
				if (!finisherAgentId) {
					throw new Error(
						"Could not determine a real player agentId for finish.",
					);
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
						`Failed to finish smoke match (${finish.res.status}): ${finish.text}`,
					);
				}
			}
		}

		const cliResult = await cli.result;
		if (cliResult.timedOut) {
			throw new Error("OpenClaw duel CLI timed out.");
		}
		if (cliResult.code !== 0) {
			throw new Error(
				`OpenClaw duel CLI exited with code ${cliResult.code ?? "unknown"}.`,
			);
		}

		const parsed = parseCliJson(cliResult.stdout);
		if (parsed.matchId !== observedMatchId) {
			throw new Error(
				`CLI reported matchId ${parsed.matchId} but live server observed ${observedMatchId}.`,
			);
		}
		if (!Array.isArray(parsed.results) || parsed.results.length !== 2) {
			throw new Error("CLI did not report two runner results.");
		}
		if (!parsed.results.every((entry) => entry.transport === "sse")) {
			throw new Error("CLI reported a non-SSE transport.");
		}

		const finalState = await fetchJson(
			`${SERVER_BASE_URL}/v1/matches/${observedMatchId}/state`,
		);
		artifacts.setFinalStateSnapshot({
			ok: finalState.res.ok,
			status: finalState.res.status,
			text: finalState.text,
			json: finalState.json,
		});
		if (!finalState.res.ok) {
			throw new Error(
				`Failed to fetch final state (${finalState.res.status}): ${finalState.text}`,
			);
		}
		if (finalState.json?.state?.status !== "ended") {
			throw new Error(
				`Expected ended state, received: ${JSON.stringify(finalState.json)}`,
			);
		}

		const replay = await fetchJson(
			`${SERVER_BASE_URL}/v1/matches/${observedMatchId}/log?limit=200`,
		);
		artifacts.setFinalLogSnapshot({
			ok: replay.res.ok,
			status: replay.res.status,
			text: replay.text,
			json: replay.json,
		});
		if (!replay.res.ok) {
			throw new Error(
				`Failed to fetch canonical log (${replay.res.status}): ${replay.text}`,
			);
		}
		const events = Array.isArray(replay.json?.events) ? replay.json.events : [];
		if (!events.some((event) => event?.event === "engine_events")) {
			throw new Error("Canonical log did not record any engine_events.");
		}
		if (!events.some((event) => event?.event === "match_ended")) {
			throw new Error("Canonical log did not record match_ended.");
		}
		if (
			progressPayload.stateVersion <= 0 &&
			progressPayload.hasEngineEvents !== true
		) {
			throw new Error("Match never advanced beyond the initial state.");
		}

		console.log(
			JSON.stringify(
				{
					ok: true,
					matchId: observedMatchId,
					presetId: DEFAULT_SMOKE_PRESET_ID,
					stateVersion: finalState.json?.state?.stateVersion ?? null,
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
			artifacts.setFinalStateSnapshot(
				await captureSnapshot(
					`${SERVER_BASE_URL}/v1/matches/${observedMatchId}/state`,
					undefined,
					"final_state",
				),
			);
			artifacts.setFinalLogSnapshot(
				await captureSnapshot(
					`${SERVER_BASE_URL}/v1/matches/${observedMatchId}/log?limit=200`,
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
		if (writtenArtifacts.matchId) {
			console.error(`Resolved matchId: ${writtenArtifacts.matchId}`);
		}
		console.error(`Artifact summary: ${writtenArtifacts.summaryFile}`);
		console.error(`Migration stdout: ${logFiles.migrateStdout}`);
		console.error(`Migration stderr: ${logFiles.migrateStderr}`);
		console.error(`DB stdout: ${logFiles.dbStdout}`);
		console.error(`DB stderr: ${logFiles.dbStderr}`);
		console.error(`Server stdout: ${logFiles.serverStdout}`);
		console.error(`Server stderr: ${logFiles.serverStderr}`);
		console.error(`CLI stdout: ${logFiles.cliStdout}`);
		console.error(`CLI stderr: ${logFiles.cliStderr}`);
		process.exitCode = 1;
	} finally {
		if (cli) cli.stop();
		server.stop();
		await sleep(500);
		if (success) {
			rmSync(logFiles.dir, { recursive: true, force: true });
		}
	}
};

await main();
