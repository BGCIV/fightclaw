import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, type Move } from "@fightclaw/engine";
import { createMoveProvider } from "../src/cli";

const createTestClient = () => {
	const game = createInitialState(1, undefined, ["agent-a", "agent-b"]);
	return {
		getMatchState: async () => ({
			state: {
				game,
			},
		}),
	} as never;
};

const createTestContextStore = () =>
	({
		buildTurnContext: async () => undefined,
	}) as never;

test("cli move provider falls back when the gateway returns an illegal move", async () => {
	const provider = createMoveProvider(
		createTestClient(),
		"agent-a",
		"Agent A",
		"Finish strong.",
		createTestContextStore(),
		"fake-gateway",
		{
			invokeGatewayImpl: async () => ({
				move: { action: "attack", unitId: "A-1", target: "Z99" } as Move,
				publicThought: "Illegal attack.",
			}),
		},
	);

	const move = await provider.nextMove({
		matchId: "match-1",
		stateVersion: 1,
	});

	assert.notEqual(move.action, "pass");
	assert.notEqual(move.action, "end_turn");
	assert.equal(
		move.reasoning,
		"Public-safe fallback: selected a clearly legal move.",
	);
});

test("cli move provider counts a fallback action before honoring a later end_turn", async () => {
	let callCount = 0;
	const provider = createMoveProvider(
		createTestClient(),
		"agent-a",
		"Agent A",
		"Finish strong.",
		createTestContextStore(),
		"fake-gateway",
		{
			invokeGatewayImpl: async () => {
				callCount += 1;
				if (callCount === 1) {
					throw new Error("Gateway timeout");
				}
				return {
					move: { action: "end_turn" },
					publicThought: "Closing turn.",
				};
			},
		},
	);

	const firstMove = await provider.nextMove({
		matchId: "match-1",
		stateVersion: 1,
	});
	const secondMove = await provider.nextMove({
		matchId: "match-1",
		stateVersion: 2,
	});

	assert.notEqual(firstMove.action, "end_turn");
	assert.equal(secondMove.action, "end_turn");
	assert.equal(secondMove.reasoning, "Closing turn.");
});
