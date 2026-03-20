import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	authHeader,
	createAgent,
	ensureResetDb,
	resetDb,
	runnerHeaders,
} from "../helpers";

type RuntimeEvent = {
	type: string;
	ts: number;
};

type MatchRuntimeSummary = {
	kind: "match";
	id: string | null;
	status: "active" | "ended" | null;
	hasAlarm: boolean;
	turnExpiresAtMs: number | null;
	spectatorStreams: number;
	agentStreams: number;
	pendingWaitUntilTasks: number;
	recentEvents: RuntimeEvent[];
};

type MatchmakerRuntimeSummary = {
	kind: "matchmaker";
	id: string | null;
	queueSize: number;
	waiterCount: number;
	pendingWaitUntilTasks: number;
	recentEvents: RuntimeEvent[];
};

type RuntimePayload = {
	ok: true;
	matchmakers: MatchmakerRuntimeSummary[];
	matches: MatchRuntimeSummary[];
};

const getRuntimeDiagnostics = async () => {
	const res = await SELF.fetch(
		"https://example.com/v1/internal/__test__/runtime",
		{
			headers: runnerHeaders(),
		},
	);
	expect(res.status).toBe(200);
	return (await res.json()) as RuntimePayload;
};

beforeEach(async () => {
	await resetDb();
});

afterEach(async () => {
	try {
		await resetDb();
	} finally {
		await ensureResetDb();
	}
});

it("returns aggregate runtime diagnostics in TEST_MODE", async () => {
	const payload = await getRuntimeDiagnostics();

	expect(payload.ok).toBe(true);
	expect(Array.isArray(payload.matchmakers)).toBe(true);
	expect(Array.isArray(payload.matches)).toBe(true);
	expect(payload.matchmakers[0]).toMatchObject({
		kind: "matchmaker",
		pendingWaitUntilTasks: 0,
	});
});

it("reports active match alarms without live streams", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");

	await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const join = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const joinJson = (await join.json()) as { matchId: string };

	const payload = await getRuntimeDiagnostics();
	const match = payload.matches.find((entry) => entry.id === joinJson.matchId);

	expect(match).toMatchObject({
		kind: "match",
		id: joinJson.matchId,
		status: "active",
		hasAlarm: true,
		spectatorStreams: 0,
		agentStreams: 0,
		pendingWaitUntilTasks: 0,
	});
	expect(typeof match?.turnExpiresAtMs).toBe("number");
});

it("shows the removed ws path does not attach streams or pending work", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");

	await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const join = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const joinJson = (await join.json()) as { matchId: string };

	const noUpgrade = await SELF.fetch(
		`https://example.com/v1/matches/${joinJson.matchId}/ws`,
		{
			headers: authHeader(agentA.key),
		},
	);
	expect(noUpgrade.status).toBe(404);
	await noUpgrade.text();

	const payload = await getRuntimeDiagnostics();
	const match = payload.matches.find((entry) => entry.id === joinJson.matchId);

	expect(match).toBeTruthy();
	expect(match?.hasAlarm).toBe(true);
	expect(match?.spectatorStreams).toBe(0);
	expect(match?.agentStreams).toBe(0);
	expect(match?.pendingWaitUntilTasks).toBe(0);
	expect(
		match?.recentEvents.some((entry) => entry.type === "stream_attached"),
	).toBe(false);
	expect(
		match?.recentEvents.some((entry) => entry.type === "wait_until_scheduled"),
	).toBe(false);
});
