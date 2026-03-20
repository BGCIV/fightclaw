import { playMatchBoardgameIO } from "./boardgameio/runner";
import type {
	InvalidPolicy,
	MoveValidationMode,
	ScenarioName,
} from "./boardgameio/types";
import { Engine } from "./engineAdapter";
import type { Bot, EngineEvent, MatchLog, MatchResult } from "./types";

export async function playMatch(opts: {
	seed: number;
	players: Bot[]; // turn order
	maxTurns: number;
	verbose?: boolean;
	record?: boolean;
	autofixIllegal?: boolean;
	enableDiagnostics?: boolean;
	engineConfig?: import("./types").EngineConfigInput;
	scenario?: ScenarioName;
	invalidPolicy?: InvalidPolicy;
	strict?: boolean;
	moveValidationMode?: MoveValidationMode;
	artifactDir?: string;
	storeFullPrompt?: boolean;
	storeFullOutput?: boolean;
}): Promise<MatchResult> {
	return playMatchBoardgameIO({
		seed: opts.seed,
		players: opts.players,
		maxTurns: opts.maxTurns,
		verbose: opts.verbose,
		record: opts.record,
		enableDiagnostics: opts.enableDiagnostics,
		engineConfig: opts.engineConfig,
		scenario: opts.scenario,
		invalidPolicy: opts.invalidPolicy ?? "skip",
		strict: opts.strict ?? process.env.HARNESS_STRICT === "1",
		moveValidationMode: opts.moveValidationMode ?? "strict",
		artifactDir: opts.artifactDir,
		storeFullPrompt: opts.storeFullPrompt ?? process.env.CI !== "true",
		storeFullOutput: opts.storeFullOutput ?? process.env.CI !== "true",
	});
}

export function replayMatch(log: MatchLog): {
	ok: boolean;
	mismatchAt?: number;
	error?: string;
} {
	let state = Engine.createInitialState(log.seed, log.players);
	const events: EngineEvent[] = [];

	for (let i = 0; i < log.moves.length; i++) {
		const result = Engine.applyMove(state, log.moves[i]);
		events.push(...result.engineEvents);
		if (result.ok) {
			state = result.state;
		}
	}

	if (log.engineEvents && safeJson(events) !== safeJson(log.engineEvents)) {
		const mismatchAt = firstMismatchIndex(events, log.engineEvents);
		return { ok: false, mismatchAt, error: "Engine events mismatch." };
	}

	if (log.finalState && safeJson(state) !== safeJson(log.finalState)) {
		return { ok: false, error: "Final state mismatch." };
	}

	return { ok: true };
}

function safeJson(x: unknown): string {
	try {
		return JSON.stringify(x);
	} catch {
		return String(x);
	}
}

function firstMismatchIndex(a: unknown[], b: unknown[]): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		if (safeJson(a[i]) !== safeJson(b[i])) return i;
	}
	return len;
}
