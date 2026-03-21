import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createInitialState,
	listLegalMoves,
	type Move,
} from "@fightclaw/engine";
import { createMoveProvider } from "../src/cli";

const createStateResponse = (args?: {
	game?: ReturnType<typeof createInitialState>;
	turnExpiresAtMs?: number;
}) => ({
	state: {
		stateVersion: 1,
		status: "active" as const,
		game:
			args?.game ?? createInitialState(1, undefined, ["agent-a", "agent-b"]),
	},
	...(typeof args?.turnExpiresAtMs === "number"
		? { turnExpiresAtMs: args.turnExpiresAtMs }
		: {}),
});

const createTestContextStore = () =>
	({
		buildTurnContext: async () => undefined,
	}) as never;

test("SSE cache hit: skips getMatchState when lastKnownGame is provided", async () => {
	let httpFetchCount = 0;
	const game = createInitialState(1, undefined, ["agent-a", "agent-b"]);
	const legalMoves = listLegalMoves(game);
	const firstLegal = legalMoves[0];
	assert.ok(firstLegal);

	const client = {
		getMatchState: async () => {
			httpFetchCount += 1;
			return createStateResponse({ game });
		},
	} as never;

	const provider = createMoveProvider(
		client,
		"agent-a",
		"Agent A",
		"strategy",
		createTestContextStore(),
		"fake-gateway",
		{
			invokeGatewayImpl: async () => ({
				move: firstLegal,
				publicThought: "Good move.",
			}),
		},
	);

	await provider.nextMove({
		matchId: "match-1",
		stateVersion: 1,
		lastKnownGame: game,
		lastKnownGameVersion: 1,
	});

	assert.equal(
		httpFetchCount,
		0,
		"Should not call getMatchState when SSE cache is fresh",
	);
});

test("SSE cache miss: falls back to HTTP when version mismatches", async () => {
	let httpFetchCount = 0;
	const game = createInitialState(1, undefined, ["agent-a", "agent-b"]);
	const legalMoves = listLegalMoves(game);
	const firstLegal = legalMoves[0];
	assert.ok(firstLegal);

	const client = {
		getMatchState: async () => {
			httpFetchCount += 1;
			return createStateResponse({ game });
		},
	} as never;

	const provider = createMoveProvider(
		client,
		"agent-a",
		"Agent A",
		"strategy",
		createTestContextStore(),
		"fake-gateway",
		{
			invokeGatewayImpl: async () => ({
				move: firstLegal,
				publicThought: "Good move.",
			}),
		},
	);

	await provider.nextMove({
		matchId: "match-1",
		stateVersion: 2,
		lastKnownGame: game,
		lastKnownGameVersion: 1,
	});

	assert.equal(
		httpFetchCount,
		1,
		"Should call getMatchState when SSE cache version mismatches",
	);
});

test("SSE cache absent: falls back to HTTP when no cached state", async () => {
	let httpFetchCount = 0;
	const game = createInitialState(1, undefined, ["agent-a", "agent-b"]);
	const legalMoves = listLegalMoves(game);
	const firstLegal = legalMoves[0];
	assert.ok(firstLegal);

	const client = {
		getMatchState: async () => {
			httpFetchCount += 1;
			return createStateResponse({ game });
		},
	} as never;

	const provider = createMoveProvider(
		client,
		"agent-a",
		"Agent A",
		"strategy",
		createTestContextStore(),
		"fake-gateway",
		{
			invokeGatewayImpl: async () => ({
				move: firstLegal,
				publicThought: "Good move.",
			}),
		},
	);

	await provider.nextMove({
		matchId: "match-1",
		stateVersion: 1,
	});

	assert.equal(
		httpFetchCount,
		1,
		"Should call getMatchState when no SSE cache",
	);
});

test("SSE cache: second action in turn falls back to HTTP (version advanced)", async () => {
	let httpFetchCount = 0;
	const game = createInitialState(1, undefined, ["agent-a", "agent-b"]);
	const legalMoves = listLegalMoves(game);
	const firstLegal = legalMoves[0];
	assert.ok(firstLegal);

	const client = {
		getMatchState: async () => {
			httpFetchCount += 1;
			return createStateResponse({ game });
		},
	} as never;

	const provider = createMoveProvider(
		client,
		"agent-a",
		"Agent A",
		"strategy",
		createTestContextStore(),
		"fake-gateway",
		{
			invokeGatewayImpl: async () => ({
				move: firstLegal,
				publicThought: "Good move.",
			}),
		},
	);

	// First action: SSE cache hit
	await provider.nextMove({
		matchId: "match-1",
		stateVersion: 1,
		lastKnownGame: game,
		lastKnownGameVersion: 1,
	});
	assert.equal(httpFetchCount, 0, "First action should use SSE cache");

	// Second action: version advanced, cache stale
	await provider.nextMove({
		matchId: "match-1",
		stateVersion: 2,
		lastKnownGame: game,
		lastKnownGameVersion: 1,
	});
	assert.equal(httpFetchCount, 1, "Second action should fall back to HTTP");
});

test("parallel fetch: context build failure does not prevent move selection", async () => {
	const game = createInitialState(1, undefined, ["agent-a", "agent-b"]);
	const legalMoves = listLegalMoves(game);
	const firstLegal = legalMoves[0];
	assert.ok(firstLegal);

	const client = {
		getMatchState: async () => createStateResponse({ game }),
	} as never;

	const failingContextStore = {
		buildTurnContext: async () => {
			throw new Error("Context build failed");
		},
	} as never;

	const provider = createMoveProvider(
		client,
		"agent-a",
		"Agent A",
		"strategy",
		failingContextStore,
		"fake-gateway",
		{
			invokeGatewayImpl: async (
				_cmd: string,
				input: Record<string, unknown>,
			) => {
				assert.equal(
					input.turnContext,
					undefined,
					"turnContext should be undefined when build fails",
				);
				return {
					move: firstLegal,
					publicThought: "Good move.",
				};
			},
		},
	);

	const move = await provider.nextMove({
		matchId: "match-1",
		stateVersion: 1,
	});

	assert.ok(
		move,
		"Move should still be selected despite context build failure",
	);
});
