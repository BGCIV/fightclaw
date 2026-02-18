import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	createInitialState,
	type MatchState,
	type Move,
} from "@fightclaw/engine";
import minimist from "minimist";
import type { MatchArtifact, ScenarioName } from "../src/boardgameio/types";
import { createCombatScenario } from "../src/scenarios/combatScenarios";

type ReplayStep = {
	ply: number;
	playerID: string;
	move: Move;
	preHash: string;
	postHash: string;
};

type ReplayMatch = {
	id: string;
	label: string;
	scenario: ScenarioName | null;
	seed: number;
	participants: [string, string];
	result: MatchArtifact["result"];
	initialState: MatchState;
	steps: ReplayStep[];
};

type ReplayBundle = {
	version: 1;
	generatedAt: string;
	runDir: string;
	summaryPath: string | null;
	matchCount: number;
	matches: ReplayMatch[];
};

type Args = {
	run?: string;
	output?: string;
	latest?: boolean;
	quiet?: boolean;
};

/**
 * Resolve the directory containing benchmark results to export.
 *
 * If `args.run` is provided, it is resolved to an absolute path and validated to exist; otherwise the function selects the most recently modified directory under `results/` whose name starts with `benchmark_v2_` and that contains an `api_lane` subdirectory.
 *
 * @param args - Command-line arguments; may include `run` to specify a run directory.
 * @returns The absolute path to the resolved run directory.
 * @throws If the specified run directory does not exist, if the `results` directory does not exist, or if no suitable `benchmark_v2_` run with an `api_lane` subdirectory can be found.
 */
function resolveRunDir(args: Args): string {
	if (args.run) {
		const resolved = path.resolve(process.cwd(), args.run);
		if (!existsSync(resolved)) {
			throw new Error(`Run directory not found: ${resolved}`);
		}
		return resolved;
	}

	const resultsDir = path.resolve(process.cwd(), "results");
	if (!existsSync(resultsDir)) {
		throw new Error(`Results directory not found: ${resultsDir}`);
	}

	const candidates = readdirSync(resultsDir, { withFileTypes: true })
		.filter(
			(entry) => entry.isDirectory() && entry.name.startsWith("benchmark_v2_"),
		)
		.map((entry) => path.join(resultsDir, entry.name))
		.filter((dir) => existsSync(path.join(dir, "api_lane")))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

	const latest = candidates[0];
	if (!latest) {
		throw new Error(
			"No benchmark_v2 run with api_lane found in apps/sim/results",
		);
	}
	return latest;
}

/**
 * Collects artifact JSON file paths under the run's api_lane/artifacts directory.
 *
 * @param runDir - Path to the benchmark run directory to search
 * @returns A sorted array of file paths for JSON files found under `api_lane/**/artifacts/**`
 * @throws Error if the `api_lane` directory is not present inside `runDir`
 */
function findArtifactFiles(runDir: string): string[] {
	const apiLaneDir = path.join(runDir, "api_lane");
	if (!existsSync(apiLaneDir)) {
		throw new Error(`api_lane directory not found in run: ${runDir}`);
	}

	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			if (!full.includes(`${path.sep}artifacts${path.sep}`)) continue;
			out.push(full);
		}
	};

	walk(apiLaneDir);
	return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Create the initial MatchState corresponding to a stored MatchArtifact.
 *
 * @param artifact - The artifact containing seed, participants, and optional scenario information
 * @returns The initial MatchState configured for the artifact's seed and participants, using the artifact's scenario if present
 */
function createInitialStateForArtifact(artifact: MatchArtifact): MatchState {
	if (artifact.scenario) {
		return createCombatScenario(
			artifact.seed,
			artifact.participants,
			artifact.scenario,
			{ boardColumns: 17 },
		);
	}
	return createInitialState(
		artifact.seed,
		{ boardColumns: 17 },
		artifact.participants,
	);
}

/**
 * Create a ReplayMatch from a stored artifact JSON file.
 *
 * The returned match aggregates the artifact's metadata, reconstructed initial state,
 * and its accepted moves as replay steps. If the artifact lacks a scenario field,
 * the `scenario` property of the result will be `null`.
 *
 * @param file - Filesystem path to the artifact JSON file
 * @returns A ReplayMatch representing the match described by the artifact file
 */
function toReplayMatch(file: string): ReplayMatch {
	const artifact = JSON.parse(readFileSync(file, "utf8")) as MatchArtifact;
	const matchupDir = path.basename(path.dirname(path.dirname(file)));
	const fileName = path.basename(file, ".json");
	const id = `${matchupDir}::${fileName}`;
	const label = `${matchupDir} [seed ${artifact.seed}]`;
	const steps: ReplayStep[] = artifact.acceptedMoves.map((entry) => ({
		ply: entry.ply,
		playerID: entry.playerID,
		move: entry.engineMove,
		preHash: entry.preHash,
		postHash: entry.postHash,
	}));

	return {
		id,
		label,
		scenario: artifact.scenario ?? null,
		seed: artifact.seed,
		participants: artifact.participants,
		result: artifact.result,
		initialState: createInitialStateForArtifact(artifact),
		steps,
	};
}

/**
 * Build a replay bundle from benchmark artifacts and write it to disk.
 *
 * Parses command-line arguments, resolves the benchmark run directory, collects artifact files, converts them into replay matches, assembles a ReplayBundle JSON payload, and writes it to the specified output path. Prints a brief summary to stdout unless run with `--quiet`.
 */
function main() {
	const rawArgs = process.argv.slice(2);
	const divider = rawArgs.indexOf("--");
	const normalizedArgs =
		divider >= 0
			? [...rawArgs.slice(0, divider), ...rawArgs.slice(divider + 1)]
			: rawArgs;

	const argv = minimist(normalizedArgs, {
		boolean: ["latest", "quiet"],
		string: ["run", "output"],
		default: {
			latest: true,
			quiet: false,
		} satisfies Args,
	}) as Args;

	const runDir = resolveRunDir(argv);
	const outputPath = path.resolve(
		process.cwd(),
		argv.output ?? "../web/public/dev-replay/latest.json",
	);
	const summaryPath = path.join(runDir, "benchmark-summary.json");

	const artifactFiles = findArtifactFiles(runDir);
	const matches = artifactFiles.map((file) => toReplayMatch(file));

	const payload: ReplayBundle = {
		version: 1,
		generatedAt: new Date().toISOString(),
		runDir,
		summaryPath: existsSync(summaryPath) ? summaryPath : null,
		matchCount: matches.length,
		matches,
	};

	mkdirSync(path.dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, JSON.stringify(payload, null, 2));

	if (!argv.quiet) {
		console.log(`Replay export complete: ${outputPath}`);
		console.log(`Run: ${runDir}`);
		console.log(`Matches: ${matches.length}`);
	}
}

main();