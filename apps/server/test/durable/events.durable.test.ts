import { SELF } from "cloudflare:test";
import { MatchEventEnvelopeSchema } from "@fightclaw/protocol";
import { beforeEach, expect, it } from "vitest";
import { authHeader, createAgent, resetDb } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

it("delivers match_found to both agents via events wait", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");

	await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentA.key),
	});

	const waitA = SELF.fetch("https://example.com/v1/events/wait?timeout=5", {
		headers: authHeader(agentA.key),
	});
	const waitB = SELF.fetch("https://example.com/v1/events/wait?timeout=5", {
		headers: authHeader(agentB.key),
	});

	const second = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const secondJson = (await second.json()) as { matchId: string };

	const waitResA = await waitA;
	const waitResB = await waitB;
	expect(waitResA.status).toBe(200);
	expect(waitResB.status).toBe(200);

	const payloadA = (await waitResA.json()) as { events: unknown[] };
	const payloadB = (await waitResB.json()) as { events: unknown[] };
	const eventA = MatchEventEnvelopeSchema.parse(payloadA.events[0]);
	const eventB = MatchEventEnvelopeSchema.parse(payloadB.events[0]);
	if (!eventA || !eventB) throw new Error("Missing match_found event.");

	expect(eventA.event).toBe("match_found");
	expect(eventB.event).toBe("match_found");
	expect(eventA.matchId).toBe(secondJson.matchId);
	expect(eventB.matchId).toBe(secondJson.matchId);
	if (eventA.event !== "match_found" || eventB.event !== "match_found") {
		throw new Error("Expected match_found events.");
	}
	expect(eventA.payload.opponentId).toBe(agentB.id);
	expect(eventB.payload.opponentId).toBe(agentA.id);
});
