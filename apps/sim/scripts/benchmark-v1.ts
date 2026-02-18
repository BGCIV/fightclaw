import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";

type Scenario = "midfield" | "melee" | "all_infantry" | "all_cavalry";
type Strategy = "strategic" | "defensive" | "aggressive";

interface Matchup {
	scenario: Scenario;
	bot1: Strategy;
	bot2: Strategy;
	seed: number;
}

interface Aggregate {
	games: number;
	draws: number;
	illegalMoves: number;
	avgTurns: number;
	byScenario: Record<
		string,
		{ games: number; draws: number; avgTurns: number }
	>;
}

interface RunPolicy {
	timeoutMs?: number;
	retries?: number;
	continueOnError?: boolean;
}

const scenarios: Scenario[] = [
	"midfield",
	"melee",
	"all_infantry",
	"all_cavalry",
];

const mirroredPairs: Array<[Strategy, Strategy]> = [
	["strategic", "defensive"],
	["defensive", "strategic"],
	["strategic", "aggressive"],
	["aggressive", "strategic"],
	["aggressive", "defensive"],
	["defensive", "aggressive"],
	["defensive", "defensive"],
];

/**
 * Retrieves the value immediately following a given command-line flag.
 *
 * @param name - The flag name to search for (e.g. "--flag")
 * @returns The argument following `name` if present, `undefined` otherwise.
 */
function parseArg(name: string): string | undefined {
	const idx = process.argv.indexOf(name);
	if (idx < 0) return undefined;
	return process.argv[idx + 1];
}

/**
 * Checks whether a command-line flag is present in process.argv.
 *
 * @param name - The exact flag string to look for (e.g. `--skipFastLane` or `-v`)
 * @returns `true` if the flag appears in the current process arguments, `false` otherwise.
 */
function hasFlag(name: string): boolean {
	return process.argv.includes(name);
}

/**
 * Parse a boolean-like command-line argument value.
 *
 * @param name - The argument flag name to read (as passed to `parseArg`)
 * @param fallback - Value to return when the argument is missing or unrecognized
 * @returns `true` for values `"true"`, `"1"`, or `"yes"`; `false` for values `"false"`, `"0"`, or `"no"`; otherwise `fallback`
 */
function parseBoolArg(name: string, fallback: boolean): boolean {
	const value = parseArg(name);
	if (value === undefined) return fallback;
	const normalized = value.toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") {
		return true;
	}
	if (normalized === "false" || normalized === "0" || normalized === "no") {
		return false;
	}
	return fallback;
}

/**
 * Execute a `pnpm` command in a specified working directory with optional timeout and retry behavior.
 *
 * @param cwd - The working directory in which to run `pnpm`.
 * @param args - The argument list to pass to `pnpm` (e.g., `["run", "build"]`).
 * @param dryRun - If `true`, the command is not executed and the function returns `true`.
 * @param policy - Optional execution policy:
 *   - `timeoutMs`: maximum milliseconds to allow the command to run before killing it,
 *   - `retries`: number of additional attempts on failure,
 *   - `continueOnError`: if `true`, return `false` instead of throwing when all attempts fail.
 * @returns `true` if the command ran successfully or if `dryRun` is `true`; `false` if all attempts failed and `policy.continueOnError` is `true`.
 * @throws Re-throws the underlying error if the command fails after all retries and `policy.continueOnError` is not set.
 */
function runCmd(
	cwd: string,
	args: string[],
	dryRun: boolean,
	policy?: RunPolicy,
): boolean {
	const pretty = `pnpm ${args.join(" ")}`;
	console.log(pretty);
	if (dryRun) return true;

	const retries = Math.max(0, policy?.retries ?? 0);
	const timeoutMs = policy?.timeoutMs;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			execFileSync("pnpm", args, {
				cwd,
				stdio: "inherit",
				timeout: timeoutMs,
				killSignal: "SIGKILL",
			});
			return true;
		} catch (error) {
			const lastAttempt = attempt >= retries;
			const msg = error instanceof Error ? error.message : String(error);
			console.warn(
				`Command failed (attempt ${attempt + 1}/${retries + 1}): ${msg}`,
			);
			if (lastAttempt) {
				if (policy?.continueOnError) return false;
				throw error;
			}
		}
	}
	return false;
}

/**
 * Generate all scenario/strategy matchups and assign sequential seeds starting from `baseSeed`.
 *
 * Each combination of `scenarios` and `mirroredPairs` becomes a Matchup; seeds increment by 1 for each matchup.
 *
 * @param baseSeed - The starting seed value used for the first generated matchup
 * @returns An array of Matchup objects covering every scenario paired with each mirrored strategy pair, each with a unique sequential seed
 */
function collectMatchups(baseSeed: number): Matchup[] {
	const out: Matchup[] = [];
	let seed = baseSeed;
	for (const scenario of scenarios) {
		for (const [bot1, bot2] of mirroredPairs) {
			out.push({ scenario, bot1, bot2, seed });
			seed += 1;
		}
	}
	return out;
}

/**
 * Builds an aggregated summary of game results by reading per-lane `summary.json` files under a directory.
 *
 * Reads every subdirectory of `laneDir` and, for each readable `summary.json`, accumulates total games, draws,
 * illegal moves, and weighted average match lengths; also computes per-scenario aggregates where the scenario name
 * is taken from the subdirectory name prefix before `__`.
 *
 * Malformed or missing `summary.json` files are ignored. If `laneDir` does not exist, returns an aggregate with all
 * counts and averages set to zero.
 *
 * @param laneDir - Path to a directory containing lane subdirectories each optionally holding a `summary.json`
 *                  with `totalGames`, `draws`, `totalIllegalMoves`, and `matchLengths.mean`.
 * @returns An Aggregate object with overall totals (`games`, `draws`, `illegalMoves`, `avgTurns`) and a `byScenario`
 *          map where each entry contains `games`, `draws`, and `avgTurns` for that scenario.
 */
function aggregateSummaries(laneDir: string): Aggregate {
	const aggregate: Aggregate = {
		games: 0,
		draws: 0,
		illegalMoves: 0,
		avgTurns: 0,
		byScenario: {},
	};
	let weightedTurns = 0;
	if (!existsSync(laneDir)) {
		return aggregate;
	}

	for (const entry of readdirSync(laneDir)) {
		const summaryPath = path.join(laneDir, entry, "summary.json");
		let summary: {
			totalGames: number;
			draws: number;
			totalIllegalMoves: number;
			matchLengths: { mean: number };
		};
		try {
			summary = JSON.parse(readFileSync(summaryPath, "utf-8"));
		} catch {
			continue;
		}
		const games = summary.totalGames ?? 0;
		const draws = summary.draws ?? 0;
		const meanTurns = summary.matchLengths?.mean ?? 0;
		const illegalMoves = summary.totalIllegalMoves ?? 0;
		const scenario = entry.split("__")[0] ?? "unknown";

		aggregate.games += games;
		aggregate.draws += draws;
		aggregate.illegalMoves += illegalMoves;
		weightedTurns += meanTurns * games;

		const byScenario =
			aggregate.byScenario[scenario] ??
			({ games: 0, draws: 0, avgTurns: 0 } as const);
		aggregate.byScenario[scenario] = {
			games: byScenario.games + games,
			draws: byScenario.draws + draws,
			avgTurns: byScenario.avgTurns + meanTurns * games,
		};
	}

	aggregate.avgTurns =
		aggregate.games > 0 ? weightedTurns / aggregate.games : 0;
	for (const scenario of Object.keys(aggregate.byScenario)) {
		const entry = aggregate.byScenario[scenario];
		aggregate.byScenario[scenario] = {
			games: entry.games,
			draws: entry.draws,
			avgTurns: entry.games > 0 ? entry.avgTurns / entry.games : 0,
		};
	}

	return aggregate;
}

/**
 * Checks whether a matchup's output already satisfies the expected number of games when resuming a run.
 *
 * @param outputDirAbs - Absolute path to the matchup's output directory (expects a `summary.json` file there)
 * @param expectedGames - The number of games expected for the matchup
 * @param resumeEnabled - If `false`, the function always returns `false`
 * @returns `true` if `summary.json` exists and reports completed games greater than or equal to `expectedGames`, `false` otherwise
 */
function shouldSkipCompletedMatchup(
	outputDirAbs: string,
	expectedGames: number,
	resumeEnabled: boolean,
): boolean {
	if (!resumeEnabled) return false;
	const summaryPath = path.join(outputDirAbs, "summary.json");
	if (!existsSync(summaryPath)) return false;
	try {
		const summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as {
			totalGames?: number;
			completedGames?: number;
		};
		const completed = summary.completedGames ?? summary.totalGames ?? 0;
		return completed >= expectedGames;
	} catch {
		return false;
	}
}

/**
 * Orchestrates a full benchmark run: configures matchups from CLI flags and environment, executes fast (mock) and optional API-driven match lanes, and writes a benchmark summary.
 *
 * Reads command-line options and environment variables to determine run configuration (seeds, games per matchup, timeouts, resume behavior, dry-run, LLM model/settings), executes mass match runs for each matchup (skipping or resuming completed matchups when configured), collects and aggregates per-lane summaries, tracks API failures/skips, and writes a `benchmark-summary.json` to the run output directory.
 */
function main() {
	const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
	const simDir = path.join(repoRoot, "apps", "sim");
	const dryRun = hasFlag("--dryRun");
	const withApi = hasFlag("--withApi");
	const skipFastLane = hasFlag("--skipFastLane") || hasFlag("--apiOnly");
	const resume = parseBoolArg("--resume", true);
	const gamesPerMatchup = Number.parseInt(
		parseArg("--gamesPerMatchup") ?? "4",
		10,
	);
	const apiGamesPerMatchup = Number.parseInt(
		parseArg("--apiGamesPerMatchup") ?? "1",
		10,
	);
	const maxTurns = Number.parseInt(parseArg("--maxTurns") ?? "200", 10);
	const baseSeed = Number.parseInt(parseArg("--seed") ?? "70000", 10);
	const model = parseArg("--model") ?? "openai/gpt-4o-mini";
	const apiMaxTurns = Number.parseInt(parseArg("--apiMaxTurns") ?? "120", 10);
	const apiLlmParallelCalls = Number.parseInt(
		parseArg("--apiLlmParallelCalls") ?? "1",
		10,
	);
	const apiLlmTimeoutMs = Number.parseInt(
		parseArg("--apiLlmTimeoutMs") ?? "20000",
		10,
	);
	const apiLlmMaxRetries = Number.parseInt(
		parseArg("--apiLlmMaxRetries") ?? "1",
		10,
	);
	const apiLlmRetryBaseMs = Number.parseInt(
		parseArg("--apiLlmRetryBaseMs") ?? "600",
		10,
	);
	const apiLlmMaxTokens = Number.parseInt(
		parseArg("--apiLlmMaxTokens") ?? "280",
		10,
	);
	const apiCommandTimeoutMs = Number.parseInt(
		parseArg("--apiCommandTimeoutMs") ?? "240000",
		10,
	);
	const apiCommandRetries = Number.parseInt(
		parseArg("--apiCommandRetries") ?? "1",
		10,
	);
	const apiContinueOnError = parseArg("--apiContinueOnError") !== "false";
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const runName = parseArg("--name") ?? `benchmark_v1_${timestamp}`;
	const outputBaseInSim = path.join("results", runName);
	const outputBaseAbs = path.join(simDir, outputBaseInSim);

	const matchups = collectMatchups(baseSeed);
	mkdirSync(outputBaseAbs, { recursive: true });

	console.log(
		"Using benchmark skill: systematic-debugging (root-cause-first).\n",
	);
	console.log(`Benchmark output: ${outputBaseAbs}`);
	console.log(
		`Matchups: ${matchups.length} (scenarios=${scenarios.length}, mirroredPairs=${mirroredPairs.length})`,
	);
	console.log(`Games per matchup: ${gamesPerMatchup}`);
	console.log(`Skip fast lane: ${skipFastLane}`);
	console.log(`Resume completed matchups: ${resume}`);
	console.log(
		`Engine/harness locks: boardColumns=17, turnLimit=40, actionsPerTurn=7, maxTurns=${maxTurns}, harness=boardgameio`,
	);
	const apiFailures: string[] = [];
	const skippedApiMatchups: string[] = [];

	const fastLaneDirInSim = path.join(outputBaseInSim, "fast_lane");
	if (!skipFastLane) {
		for (const matchup of matchups) {
			const output = path.join(
				fastLaneDirInSim,
				`${matchup.scenario}__${matchup.bot1}_vs_${matchup.bot2}`,
			);
			runCmd(
				repoRoot,
				[
					"-C",
					"apps/sim",
					"exec",
					"tsx",
					"src/cli.ts",
					"mass",
					"--games",
					String(gamesPerMatchup),
					"--parallel",
					"4",
					"--output",
					output,
					"--harness",
					"boardgameio",
					"--boardColumns",
					"17",
					"--turnLimit",
					"40",
					"--actionsPerTurn",
					"7",
					"--maxTurns",
					String(maxTurns),
					"--scenario",
					matchup.scenario,
					"--bot1",
					"mockllm",
					"--bot2",
					"mockllm",
					"--strategy1",
					matchup.bot1,
					"--strategy2",
					matchup.bot2,
					"--seed",
					String(matchup.seed),
					"--quiet",
				],
				dryRun,
			);
		}
	}

	if (withApi) {
		const hasApiKey = !!(
			process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY
		);
		if (!hasApiKey && !dryRun) {
			throw new Error(
				"--withApi requires LLM_API_KEY or OPENROUTER_API_KEY in environment",
			);
		}
		const apiLaneDirInSim = path.join(outputBaseInSim, "api_lane");
		const apiPairs = mirroredPairs.slice(0, 3); // 12 games total across 4 scenarios
		let apiSeed = baseSeed + 10_000;
		for (const scenario of scenarios) {
			for (const [bot1, bot2] of apiPairs) {
				const output = path.join(
					apiLaneDirInSim,
					`${scenario}__${bot1}_vs_${bot2}`,
				);
				if (
					shouldSkipCompletedMatchup(
						path.join(simDir, output),
						apiGamesPerMatchup,
						resume,
					)
				) {
					skippedApiMatchups.push(path.basename(output));
					apiSeed += 1;
					continue;
				}
				const ok = runCmd(
					repoRoot,
					[
						"-C",
						"apps/sim",
						"exec",
						"tsx",
						"src/cli.ts",
						"mass",
						"--games",
						String(apiGamesPerMatchup),
						"--parallel",
						"1",
						"--output",
						output,
						"--harness",
						"boardgameio",
						"--boardColumns",
						"17",
						"--turnLimit",
						"40",
						"--actionsPerTurn",
						"7",
						"--maxTurns",
						String(apiMaxTurns),
						"--scenario",
						scenario,
						"--bot1",
						"llm",
						"--bot2",
						"llm",
						"--model1",
						model,
						"--model2",
						model,
						"--strategy1",
						bot1,
						"--strategy2",
						bot2,
						"--llmParallelCalls",
						String(Math.max(1, apiLlmParallelCalls)),
						"--llmTimeoutMs",
						String(Math.max(1, apiLlmTimeoutMs)),
						"--llmMaxRetries",
						String(Math.max(0, apiLlmMaxRetries)),
						"--llmRetryBaseMs",
						String(Math.max(1, apiLlmRetryBaseMs)),
						"--llmMaxTokens",
						String(Math.max(64, apiLlmMaxTokens)),
						"--seed",
						String(apiSeed),
						"--quiet",
					],
					dryRun,
					{
						timeoutMs: Math.max(0, apiCommandTimeoutMs),
						retries: Math.max(0, apiCommandRetries),
						continueOnError: apiContinueOnError,
					},
				);
				if (!ok) {
					apiFailures.push(`${scenario}__${bot1}_vs_${bot2}`);
				}
				apiSeed += 1;
			}
		}
	}

	if (dryRun) {
		console.log("\nDry run complete (no matches executed).");
		return;
	}

	const benchmarkSummary = {
		version: "benchmark_v1",
		timestamp: new Date().toISOString(),
		config: {
			boardColumns: 17,
			turnLimit: 40,
			actionsPerTurn: 7,
			maxTurns,
			gamesPerMatchup,
			apiGamesPerMatchup,
			baseSeed,
			matchupCount: matchups.length,
			withApi,
			skipFastLane,
			resume,
			apiModel: withApi ? model : null,
		},
		fastLane: aggregateSummaries(path.join(outputBaseAbs, "fast_lane")),
		apiLane: withApi
			? aggregateSummaries(path.join(outputBaseAbs, "api_lane"))
			: null,
		apiReliability: withApi
			? {
					failedMatchups: apiFailures,
					failedMatchupCount: apiFailures.length,
					skippedApiMatchups,
					skippedApiMatchupCount: skippedApiMatchups.length,
					apiCommandTimeoutMs: Math.max(0, apiCommandTimeoutMs),
					apiCommandRetries: Math.max(0, apiCommandRetries),
				}
			: null,
	};

	const summaryPath = path.join(outputBaseAbs, "benchmark-summary.json");
	writeFileSync(summaryPath, JSON.stringify(benchmarkSummary, null, 2));

	console.log("\nBenchmark complete.");
	console.log(`Summary: ${summaryPath}`);
}

main();