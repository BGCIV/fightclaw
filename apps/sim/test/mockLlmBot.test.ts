import { describe, expect, test } from "bun:test";
import { makeMockLlmBot } from "../src/bots/mockLlmBot";
import { Engine } from "../src/engineAdapter";
import { createCombatScenario } from "../src/scenarios/combatScenarios";

describe("mockLlmBot", () => {
	test("strategic prompt with elimination intent prefers attack in melee", async () => {
		const state = createCombatScenario(1, ["P1", "P2"], "melee");
		const legalMoves = Engine.listLegalMoves(state);
		const bot = makeMockLlmBot("P1", {
			strategy: "strategic",
			inline: "Prioritize eliminating damaged enemies and press forward.",
		});
		const move = await bot.chooseMove({
			state,
			legalMoves,
			turn: 1,
			rng: () => 0,
		});
		expect(move.action).toBe("attack");
		const meta = (move as typeof move & { metadata?: { whyThisMove?: string } })
			.metadata;
		expect(typeof meta?.whyThisMove).toBe("string");
	});

	test("defensive prompt with counterattack intent can choose attack", async () => {
		const state = createCombatScenario(2, ["P1", "P2"], "melee");
		const legalMoves = Engine.listLegalMoves(state);
		const bot = makeMockLlmBot("P1", {
			strategy: "defensive",
			inline: "Hold formation and counterattack exposed enemies.",
		});
		const move = await bot.chooseMove({
			state,
			legalMoves,
			turn: 1,
			rng: () => 0,
		});
		expect(move.action).toBe("attack");
	});

	test("does not immediately end turn when playable actions exist", async () => {
		const state = createCombatScenario(3, ["P1", "P2"], "midfield");
		const legalMoves = Engine.listLegalMoves(state);
		const bot = makeMockLlmBot("P1", {
			strategy: "strategic",
		});
		const move = await bot.chooseMove({
			state,
			legalMoves,
			turn: 1,
			rng: () => 0,
		});
		expect(move.action === "end_turn" || move.action === "pass").toBe(false);
	});

	test("legacy strategy maps to explicit archetype metadata", async () => {
		const state = createCombatScenario(4, ["P1", "P2"], "melee");
		const legalMoves = Engine.listLegalMoves(state);
		const bot = makeMockLlmBot("P1", {
			strategy: "aggressive",
		});
		const move = await bot.chooseMove({
			state,
			legalMoves,
			turn: 2,
			rng: () => 0,
		});
		const meta = (
			move as typeof move & {
				metadata?: { breakdown?: { archetype?: string } };
			}
		).metadata;
		expect(meta?.breakdown?.archetype).toBe("timing_push");
	});

	test("late turn uses closing phase policy in metadata", async () => {
		const state = createCombatScenario(5, ["P1", "P2"], "melee");
		const legalMoves = Engine.listLegalMoves(state);
		const bot = makeMockLlmBot("P1", {
			strategy: "strategic",
		});
		const move = await bot.chooseMove({
			state,
			legalMoves,
			turn: 18,
			rng: () => 0,
		});
		const meta = (
			move as typeof move & {
				metadata?: { breakdown?: { phase?: string } };
			}
		).metadata;
		expect(meta?.breakdown?.phase).toBe("closing");
	});

	test("bounded turn planner emits multiple tactical actions before end_turn", async () => {
		const state = createCombatScenario(6, ["P1", "P2"], "melee");
		const legalMoves = Engine.listLegalMoves(state);
		const bot = makeMockLlmBot("P1", {
			strategy: "aggressive",
			inline: "Press attacks and keep momentum if a strong follow-up exists.",
		});

		const moves = await bot.chooseTurn?.({
			state,
			legalMoves,
			turn: 1,
			rng: () => 0,
		});

		expect(moves).toBeDefined();
		expect((moves ?? []).length).toBeGreaterThan(1);
		expect((moves ?? []).length).toBeLessThanOrEqual(4);
		expect((moves ?? []).at(-1)?.action).toBe("end_turn");
		expect((moves ?? []).some((move) => move.action === "attack")).toBe(true);
	});

	test("random bounded turn does not append synthetic end_turn after a forced handoff move", async () => {
		const state = createCombatScenario(7, ["P1", "P2"], "midfield");
		state.actionsRemaining = 1;
		const legalMoves = Engine.listLegalMoves(state);
		const bot = makeMockLlmBot("P1", {
			strategy: "random",
		});

		const moves = await bot.chooseTurn?.({
			state,
			legalMoves,
			turn: 1,
			rng: () => 0,
		});

		expect(moves).toBeDefined();
		expect((moves ?? []).length).toBe(1);
		expect((moves ?? [])[0]?.action).not.toBe("end_turn");
	});

	test("planned bounded turn does not append synthetic end_turn after a forced handoff move", async () => {
		const state = createCombatScenario(8, ["P1", "P2"], "midfield");
		state.actionsRemaining = 1;
		const legalMoves = Engine.listLegalMoves(state);
		const bot = makeMockLlmBot("P1", {
			strategy: "aggressive",
			inline:
				"Press the best move, but do not add an extra end turn after a forced handoff.",
		});

		const moves = await bot.chooseTurn?.({
			state,
			legalMoves,
			turn: 1,
			rng: () => 0,
		});

		expect(moves).toBeDefined();
		expect((moves ?? []).length).toBe(1);
		expect((moves ?? [])[0]?.action).not.toBe("end_turn");
	});
});
