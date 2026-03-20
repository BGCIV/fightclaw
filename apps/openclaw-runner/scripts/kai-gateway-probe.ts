import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
	applyMove,
	createInitialState,
	listLegalMoves,
	type MatchState,
	type Move,
} from "@fightclaw/engine";
import {
	type KaiGatewayProbeInput,
	type KaiGatewayProbeProviderResult,
	probeKaiGatewayOutcome,
} from "../src/kaiGatewayProbe";
import { buildPrompt, resolveOpenClawBin } from "./gateway-openclaw-agent";

export type KaiGatewayFixtureRecipe = {
	name?: string;
	agentId: string;
	agentName: string;
	matchId: string;
	seed: number;
	players: [string, string];
	history: Move[];
	stateVersion?: number;
	turnActionIndex?: number;
	remainingActionBudget?: number;
	previousActionsThisTurn?: unknown;
	finishOverlay?: boolean;
	strategyDirective?: string;
	expectations?: {
		attackAvailable?: boolean;
	};
};

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const RUNNER_ROOT = resolvePath(SCRIPT_DIR, "..");
const DEFAULT_FIXTURE_DIR = resolvePath(
	RUNNER_ROOT,
	"test/fixtures/kai-gateway",
);
const FIXTURE_ORDER = ["opening", "follow-up", "attack-pressure"] as const;

const fixtureRank = (name: string) => {
	const index = FIXTURE_ORDER.indexOf(name as (typeof FIXTURE_ORDER)[number]);
	return index >= 0 ? index : FIXTURE_ORDER.length;
};

const toRecipeName = (filename: string) => basename(filename, ".json");

const readJson = async <T>(path: string): Promise<T> =>
	JSON.parse(await readFile(path, "utf8")) as T;

export const loadKaiGatewayFixtures = async (
	fixtureDir = DEFAULT_FIXTURE_DIR,
): Promise<KaiGatewayFixtureRecipe[]> => {
	const entries = (await readdir(fixtureDir))
		.filter((entry) => entry.endsWith(".json"))
		.sort((left, right) => {
			const leftName = toRecipeName(left);
			const rightName = toRecipeName(right);
			return (
				fixtureRank(leftName) - fixtureRank(rightName) ||
				leftName.localeCompare(rightName)
			);
		});

	return await Promise.all(
		entries.map(async (entry) => {
			const path = resolvePath(fixtureDir, entry);
			const recipe = await readJson<KaiGatewayFixtureRecipe>(path);
			return {
				...recipe,
				name: recipe.name ?? toRecipeName(entry),
			};
		}),
	);
};

export const materializeKaiGatewayFixtureInput = (
	fixture: KaiGatewayFixtureRecipe,
): KaiGatewayProbeInput & { state: MatchState } => {
	let state = createInitialState(fixture.seed, undefined, [...fixture.players]);

	for (const move of fixture.history) {
		const applied = applyMove(state, move);
		if (!applied.ok) {
			throw new Error(
				`Fixture "${fixture.name ?? fixture.matchId}" contains illegal history move: ${JSON.stringify(move)} (${applied.error})`,
			);
		}
		state = applied.state;
	}

	return {
		agentId: fixture.agentId,
		agentName: fixture.agentName,
		matchId: fixture.matchId,
		stateVersion: fixture.stateVersion ?? fixture.history.length + 1,
		state,
		turnActionIndex: fixture.turnActionIndex ?? 1,
		remainingActionBudget: fixture.remainingActionBudget ?? 3,
		previousActionsThisTurn: fixture.previousActionsThisTurn ?? [],
		finishOverlay: fixture.finishOverlay === true,
		strategyDirective: fixture.strategyDirective,
	};
};

const callOpenClawProvider = async (
	input: KaiGatewayProbeInput,
): Promise<KaiGatewayProbeProviderResult> => {
	return await new Promise((resolve, reject) => {
		const agentSelector = process.env.OPENCLAW_AGENT_ID?.trim();
		if (!agentSelector) {
			reject(new Error("OPENCLAW_AGENT_ID is required for the Kai probe."));
			return;
		}

		const timeoutSecondsRaw = Number.parseInt(
			process.env.OPENCLAW_TIMEOUT_SECONDS ?? "30",
			10,
		);
		const timeoutSeconds =
			Number.isFinite(timeoutSecondsRaw) && timeoutSecondsRaw > 0
				? timeoutSecondsRaw
				: 30;
		const processTimeoutMsRaw = Number.parseInt(
			process.env.KAI_GATEWAY_PROBE_PROCESS_TIMEOUT_MS ??
				String((timeoutSeconds + 5) * 1000),
			10,
		);
		const processTimeoutMs =
			Number.isFinite(processTimeoutMsRaw) && processTimeoutMsRaw > 0
				? processTimeoutMsRaw
				: (timeoutSeconds + 5) * 1000;
		const legalMoves = listLegalMoves(input.state);
		const message = buildPrompt({
			agentId: input.agentId,
			agentName: input.agentName,
			matchId: input.matchId,
			stateVersion: input.stateVersion,
			state: input.state,
			legalMoves,
			turnActionIndex: input.turnActionIndex,
			remainingActionBudget: input.remainingActionBudget,
			previousActionsThisTurn: input.previousActionsThisTurn,
			finishOverlay: input.finishOverlay,
			strategyDirective:
				typeof input.strategyDirective === "string"
					? input.strategyDirective
					: undefined,
		});
		const child = spawn(
			resolveOpenClawBin(),
			[
				"agent",
				"--agent",
				agentSelector,
				"--json",
				"--timeout",
				String(timeoutSeconds),
				"--message",
				message,
			],
			{
				cwd: RUNNER_ROOT,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(killTimer);
			fn();
		};
		const killTimer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(() => {
				reject(
					new Error(
						`openclaw agent timed out after ${String(processTimeoutMs)}ms while probing fixture input.`,
					),
				);
			});
		}, processTimeoutMs);

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			finish(() => reject(error));
		});
		child.on("exit", (code) => {
			finish(() => {
				if (code !== 0) {
					reject(
						new Error(
							`openclaw agent failed (${String(code)}): ${
								stderr.trim() || stdout.trim() || "No output."
							}`,
						),
					);
					return;
				}
				resolve({ rawGatewayOutput: stdout.trim() });
			});
		});
	});
};

export const runKaiGatewayFixtureProbe = async (
	fixture: KaiGatewayFixtureRecipe,
	provider: (
		input: KaiGatewayProbeInput,
	) => Promise<KaiGatewayProbeProviderResult> = callOpenClawProvider,
) => {
	const input = materializeKaiGatewayFixtureInput(fixture);
	const legalMoves = listLegalMoves(input.state);
	const report = await probeKaiGatewayOutcome(input, provider);
	return {
		fixture: fixture.name ?? fixture.matchId,
		attackAvailable: legalMoves.some((move) => move.action === "attack"),
		legalMoveCount: legalMoves.length,
		report,
	};
};

const parseFixtureArgs = (argv: string[]) => {
	const selected = new Set<string>();
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg !== "--fixture") continue;
		const next = argv[index + 1];
		if (!next) {
			throw new Error("--fixture requires a value.");
		}
		selected.add(next);
		index += 1;
	}
	return selected;
};

const main = async () => {
	const requested = parseFixtureArgs(process.argv.slice(2));
	const fixtures = await loadKaiGatewayFixtures();
	const selected =
		requested.size === 0
			? fixtures
			: fixtures.filter((fixture) =>
					requested.has(fixture.name ?? fixture.matchId),
				);

	if (selected.length === 0) {
		throw new Error("No matching Kai gateway fixtures were found.");
	}

	const results = [];
	for (const fixture of selected) {
		results.push(await runKaiGatewayFixtureProbe(fixture));
	}

	process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
};

const isMainModule =
	typeof process.argv[1] === "string" &&
	import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href;

if (isMainModule) {
	void main();
}
