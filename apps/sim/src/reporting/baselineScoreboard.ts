import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

type MatchReason = "terminal" | "maxTurns" | "illegal";

type FastLaneSummary = {
	totalGames?: number;
	completedGames?: number;
	draws?: number;
	totalIllegalMoves?: number;
	wins?: Record<string, number>;
	matchLengths?: {
		mean?: number;
	};
};

type MatchResultRow = {
	turns?: number;
	winner?: "P1" | "P2" | null;
	illegalMoves?: number;
	reason?: MatchReason;
};

export type BaselineBehaviorInput = {
	games: number;
	actionDiversity: {
		avgShannonEntropy: number;
	};
	macroIndex: {
		score: number;
	};
	terrainLeverage: {
		leverageRate: number | null;
	};
};

export type BaselineApiTelemetry = {
	matchup: string;
	durationMs: number;
	status?: string;
};

type ScoreAccumulator = {
	profileId: string;
	games: number;
	wins: number;
	losses: number;
	draws: number;
	totalIllegalMovesProxy: number;
	maxTurnsCount: number;
	illegalEndingCount: number;
	totalTurnsProxy: number;
	spectatorWeightedSum: number;
	spectatorGames: number;
	apiDurationMs: number;
	apiTurns: number;
};

export type BaselineProfileScore = {
	profileId: string;
	games: number;
	wins: number;
	losses: number;
	draws: number;
	winRate: number;
	legalMoveRate: number;
	avgMatchTurns: number;
	maxTurnsRate: number;
	illegalEndingRate: number;
	spectatorUsefulness: number;
	avgTurnLatencyMs: number | null;
	compositeScore: number;
};

export type BaselineScoreboard = {
	version: "baseline_scoreboard_v1";
	profiles: BaselineProfileScore[];
	winner: {
		profileId: string;
		compositeScore: number;
		reasons: string[];
	} | null;
	totals: {
		profiles: number;
		matchups: number;
		games: number;
	};
};

function round(value: number, digits = 4): number {
	return Number(value.toFixed(digits));
}

function clamp01(value: number): number {
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function parseMatchupName(matchup: string): {
	scenario: string;
	profileA: string;
	profileB: string;
} | null {
	const [scenario, pair] = matchup.split("__");
	if (!scenario || !pair) return null;
	const [profileA, profileB] = pair.split("_vs_");
	if (!profileA || !profileB) return null;
	return { scenario, profileA, profileB };
}

function readJsonFile<T>(filePath: string): T | null {
	try {
		return JSON.parse(readFileSync(filePath, "utf-8")) as T;
	} catch {
		return null;
	}
}

function readResultsJsonl(filePath: string): MatchResultRow[] {
	if (!existsSync(filePath)) return [];
	try {
		return readFileSync(filePath, "utf-8")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line) as MatchResultRow);
	} catch {
		return [];
	}
}

function computeSpectatorUsefulness(metrics: BaselineBehaviorInput): number {
	const entropy = clamp01(metrics.actionDiversity.avgShannonEntropy / 1.5);
	const macro = clamp01(metrics.macroIndex.score);
	const terrain = clamp01(metrics.terrainLeverage.leverageRate ?? 0);
	return round((entropy + macro + terrain) / 3);
}

function getOrCreateAccumulator(
	map: Map<string, ScoreAccumulator>,
	profileId: string,
): ScoreAccumulator {
	const existing = map.get(profileId);
	if (existing) return existing;
	const created: ScoreAccumulator = {
		profileId,
		games: 0,
		wins: 0,
		losses: 0,
		draws: 0,
		totalIllegalMovesProxy: 0,
		maxTurnsCount: 0,
		illegalEndingCount: 0,
		totalTurnsProxy: 0,
		spectatorWeightedSum: 0,
		spectatorGames: 0,
		apiDurationMs: 0,
		apiTurns: 0,
	};
	map.set(profileId, created);
	return created;
}

function buildProfileScore(acc: ScoreAccumulator): BaselineProfileScore {
	const winRate = acc.games > 0 ? acc.wins / acc.games : 0;
	const avgMatchTurns = acc.games > 0 ? acc.totalTurnsProxy / acc.games : 0;
	const legalMoveRate =
		acc.totalTurnsProxy > 0
			? clamp01(1 - acc.totalIllegalMovesProxy / acc.totalTurnsProxy)
			: 1;
	const maxTurnsRate = acc.games > 0 ? acc.maxTurnsCount / acc.games : 0;
	const illegalEndingRate =
		acc.games > 0 ? acc.illegalEndingCount / acc.games : 0;
	const spectatorUsefulness =
		acc.spectatorGames > 0 ? acc.spectatorWeightedSum / acc.spectatorGames : 0;
	const avgTurnLatencyMs =
		acc.apiTurns > 0 ? acc.apiDurationMs / acc.apiTurns : null;
	const cleanCompletionRate = clamp01(1 - maxTurnsRate - illegalEndingRate);
	const compositeScore = round(
		legalMoveRate * 0.35 +
			cleanCompletionRate * 0.3 +
			winRate * 0.2 +
			spectatorUsefulness * 0.15,
	);

	return {
		profileId: acc.profileId,
		games: acc.games,
		wins: acc.wins,
		losses: acc.losses,
		draws: acc.draws,
		winRate: round(winRate),
		legalMoveRate: round(legalMoveRate),
		avgMatchTurns: round(avgMatchTurns, 2),
		maxTurnsRate: round(maxTurnsRate),
		illegalEndingRate: round(illegalEndingRate),
		spectatorUsefulness: round(spectatorUsefulness),
		avgTurnLatencyMs:
			avgTurnLatencyMs == null ? null : round(avgTurnLatencyMs, 2),
		compositeScore,
	};
}

function attributeIllegalEnding(args: {
	accA: ScoreAccumulator;
	accB: ScoreAccumulator;
	result: MatchResultRow;
}): void {
	if (args.result.reason !== "illegal") return;
	if (args.result.winner === "P1") {
		args.accB.illegalEndingCount += 1;
		return;
	}
	if (args.result.winner === "P2") {
		args.accA.illegalEndingCount += 1;
		return;
	}
	// Ambiguous illegal endings are split evenly between both profiles on purpose.
	args.accA.illegalEndingCount += 0.5;
	args.accB.illegalEndingCount += 0.5;
}

function attributeIllegalMoves(args: {
	accA: ScoreAccumulator;
	accB: ScoreAccumulator;
	result: MatchResultRow;
}): void {
	const illegalMoves = args.result.illegalMoves ?? 0;
	if (illegalMoves <= 0) return;
	if (args.result.reason === "illegal" && args.result.winner === "P1") {
		args.accB.totalIllegalMovesProxy += illegalMoves;
		return;
	}
	if (args.result.reason === "illegal" && args.result.winner === "P2") {
		args.accA.totalIllegalMovesProxy += illegalMoves;
		return;
	}
	// When attribution is ambiguous, split illegal move blame evenly as a heuristic.
	const sharedIllegalMoves = illegalMoves / 2;
	args.accA.totalIllegalMovesProxy += sharedIllegalMoves;
	args.accB.totalIllegalMovesProxy += sharedIllegalMoves;
}

export function buildBaselineScoreboard(input: {
	fastLaneDir: string;
	behaviorByMatchup?: Record<string, BaselineBehaviorInput>;
	apiLaneDir?: string;
	apiTelemetry?: BaselineApiTelemetry[];
}): BaselineScoreboard {
	const behaviorByMatchup = input.behaviorByMatchup ?? {};
	const accumulators = new Map<string, ScoreAccumulator>();
	const apiTelemetryByMatchup = new Map(
		(input.apiTelemetry ?? []).map((entry) => [entry.matchup, entry]),
	);

	let matchupCount = 0;
	let totalGames = 0;

	if (existsSync(input.fastLaneDir)) {
		for (const entry of readdirSync(input.fastLaneDir)) {
			const parsed = parseMatchupName(entry);
			if (!parsed) continue;

			const summary = readJsonFile<FastLaneSummary>(
				path.join(input.fastLaneDir, entry, "summary.json"),
			);
			if (!summary) continue;

			matchupCount += 1;
			const games = summary.totalGames ?? summary.completedGames ?? 0;
			const draws = summary.draws ?? 0;
			const totalIllegalMoves = summary.totalIllegalMoves ?? 0;
			const meanTurns = summary.matchLengths?.mean ?? 0;
			const totalTurnsProxy = meanTurns * games;
			const winsP1 = summary.wins?.P1 ?? 0;
			const winsP2 = summary.wins?.P2 ?? 0;
			const lossesP1 = Math.max(0, games - winsP1 - draws);
			const lossesP2 = Math.max(0, games - winsP2 - draws);
			const results = readResultsJsonl(
				path.join(input.fastLaneDir, entry, "results.jsonl"),
			);
			const maxTurnsCount = results.filter(
				(result) => result.reason === "maxTurns",
			).length;
			const behavior = behaviorByMatchup[entry];
			const spectatorUsefulness = behavior
				? computeSpectatorUsefulness(behavior)
				: 0;
			const spectatorGames = behavior?.games ?? games;

			const accA = getOrCreateAccumulator(accumulators, parsed.profileA);
			accA.games += games;
			accA.wins += winsP1;
			accA.losses += lossesP1;
			accA.draws += draws;
			accA.maxTurnsCount += maxTurnsCount;
			accA.totalTurnsProxy += totalTurnsProxy;
			accA.spectatorWeightedSum += spectatorUsefulness * spectatorGames;
			accA.spectatorGames += spectatorGames;

			const accB = getOrCreateAccumulator(accumulators, parsed.profileB);
			accB.games += games;
			accB.wins += winsP2;
			accB.losses += lossesP2;
			accB.draws += draws;
			accB.maxTurnsCount += maxTurnsCount;
			accB.totalTurnsProxy += totalTurnsProxy;
			accB.spectatorWeightedSum += spectatorUsefulness * spectatorGames;
			accB.spectatorGames += spectatorGames;

			if (results.length > 0) {
				for (const result of results) {
					attributeIllegalEnding({ accA, accB, result });
					attributeIllegalMoves({ accA, accB, result });
				}
			} else if (totalIllegalMoves > 0) {
				const illegalMoveShare = totalIllegalMoves / 2;
				accA.totalIllegalMovesProxy += illegalMoveShare;
				accB.totalIllegalMovesProxy += illegalMoveShare;
			}

			totalGames += games;
		}
	}

	if (input.apiLaneDir && existsSync(input.apiLaneDir)) {
		for (const entry of readdirSync(input.apiLaneDir)) {
			const parsed = parseMatchupName(entry);
			if (!parsed) continue;
			const telemetry = apiTelemetryByMatchup.get(entry);
			if (!telemetry || telemetry.status !== "ok") continue;
			const apiRows = readResultsJsonl(
				path.join(input.apiLaneDir, entry, "results.jsonl"),
			);
			const totalTurns = apiRows.reduce(
				(sum, row) => sum + (row.turns ?? 0),
				0,
			);
			if (totalTurns <= 0) continue;
			for (const profileId of [parsed.profileA, parsed.profileB]) {
				const acc = getOrCreateAccumulator(accumulators, profileId);
				acc.apiDurationMs += telemetry.durationMs;
				acc.apiTurns += totalTurns;
			}
		}
	}

	const profiles = [...accumulators.values()]
		.map(buildProfileScore)
		.sort((a, b) => {
			if (b.compositeScore !== a.compositeScore) {
				return b.compositeScore - a.compositeScore;
			}
			if (a.maxTurnsRate !== b.maxTurnsRate) {
				return a.maxTurnsRate - b.maxTurnsRate;
			}
			if (a.avgMatchTurns !== b.avgMatchTurns) {
				return a.avgMatchTurns - b.avgMatchTurns;
			}
			return a.profileId.localeCompare(b.profileId);
		});

	const winner = profiles[0]
		? {
				profileId: profiles[0].profileId,
				compositeScore: profiles[0].compositeScore,
				reasons: [
					`winRate=${profiles[0].winRate}`,
					`legalMoveRate=${profiles[0].legalMoveRate}`,
					`maxTurnsRate=${profiles[0].maxTurnsRate}`,
					`spectatorUsefulness=${profiles[0].spectatorUsefulness}`,
				],
			}
		: null;

	return {
		version: "baseline_scoreboard_v1",
		profiles,
		winner,
		totals: {
			profiles: profiles.length,
			matchups: matchupCount,
			games: totalGames,
		},
	};
}

export function renderBaselineScoreboardMarkdown(
	scoreboard: BaselineScoreboard,
): string {
	const lines = [
		"# Baseline Scoreboard",
		"",
		`Profiles: ${scoreboard.totals.profiles}`,
		`Matchups: ${scoreboard.totals.matchups}`,
		`Games: ${scoreboard.totals.games}`,
		"",
	];

	if (scoreboard.winner) {
		lines.push("## Winner", "", `- ${scoreboard.winner.profileId}`);
		for (const reason of scoreboard.winner.reasons) {
			lines.push(`- ${reason}`);
		}
		lines.push("");
	}

	lines.push(
		"| Profile | Score | Win Rate | Legal Move Rate | Max-Turn Rate | Illegal Ending Rate | Avg Turns | Spectator | Avg Turn Latency (ms) |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	);
	for (const profile of scoreboard.profiles) {
		lines.push(
			`| ${profile.profileId} | ${profile.compositeScore.toFixed(4)} | ${profile.winRate.toFixed(4)} | ${profile.legalMoveRate.toFixed(4)} | ${profile.maxTurnsRate.toFixed(4)} | ${profile.illegalEndingRate.toFixed(4)} | ${profile.avgMatchTurns.toFixed(2)} | ${profile.spectatorUsefulness.toFixed(4)} | ${profile.avgTurnLatencyMs == null ? "n/a" : profile.avgTurnLatencyMs.toFixed(2)} |`,
		);
	}

	return `${lines.join("\n")}\n`;
}
