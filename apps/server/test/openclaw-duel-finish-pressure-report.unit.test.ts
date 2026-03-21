import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	combineFinishPressureSummaries,
	readSmokeArtifactSummary,
	summarizeFinishPressure,
} from "../scripts/openclaw-duel-finish-pressure-report.mjs";

describe("summarizeFinishPressure", () => {
	it("keeps turns from different matches in separate groups", () => {
		const summary = summarizeFinishPressure({
			events: [
				{
					matchId: "match-1",
					event: "engine_events",
					payload: {
						move: { action: "end_turn" },
						engineEvents: [{ type: "turn_end", turn: 1, player: "A" }],
					},
				},
				{
					matchId: "match-2",
					event: "engine_events",
					payload: {
						move: { action: "end_turn" },
						engineEvents: [{ type: "turn_end", turn: 1, player: "A" }],
					},
				},
			],
		});

		expect(summary.completedTurns).toBe(2);
	});

	it("counts immediate explicit end_turn closures separately from multi-action turns", () => {
		const summary = summarizeFinishPressure({
			events: [
				{
					matchId: "match-1",
					event: "engine_events",
					payload: {
						move: { action: "end_turn" },
						engineEvents: [
							{ type: "turn_end", turn: 1, player: "A" },
							{ type: "turn_start", turn: 1, player: "B" },
						],
					},
				},
				{
					matchId: "match-1",
					event: "engine_events",
					payload: {
						move: { action: "move" },
						engineEvents: [{ type: "move_unit", turn: 1, player: "B" }],
					},
				},
				{
					matchId: "match-1",
					event: "engine_events",
					payload: {
						move: { action: "attack" },
						engineEvents: [{ type: "attack", turn: 1, player: "B" }],
					},
				},
				{
					matchId: "match-1",
					event: "engine_events",
					payload: {
						move: { action: "end_turn" },
						engineEvents: [{ type: "turn_end", turn: 1, player: "B" }],
					},
				},
			],
		});

		expect(summary.completedTurns).toBe(2);
		expect(summary.explicitEndTurnMoves).toBe(2);
		expect(summary.immediateExplicitEndTurns).toBe(1);
		expect(summary.turnsWithExplicitEndTurn).toBe(2);
		expect(summary.turnsWithMultipleActions).toBe(1);
		expect(summary.turnsWithAttack).toBe(1);
		expect(summary.averageNonTerminalActionsPerCompletedTurn).toBe(1);
	});

	it("treats pass as terminal and excludes unfinished turns from completed-turn averages", () => {
		const summary = summarizeFinishPressure({
			events: [
				{
					matchId: "match-2",
					event: "engine_events",
					payload: {
						move: { action: "move" },
						engineEvents: [{ type: "move_unit", turn: 1, player: "A" }],
					},
				},
				{
					matchId: "match-2",
					event: "engine_events",
					payload: {
						move: { action: "pass" },
						engineEvents: [{ type: "turn_end", turn: 2, player: "B" }],
					},
				},
			],
		});

		expect(summary.completedTurns).toBe(1);
		expect(summary.passMoves).toBe(1);
		expect(summary.turnsWithExplicitEndTurn).toBe(0);
		expect(summary.averageNonTerminalActionsPerCompletedTurn).toBe(0);
	});
});

describe("combineFinishPressureSummaries", () => {
	it("aggregates local smoke summaries into a compact report", () => {
		const combined = combineFinishPressureSummaries([
			{
				completedTurns: 2,
				totalMoves: 3,
				nonTerminalMoves: 1,
				completedNonTerminalMoves: 1,
				explicitEndTurnMoves: 2,
				passMoves: 0,
				attackMoves: 0,
				turnsWithExplicitEndTurn: 2,
				immediateExplicitEndTurns: 1,
				turnsWithMultipleActions: 0,
				turnsWithAttack: 0,
			},
			{
				completedTurns: 1,
				totalMoves: 2,
				nonTerminalMoves: 2,
				completedNonTerminalMoves: 2,
				explicitEndTurnMoves: 0,
				passMoves: 0,
				attackMoves: 1,
				turnsWithExplicitEndTurn: 0,
				immediateExplicitEndTurns: 0,
				turnsWithMultipleActions: 1,
				turnsWithAttack: 1,
			},
		]);

		expect(combined.sampleCount).toBe(2);
		expect(combined.completedTurns).toBe(3);
		expect(combined.nonTerminalMoves).toBe(3);
		expect(combined.explicitEndTurnMoves).toBe(2);
		expect(combined.turnsWithMultipleActions).toBe(1);
		expect(combined.turnsWithAttack).toBe(1);
		expect(combined.averageNonTerminalActionsPerCompletedTurn).toBe(1);
	});

	it("uses completed-turn actions instead of unfinished-turn actions for aggregate averages", () => {
		const combined = combineFinishPressureSummaries([
			{
				completedTurns: 1,
				totalMoves: 3,
				nonTerminalMoves: 3,
				completedNonTerminalMoves: 1,
				explicitEndTurnMoves: 1,
				passMoves: 0,
				attackMoves: 0,
				turnsWithExplicitEndTurn: 1,
				immediateExplicitEndTurns: 0,
				turnsWithMultipleActions: 0,
				turnsWithAttack: 0,
			},
		]);

		expect(combined.averageNonTerminalActionsPerCompletedTurn).toBe(1);
	});
});

describe("readSmokeArtifactSummary", () => {
	it("throws when the kept artifact is missing a successful canonical log", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "fightclaw-finish-report-"));
		try {
			writeFileSync(
				path.join(dir, "final-log.json"),
				JSON.stringify({
					ok: false,
					json: null,
				}),
			);

			expect(() => readSmokeArtifactSummary(dir)).toThrow(/not marked ok/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
