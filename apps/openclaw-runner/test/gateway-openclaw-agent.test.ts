import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, listLegalMoves } from "@fightclaw/engine";
import {
	buildPrompt,
	resolveOpenClawBin,
} from "../scripts/gateway-openclaw-agent";

test("gateway-openclaw-agent defaults to the system openclaw binary unless overridden", () => {
	assert.equal(resolveOpenClawBin({}), "openclaw");
	assert.equal(
		resolveOpenClawBin({ OPENCLAW_BIN: "  /usr/local/bin/openclaw " }),
		"/usr/local/bin/openclaw",
	);
});

test("gateway-openclaw-agent prompt encodes bounded multi-action continuation rules", () => {
	const state = createInitialState(3, undefined, ["agent-a", "agent-b"]);
	const legalMoves = listLegalMoves(state);
	const firstMove = legalMoves[0];
	if (!firstMove) {
		throw new Error("Expected at least one legal move.");
	}
	const prompt = buildPrompt({
		agentId: "agent-a",
		agentName: "Kai",
		matchId: "match-123",
		stateVersion: 5,
		state,
		legalMoves,
		previousActionsThisTurn: [firstMove],
		turnActionIndex: 2,
		remainingActionBudget: 2,
	});

	assert.match(prompt, /Choose the best next legal move/i);
	assert.match(prompt, /Do not end the turn after one merely safe action/i);
	assert.match(prompt, /remainingActionBudget=2/);
	assert.match(prompt, /previousActionsThisTurn=/);
});
