import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createInitialState,
	listLegalMoves,
	type Move,
} from "@fightclaw/engine";
import {
	resolveEarlyEndTurnOverride,
	selectFinishFollowUpMove,
} from "../src/finishPressure";

const createAttackPressureState = () => {
	const state = structuredClone(
		createInitialState(1, undefined, ["agent-a", "agent-b"]),
	);
	for (const hex of state.board) {
		const index = hex.unitIds.indexOf("B-1");
		if (index >= 0) {
			hex.unitIds.splice(index, 1);
		}
	}
	const enemy = state.players.B.units.find((unit) => unit.id === "B-1");
	if (!enemy) {
		throw new Error("Expected B-1 to exist in the attack pressure state.");
	}
	enemy.position = "C3";
	const targetHex = state.board.find((hex) => hex.id === "C3");
	if (!targetHex) {
		throw new Error("Expected C3 to exist in the attack pressure state.");
	}
	targetHex.unitIds.push("B-1");
	return state;
};

test("prefers attack over other follow-ups", () => {
	const game = createAttackPressureState();
	const selected = selectFinishFollowUpMove(listLegalMoves(game));

	assert.notEqual(selected, null);
	assert.equal(selected?.action, "attack");
});

test("overrides early end_turn before the pressure floor is met", () => {
	const legalMoves = listLegalMoves(
		createInitialState(1, undefined, ["a", "b"]),
	);

	const selected = resolveEarlyEndTurnOverride({
		chosenMove: { action: "end_turn" },
		legalMoves,
		actionsTakenThisTurn: 0,
		minActionsBeforeEndTurn: 1,
	});

	assert.notEqual(selected, null);
	assert.notEqual(selected?.action, "end_turn");
	assert.notEqual(selected?.action, "pass");
});

test("does not override end_turn after the pressure floor is met", () => {
	const legalMoves = listLegalMoves(
		createInitialState(1, undefined, ["a", "b"]),
	);

	const selected = resolveEarlyEndTurnOverride({
		chosenMove: { action: "end_turn" },
		legalMoves,
		actionsTakenThisTurn: 1,
		minActionsBeforeEndTurn: 1,
	});

	assert.equal(selected, null);
});

test("does not override non-terminal chosen moves", () => {
	const selected = resolveEarlyEndTurnOverride({
		chosenMove: { action: "pass" } as Move,
		legalMoves: [{ action: "pass" }, { action: "end_turn" }],
		actionsTakenThisTurn: 0,
		minActionsBeforeEndTurn: 1,
	});

	assert.equal(selected, null);
});
