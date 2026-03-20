import assert from "node:assert/strict";
import test from "node:test";
import { MatchContextStore } from "../src/match-context";

type LogEvent = {
	id: number;
	matchId: string;
	turn: number;
	ts: string;
	eventType: string;
	payload: unknown;
};

type FetchCall = {
	input: RequestInfo | URL;
	init?: RequestInit;
};

const getHeader = (
	headers: HeadersInit | undefined,
	name: string,
): string | undefined => {
	if (!headers) return undefined;
	if (headers instanceof Headers) {
		return headers.get(name) ?? undefined;
	}
	if (Array.isArray(headers)) {
		const pair = headers.find(
			([key]) => key.toLowerCase() === name.toLowerCase(),
		);
		return pair?.[1];
	}
	const match = Object.entries(headers).find(
		([key]) => key.toLowerCase() === name.toLowerCase(),
	);
	return match?.[1];
};

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
		},
	});

const createLogResponse = (matchId: string, events: LogEvent[]): Response =>
	jsonResponse({
		matchId,
		events,
	});

test("incrementally ingests match log and builds own/enemy turn context", async () => {
	const matchId = "2a9922c5-57ca-42ac-8b02-bf7ea71b4e95";
	const fetchCalls: FetchCall[] = [];
	const fetchImpl = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		fetchCalls.push({ input, init });
		const url = String(input);
		if (url.includes("afterId=0")) {
			return createLogResponse(matchId, [
				{
					id: 1,
					matchId,
					turn: 3,
					ts: "2026-02-22T08:00:00.000Z",
					eventType: "move_applied",
					payload: {
						agentId: "agent-a",
						moveId: "m-a-1",
						stateVersion: 11,
						ts: "2026-02-22T08:00:00.000Z",
					},
				},
				{
					id: 2,
					matchId,
					turn: 3,
					ts: "2026-02-22T08:00:01.000Z",
					eventType: "agent_thought",
					payload: {
						agentId: "agent-a",
						moveId: "m-a-1",
						stateVersion: 11,
						text: "Keep pressure mid-lane.",
						ts: "2026-02-22T08:00:01.000Z",
					},
				},
			]);
		}
		if (url.includes("afterId=2")) {
			return createLogResponse(matchId, [
				{
					id: 3,
					matchId,
					turn: 3,
					ts: "2026-02-22T08:00:05.000Z",
					eventType: "move_applied",
					payload: {
						agentId: "agent-b",
						moveId: "m-b-1",
						stateVersion: 12,
						ts: "2026-02-22T08:00:05.000Z",
					},
				},
				{
					id: 4,
					matchId,
					turn: 3,
					ts: "2026-02-22T08:00:06.000Z",
					eventType: "agent_thought",
					payload: {
						agentId: "agent-b",
						moveId: "m-b-1",
						stateVersion: 12,
						text: "Defending flank.",
						ts: "2026-02-22T08:00:06.000Z",
					},
				},
			]);
		}
		return createLogResponse(matchId, []);
	};

	const store = new MatchContextStore({
		baseUrl: "http://127.0.0.1:3000",
		adminKey: "test-admin",
		fetchImpl,
		logPageLimit: 50,
		recentLimit: 5,
	});

	const first = await store.buildTurnContext({
		matchId,
		agentId: "agent-a",
		state: {
			state: {
				game: {
					turn: 3,
					actionsRemaining: 4,
				},
			},
		},
	});

	assert.equal(first.current?.turn, 3);
	assert.equal(first.current?.actionsRemaining, 4);
	assert.deepEqual(first.recentOwnMoves, [
		{
			turn: 3,
			stateVersion: 11,
			moveId: "m-a-1",
			timestamp: "2026-02-22T08:00:00.000Z",
		},
	]);
	assert.deepEqual(first.recentEnemyMoves, []);
	assert.deepEqual(first.recentOwnThoughts, [
		{
			turn: 3,
			stateVersion: 11,
			moveId: "m-a-1",
			timestamp: "2026-02-22T08:00:01.000Z",
			text: "Keep pressure mid-lane.",
		},
	]);
	assert.deepEqual(first.recentEnemyThoughts, []);

	const second = await store.buildTurnContext({
		matchId,
		agentId: "agent-a",
		state: {
			state: {
				game: {
					turn: 4,
					actionsRemaining: 5,
				},
			},
		},
	});

	assert.equal(second.current?.turn, 4);
	assert.equal(second.current?.actionsRemaining, 5);
	assert.deepEqual(second.recentOwnMoves, [
		{
			turn: 3,
			stateVersion: 11,
			moveId: "m-a-1",
			timestamp: "2026-02-22T08:00:00.000Z",
		},
	]);
	assert.deepEqual(second.recentEnemyMoves, [
		{
			turn: 3,
			stateVersion: 12,
			moveId: "m-b-1",
			timestamp: "2026-02-22T08:00:05.000Z",
		},
	]);
	assert.deepEqual(second.recentOwnThoughts, [
		{
			turn: 3,
			stateVersion: 11,
			moveId: "m-a-1",
			timestamp: "2026-02-22T08:00:01.000Z",
			text: "Keep pressure mid-lane.",
		},
	]);
	assert.deepEqual(second.recentEnemyThoughts, [
		{
			turn: 3,
			stateVersion: 12,
			moveId: "m-b-1",
			timestamp: "2026-02-22T08:00:06.000Z",
			text: "Defending flank.",
		},
	]);

	assert.equal(fetchCalls.length, 2);
	assert.match(String(fetchCalls[0]?.input), /afterId=0/);
	assert.match(String(fetchCalls[1]?.input), /afterId=2/);
	assert.equal(
		getHeader(fetchCalls[0]?.init?.headers, "x-admin-key"),
		"test-admin",
	);
});

test("keeps prior context when log fetch fails", async () => {
	const matchId = "17f8da76-1f2d-48ec-86f9-abd33e4ec7f8";
	let fetchCount = 0;
	const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
		fetchCount += 1;
		if (fetchCount === 1) {
			return createLogResponse(matchId, [
				{
					id: 9,
					matchId,
					turn: 7,
					ts: "2026-02-22T09:00:00.000Z",
					eventType: "move_applied",
					payload: {
						agentId: "agent-a",
						moveId: "m-a-9",
						stateVersion: 99,
						ts: "2026-02-22T09:00:00.000Z",
					},
				},
			]);
		}
		if (String(input).includes("afterId=9")) {
			throw new Error("network broke");
		}
		return createLogResponse(matchId, []);
	};

	const store = new MatchContextStore({
		baseUrl: "http://127.0.0.1:3000",
		adminKey: "test-admin",
		fetchImpl,
	});

	const first = await store.buildTurnContext({
		matchId,
		agentId: "agent-a",
	});
	assert.equal(first.recentOwnMoves.length, 1);

	const second = await store.buildTurnContext({
		matchId,
		agentId: "agent-a",
		state: {
			state: {
				game: {
					turn: 8,
				},
			},
		},
	});

	assert.equal(second.current?.turn, 8);
	assert.equal(second.recentOwnMoves.length, 1);
	assert.equal(second.recentOwnMoves[0]?.moveId, "m-a-9");
	assert.equal(second.recentEnemyMoves.length, 0);
});
