import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	buildBaselineScoreboard,
	renderBaselineScoreboardMarkdown,
} from "../src/reporting/baselineScoreboard";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function writeMatchup(args: {
	root: string;
	matchup: string;
	totalGames: number;
	draws: number;
	totalIllegalMoves: number;
	meanTurns: number;
	wins: Record<string, number>;
	results?: Array<{
		turns?: number;
		winner?: "P1" | "P2" | null;
		illegalMoves?: number;
		reason?: "terminal" | "maxTurns" | "illegal";
		structuralDiagnostics?: {
			firstContactTurn?: number | null;
			firstDamageTurn?: number | null;
			firstKillTurn?: number | null;
			terminalReason?: "terminal" | "maxTurns" | "illegal";
		};
	}>;
	reasons?: Array<"terminal" | "maxTurns" | "illegal">;
}) {
	const dir = path.join(args.root, args.matchup);
	mkdirSync(dir, { recursive: true });
	const results =
		args.results ??
		args.reasons?.map((reason, index) => ({
			seed: index + 1,
			turns: args.meanTurns,
			winner: reason === "maxTurns" ? null : "P1",
			illegalMoves: reason === "illegal" ? 1 : 0,
			reason,
		})) ??
		[];
	writeFileSync(
		path.join(dir, "summary.json"),
		JSON.stringify(
			{
				totalGames: args.totalGames,
				completedGames: args.totalGames,
				draws: args.draws,
				totalIllegalMoves: args.totalIllegalMoves,
				wins: args.wins,
				matchLengths: { mean: args.meanTurns },
			},
			null,
			2,
		),
	);
	writeFileSync(
		path.join(dir, "results.jsonl"),
		`${results
			.map((result, index) =>
				JSON.stringify({
					seed: index + 1,
					turns: result.turns ?? args.meanTurns,
					winner: result.winner ?? null,
					illegalMoves: result.illegalMoves ?? 0,
					reason: result.reason ?? "terminal",
					structuralDiagnostics: result.structuralDiagnostics,
				}),
			)
			.join("\n")}\n`,
	);
}

describe("baseline scoreboard", () => {
	test("aggregates profile results and selects a winner", () => {
		const root = mkdtempSync(path.join(tmpdir(), "fightclaw-scoreboard-"));
		tempDirs.push(root);
		const fastLaneDir = path.join(root, "fast_lane");
		mkdirSync(fastLaneDir, { recursive: true });

		writeMatchup({
			root: fastLaneDir,
			matchup: "midfield__balanced_beta_vs_aggressive_beta",
			totalGames: 4,
			draws: 1,
			totalIllegalMoves: 0,
			meanTurns: 20,
			wins: { P1: 2, P2: 1 },
			reasons: ["terminal", "terminal", "maxTurns", "terminal"],
		});
		writeMatchup({
			root: fastLaneDir,
			matchup: "melee__aggressive_beta_vs_balanced_beta",
			totalGames: 4,
			draws: 0,
			totalIllegalMoves: 0,
			meanTurns: 18,
			wins: { P1: 1, P2: 3 },
			reasons: ["terminal", "terminal", "terminal", "terminal"],
		});

		const scoreboard = buildBaselineScoreboard({
			fastLaneDir,
			behaviorByMatchup: {
				midfield__balanced_beta_vs_aggressive_beta: {
					games: 4,
					actionDiversity: { avgShannonEntropy: 0.9 },
					macroIndex: { score: 0.75 },
					terrainLeverage: { leverageRate: 0.8 },
				},
				melee__aggressive_beta_vs_balanced_beta: {
					games: 4,
					actionDiversity: { avgShannonEntropy: 0.7 },
					macroIndex: { score: 0.6 },
					terrainLeverage: { leverageRate: 0.5 },
				},
			},
		});

		expect(scoreboard.version).toBe("baseline_scoreboard_v2");
		expect(scoreboard.winner?.profileId).toBe("balanced_beta");
		expect(scoreboard.profiles.map((profile) => profile.profileId)).toEqual([
			"balanced_beta",
			"aggressive_beta",
		]);
		expect(scoreboard.profiles[0]?.wins).toBe(5);
		expect(scoreboard.profiles[0]?.draws).toBe(1);
		expect(scoreboard.profiles[0]?.maxTurnsRate).toBeCloseTo(0.125, 5);
		expect(scoreboard.profiles[0]?.spectatorUsefulness).toBeGreaterThan(0.6);

		const markdown = renderBaselineScoreboardMarkdown(scoreboard);
		expect(markdown).toContain("# Baseline Scoreboard");
		expect(markdown).toContain("balanced_beta");
		expect(markdown).toContain("Winner");
	});

	test("ignores skipped api telemetry and weights avg turn latency by turns", () => {
		const root = mkdtempSync(path.join(tmpdir(), "fightclaw-scoreboard-"));
		tempDirs.push(root);
		const fastLaneDir = path.join(root, "fast_lane");
		const apiLaneDir = path.join(root, "api_lane");
		mkdirSync(fastLaneDir, { recursive: true });
		mkdirSync(apiLaneDir, { recursive: true });

		writeMatchup({
			root: fastLaneDir,
			matchup: "midfield__balanced_beta_vs_aggressive_beta",
			totalGames: 1,
			draws: 0,
			totalIllegalMoves: 0,
			meanTurns: 10,
			wins: { P1: 1, P2: 0 },
			results: [
				{ turns: 10, winner: "P1", illegalMoves: 0, reason: "terminal" },
			],
		});
		writeMatchup({
			root: fastLaneDir,
			matchup: "melee__balanced_beta_vs_aggressive_beta",
			totalGames: 1,
			draws: 0,
			totalIllegalMoves: 0,
			meanTurns: 100,
			wins: { P1: 1, P2: 0 },
			results: [
				{ turns: 100, winner: "P1", illegalMoves: 0, reason: "terminal" },
			],
		});
		writeMatchup({
			root: apiLaneDir,
			matchup: "midfield__balanced_beta_vs_aggressive_beta",
			totalGames: 1,
			draws: 0,
			totalIllegalMoves: 0,
			meanTurns: 10,
			wins: { P1: 1, P2: 0 },
			results: [
				{ turns: 10, winner: "P1", illegalMoves: 0, reason: "terminal" },
			],
		});
		writeMatchup({
			root: apiLaneDir,
			matchup: "melee__balanced_beta_vs_aggressive_beta",
			totalGames: 1,
			draws: 0,
			totalIllegalMoves: 0,
			meanTurns: 100,
			wins: { P1: 1, P2: 0 },
			results: [
				{ turns: 100, winner: "P1", illegalMoves: 0, reason: "terminal" },
			],
		});
		writeMatchup({
			root: apiLaneDir,
			matchup: "all_infantry__balanced_beta_vs_aggressive_beta",
			totalGames: 1,
			draws: 0,
			totalIllegalMoves: 0,
			meanTurns: 500,
			wins: { P1: 1, P2: 0 },
			results: [
				{ turns: 500, winner: "P1", illegalMoves: 0, reason: "terminal" },
			],
		});

		const scoreboard = buildBaselineScoreboard({
			fastLaneDir,
			apiLaneDir,
			apiTelemetry: [
				{
					matchup: "midfield__balanced_beta_vs_aggressive_beta",
					durationMs: 100,
					status: "ok",
				},
				{
					matchup: "melee__balanced_beta_vs_aggressive_beta",
					durationMs: 500,
					status: "ok",
				},
				{
					matchup: "all_infantry__balanced_beta_vs_aggressive_beta",
					durationMs: 0,
					status: "skipped",
				},
			],
		});

		expect(scoreboard.profiles[0]?.avgTurnLatencyMs).toBeCloseTo(5.45, 2);
	});

	test("attributes illegal terminal endings to the losing profile", () => {
		const root = mkdtempSync(path.join(tmpdir(), "fightclaw-scoreboard-"));
		tempDirs.push(root);
		const fastLaneDir = path.join(root, "fast_lane");
		mkdirSync(fastLaneDir, { recursive: true });

		writeMatchup({
			root: fastLaneDir,
			matchup: "midfield__balanced_beta_vs_aggressive_beta",
			totalGames: 2,
			draws: 0,
			totalIllegalMoves: 1,
			meanTurns: 12,
			wins: { P1: 2, P2: 0 },
			results: [
				{ turns: 10, winner: "P1", illegalMoves: 1, reason: "illegal" },
				{ turns: 14, winner: "P1", illegalMoves: 0, reason: "terminal" },
			],
		});

		const scoreboard = buildBaselineScoreboard({ fastLaneDir });
		const balanced = scoreboard.profiles.find(
			(profile) => profile.profileId === "balanced_beta",
		);
		const aggressive = scoreboard.profiles.find(
			(profile) => profile.profileId === "aggressive_beta",
		);

		expect(balanced?.illegalEndingRate).toBe(0);
		expect(aggressive?.illegalEndingRate).toBeCloseTo(0.5, 5);
	});

	test("surfaces aggregated structural pacing averages in rows and markdown", () => {
		const root = mkdtempSync(path.join(tmpdir(), "fightclaw-scoreboard-"));
		tempDirs.push(root);
		const fastLaneDir = path.join(root, "fast_lane");
		mkdirSync(fastLaneDir, { recursive: true });

		writeMatchup({
			root: fastLaneDir,
			matchup: "midfield__balanced_beta_vs_aggressive_beta",
			totalGames: 2,
			draws: 0,
			totalIllegalMoves: 0,
			meanTurns: 22,
			wins: { P1: 1, P2: 1 },
			results: [
				{
					turns: 20,
					winner: "P1",
					illegalMoves: 0,
					reason: "terminal",
					structuralDiagnostics: {
						firstContactTurn: 4,
						firstDamageTurn: 6,
						firstKillTurn: 9,
						terminalReason: "terminal",
					},
				},
				{
					turns: 24,
					winner: "P2",
					illegalMoves: 0,
					reason: "terminal",
					structuralDiagnostics: {
						firstContactTurn: 6,
						firstDamageTurn: 8,
						firstKillTurn: 11,
						terminalReason: "terminal",
					},
				},
			],
		});

		const scoreboard = buildBaselineScoreboard({ fastLaneDir });
		const balanced = scoreboard.profiles.find(
			(profile) => profile.profileId === "balanced_beta",
		);

		expect(balanced?.avgFirstContactTurn).toBe(5);
		expect(balanced?.avgFirstDamageTurn).toBe(7);
		expect(balanced?.avgFirstKillTurn).toBe(10);

		const markdown = renderBaselineScoreboardMarkdown(scoreboard);
		expect(markdown).toContain("First Contact");
		expect(markdown).toContain("First Damage");
		expect(markdown).toContain("First Kill");
		expect(markdown).toContain("5.00");
		expect(markdown).toContain("7.00");
		expect(markdown).toContain("10.00");
	});
});
