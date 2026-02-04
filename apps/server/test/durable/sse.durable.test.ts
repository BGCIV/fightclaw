import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { authHeader, createAgent, readSseUntil, resetDb } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

it("sends your_turn only to active agent", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");

	const first = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const firstJson = (await first.json()) as { matchId: string };

	const second = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const secondJson = (await second.json()) as { matchId: string };

	const matchId = secondJson.matchId ?? firstJson.matchId;

	const controllerA = new AbortController();
	const controllerB = new AbortController();
	const streamA = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/stream`,
		{
			headers: authHeader(agentA.key),
			signal: controllerA.signal,
		},
	);
	const streamB = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/stream`,
		{
			headers: authHeader(agentB.key),
			signal: controllerB.signal,
		},
	);

	const textA = await readSseUntil(streamA, (text) =>
		text.includes("event: your_turn"),
	);
	const textB = await readSseUntil(streamB, (text) =>
		text.includes("event: your_turn"),
	);
	controllerA.abort();
	controllerB.abort();

	expect(textA).toContain("event: your_turn");
	expect(textB).not.toContain("event: your_turn");
});

it("emits game_ended event name", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");

	const first = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const firstJson = (await first.json()) as { matchId: string };

	const second = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const secondJson = (await second.json()) as { matchId: string };

	const matchId = secondJson.matchId ?? firstJson.matchId;

	const controller = new AbortController();
	const stream = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/spectate`,
		{
			signal: controller.signal,
		},
	);

	await SELF.fetch(`https://example.com/v1/matches/${matchId}/finish`, {
		method: "POST",
		headers: {
			...authHeader(agentA.key),
			"content-type": "application/json",
			"x-admin-key": env.ADMIN_KEY,
		},
		body: JSON.stringify({ reason: "forfeit" }),
	});

	const text = await readSseUntil(
		stream,
		(value) => value.includes("event: game_ended"),
		2000,
		8192,
	);
	controller.abort();
	expect(text).toContain("event: game_ended");
});
