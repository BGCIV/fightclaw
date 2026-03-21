import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createInitialState,
	listLegalMoves,
	type Move,
} from "@fightclaw/engine";
import { selectPreferredLegalFallbackMove } from "../src/legalFallback";

test("prefers a clearly legal non-terminal move over pass-style fallback", () => {
	const game = createInitialState(1, undefined, ["agent-a", "agent-b"]);
	const legalMoves = listLegalMoves(game);

	const selected = selectPreferredLegalFallbackMove(legalMoves);

	assert.notEqual(selected, null);
	assert.notEqual(selected?.action, "end_turn");
	assert.notEqual(selected?.action, "pass");
});

test("prefers end_turn over pass when no non-terminal move exists", () => {
	const legalMoves: Move[] = [{ action: "pass" }, { action: "end_turn" }];

	const selected = selectPreferredLegalFallbackMove(legalMoves);

	assert.deepEqual(selected, { action: "end_turn" });
});

test("falls back to pass when it is the only legal move", () => {
	const legalMoves: Move[] = [{ action: "pass" }];

	const selected = selectPreferredLegalFallbackMove(legalMoves);

	assert.deepEqual(selected, { action: "pass" });
});
