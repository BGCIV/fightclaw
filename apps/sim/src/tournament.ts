import type {
	HarnessMode,
	InvalidPolicy,
	MoveValidationMode,
	ScenarioName,
} from "./boardgameio/types";
import { playMatch } from "./match";
import type { Bot, EngineConfigInput } from "./types";

/**
 * Run a series of matches between two bots and return a tournament summary with all match results.
 *
 * Runs `opts.games` matches using the provided seed and options, collects each match result, and
 * computes aggregate statistics (win counts, draws, average turns, and illegal move rate).
 *
 * @param opts - Tournament options
 * @param opts.games - Number of matches to run
 * @param opts.seed - Numeric seed used as the base for per-match seeds
 * @param opts.maxTurns - Maximum turns allowed per match
 * @param opts.players - Tuple of two bots participating in each match
 * @param opts.autofixIllegal - If true, attempt to auto-correct illegal moves
 * @param opts.engineConfig - Optional engine configuration passed to each match
 * @param opts.scenario - Optional scenario name to run
 * @param opts.harness - Optional harness mode for match execution
 * @param opts.invalidPolicy - Policy for handling invalid moves
 * @param opts.moveValidationMode - Mode for move validation
 * @param opts.strict - If true, enable strict mode in the engine
 * @param opts.artifactDir - Directory path to store match artifacts
 * @param opts.storeFullPrompt - If true, store full prompts produced during matches
 * @param opts.storeFullOutput - If true, store full outputs produced during matches
 * @returns An object containing:
 *  - `summary`: aggregate tournament statistics (`games`, `seed`, `maxTurns`, `wins`, `draws`, `avgTurns`, `illegalMoveRate`)
 *  - `results`: array of individual match results
 */
export async function runTournament(opts: {
	games: number;
	seed: number;
	maxTurns: number;
	players: [Bot, Bot];
	autofixIllegal?: boolean;
	engineConfig?: EngineConfigInput;
	scenario?: ScenarioName;
	harness?: HarnessMode;
	invalidPolicy?: InvalidPolicy;
	moveValidationMode?: MoveValidationMode;
	strict?: boolean;
	artifactDir?: string;
	storeFullPrompt?: boolean;
	storeFullOutput?: boolean;
}) {
	const results = [];
	for (let i = 0; i < opts.games; i++) {
		const matchSeed = (opts.seed + i) >>> 0;
		const r = await playMatch({
			seed: matchSeed,
			players: opts.players,
			maxTurns: opts.maxTurns,
			verbose: false,
			autofixIllegal: opts.autofixIllegal,
			engineConfig: opts.engineConfig,
			scenario: opts.scenario,
			harness: opts.harness,
			invalidPolicy: opts.invalidPolicy,
			moveValidationMode: opts.moveValidationMode,
			strict: opts.strict,
			artifactDir: opts.artifactDir,
			storeFullPrompt: opts.storeFullPrompt,
			storeFullOutput: opts.storeFullOutput,
		});
		results.push(r);
	}

	const wins: Record<string, number> = {};
	let draws = 0;
	let totalTurns = 0;
	let totalIllegal = 0;

	for (const r of results) {
		totalTurns += r.turns;
		totalIllegal += r.illegalMoves;
		if (r.winner == null) draws++;
		else wins[r.winner] = (wins[r.winner] ?? 0) + 1;
	}

	const summary = {
		games: opts.games,
		seed: opts.seed,
		maxTurns: opts.maxTurns,
		wins,
		draws,
		avgTurns: Number((totalTurns / opts.games).toFixed(2)),
		illegalMoveRate: Number(
			(totalIllegal / Math.max(1, totalTurns)).toFixed(4),
		),
	};

	return { summary, results };
}