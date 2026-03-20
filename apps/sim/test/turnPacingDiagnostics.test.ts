import { describe, expect, test } from "bun:test";
import { Engine } from "../src/engineAdapter";
import { deriveTurnPacingDiagnostics } from "../src/turnPacingDiagnostics";
import type { EngineEvent, MatchState } from "../src/types";

describe("turn pacing diagnostics", () => {
	test("derives bounded turn-depth and action mix metrics from engine events", () => {
		const state = Engine.createInitialState(1, ["P1", "P2"]);
		const events: EngineEvent[] = [
			{
				type: "turn_start",
				turn: 1,
				player: "A",
				actions: 7,
				goldIncome: 0,
				woodIncome: 0,
				vpGained: 0,
				goldAfter: 0,
				woodAfter: 0,
				vpAfter: 0,
			},
			{
				type: "move_unit",
				turn: 1,
				player: "A",
				unitId: "A-1",
				from: "B2",
				to: "C3",
			},
			{
				type: "attack",
				turn: 1,
				player: "A",
				attackerId: "A-1",
				attackerFrom: "C3",
				defenderIds: ["B-1"],
				targetHex: "D4",
				distance: 1,
				ranged: false,
				attackPower: 4,
				defensePower: 2,
				abilities: [],
				outcome: {
					attackerSurvivors: ["A-1"],
					attackerCasualties: [],
					defenderSurvivors: [],
					defenderCasualties: ["B-1"],
					damageDealt: 2,
					damageTaken: 0,
					captured: true,
				},
			},
			{
				type: "control_update",
				turn: 1,
				changes: [{ hex: "E9", from: null, to: "A" }],
			},
			{ type: "turn_end", turn: 1, player: "A" },
			{
				type: "turn_start",
				turn: 2,
				player: "B",
				actions: 7,
				goldIncome: 0,
				woodIncome: 0,
				vpGained: 0,
				goldAfter: 0,
				woodAfter: 0,
				vpAfter: 0,
			},
			{
				type: "recruit",
				turn: 2,
				player: "B",
				unitId: "B-7",
				unitType: "infantry",
				at: "E18",
			},
			{ type: "turn_end", turn: 2, player: "B" },
		];

		const diagnostics = deriveTurnPacingDiagnostics(
			events,
			state as MatchState,
		);

		expect(diagnostics.meanActionsPerTurn).toBe(1.5);
		expect(diagnostics.oneActionTurnRate).toBe(0.5);
		expect(diagnostics.attackRate).toBeCloseTo(1 / 3, 4);
		expect(diagnostics.objectiveTakeRate).toBe(0.5);
		expect(diagnostics.meaningfulTickerDensity).toBe(1.5);
	});
});
