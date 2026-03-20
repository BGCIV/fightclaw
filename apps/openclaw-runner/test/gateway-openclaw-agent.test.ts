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

test("gateway-openclaw-agent prompt adds finish pressure guidance only when requested", () => {
	const state = createInitialState(3, undefined, ["agent-a", "agent-b"]);
	const legalMoves = listLegalMoves(state);

	const withoutFinishOverlay = buildPrompt({
		agentId: "agent-a",
		agentName: "Kai",
		matchId: "match-plain",
		stateVersion: 5,
		state,
		legalMoves,
	});
	const withFinishOverlay = buildPrompt({
		agentId: "agent-a",
		agentName: "Kai",
		matchId: "match-finish",
		stateVersion: 5,
		state,
		legalMoves,
		finishOverlay: true,
	});

	assert.doesNotMatch(
		withoutFinishOverlay,
		/legal attack or decisive follow-up/i,
	);
	assert.match(withFinishOverlay, /legal attack or decisive follow-up/i);
	assert.match(
		withFinishOverlay,
		/Prefer a legal terminal or high-pressure line/i,
	);
});

test("gateway-openclaw-agent prompt carries strategy focus and explicit finish pressure guidance", () => {
	const state = createInitialState(3, undefined, ["agent-a", "agent-b"]);
	const legalMoves = listLegalMoves(state);
	const prompt = buildPrompt({
		agentId: "agent-a",
		agentName: "Kai",
		matchId: "match-456",
		stateVersion: 9,
		state,
		legalMoves,
		strategyDirective:
			"Contest crowns and income nodes early, then turn the edge into stronger stronghold pressure.",
	});

	assert.match(prompt, /strategyDirective=/);
	assert.match(prompt, /Contest crowns and income nodes early/i);
	assert.match(prompt, /terminal line/i);
	assert.match(prompt, /do not choose end_turn/i);
});
