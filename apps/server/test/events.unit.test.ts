import { initialState } from "@fightclaw/engine";
import { MatchEventEnvelopeSchema } from "@fightclaw/protocol";
import { describe, expect, it } from "vitest";
import {
	buildGameEndedAliasEvent,
	buildLiveMatchEndedEvent,
	buildLiveStateEvent,
	buildLiveYourTurnEvent,
	buildMatchEndedEvent,
	buildMatchFoundEvent,
	buildNoEventsEvent,
	buildStateEvent,
	buildYourTurnEvent,
} from "../src/protocol/events";
import { formatSse } from "../src/protocol/sse";

describe("event builders", () => {
	it("builds canonical match_found envelope", () => {
		const event = buildMatchFoundEvent({
			eventId: 7,
			ts: "2026-03-18T12:00:00.000Z",
			matchId: "match-1",
			opponentId: "agent-2",
		});
		expect(event.eventVersion).toBe(2);
		expect(event.eventId).toBe(7);
		expect(event.ts).toBe("2026-03-18T12:00:00.000Z");
		expect(event.event).toBe("match_found");
		expect(event.stateVersion).toBeNull();
		expect(event.payload).toEqual({ opponentId: "agent-2" });
		expect(MatchEventEnvelopeSchema.safeParse(event).success).toBe(true);
	});

	it("builds canonical match_ended envelope", () => {
		const event = buildMatchEndedEvent({
			eventId: 11,
			ts: "2026-03-18T12:01:00.000Z",
			matchId: "match-1",
			stateVersion: 4,
			winnerAgentId: "winner",
			loserAgentId: "loser",
			reason: "forfeit",
		});
		expect(event.eventVersion).toBe(2);
		expect(event.eventId).toBe(11);
		expect(event.event).toBe("match_ended");
		expect(event.stateVersion).toBe(4);
		expect(event.payload.reasonCode).toBe(event.payload.reason);
		expect(MatchEventEnvelopeSchema.safeParse(event).success).toBe(true);
	});

	it("builds game_ended alias from canonical payload", () => {
		const canonical = buildMatchEndedEvent({
			eventId: 12,
			ts: "2026-03-18T12:01:00.000Z",
			matchId: "match-1",
			stateVersion: 4,
			winnerAgentId: "winner",
			loserAgentId: "loser",
			reason: "forfeit",
		});
		const alias = buildGameEndedAliasEvent(canonical);
		expect(alias.event).toBe("game_ended");
		expect(alias.eventId).toBe(canonical.eventId);
		expect(alias.payload.reasonCode).toBe(alias.payload.reason);
		expect(MatchEventEnvelopeSchema.safeParse(alias).success).toBe(true);
	});

	it("builds canonical your_turn envelope", () => {
		const event = buildYourTurnEvent({
			eventId: 13,
			ts: "2026-03-18T12:01:30.000Z",
			matchId: "match-1",
			stateVersion: 3,
		});
		expect(event.eventVersion).toBe(2);
		expect(event.event).toBe("your_turn");
		expect(event.payload).toEqual({});
		expect(MatchEventEnvelopeSchema.safeParse(event).success).toBe(true);
	});

	it("builds canonical state envelope", () => {
		const state = initialState(1, ["a", "b"]);
		const event = buildStateEvent({
			eventId: 14,
			ts: "2026-03-18T12:02:00.000Z",
			matchId: "match-1",
			stateVersion: 1,
			state,
		});
		expect(event.eventVersion).toBe(2);
		expect(event.event).toBe("state");
		expect(event.payload).toEqual({ state });
		expect(MatchEventEnvelopeSchema.safeParse(event).success).toBe(true);
	});

	it("builds live state snapshots without advancing replay cursor", () => {
		const state = initialState(1, ["a", "b"]);
		const event = buildLiveStateEvent({
			ts: "2026-03-18T12:02:30.000Z",
			matchId: "match-1",
			stateVersion: 1,
			state,
		});
		expect(event.eventId).toBe(0);
		expect(event.event).toBe("state");
		expect(MatchEventEnvelopeSchema.safeParse(event).success).toBe(true);
	});

	it("builds live your_turn snapshots without advancing replay cursor", () => {
		const event = buildLiveYourTurnEvent({
			ts: "2026-03-18T12:02:45.000Z",
			matchId: "match-1",
			stateVersion: 2,
		});
		expect(event.eventId).toBe(0);
		expect(event.event).toBe("your_turn");
		expect(MatchEventEnvelopeSchema.safeParse(event).success).toBe(true);
	});

	it("builds live terminal snapshots without advancing replay cursor", () => {
		const event = buildLiveMatchEndedEvent({
			ts: "2026-03-18T12:03:00.000Z",
			matchId: "match-1",
			stateVersion: 4,
			winnerAgentId: "winner",
			loserAgentId: "loser",
			reason: "terminal",
		});
		expect(event.eventId).toBe(0);
		expect(event.event).toBe("match_ended");
		expect(MatchEventEnvelopeSchema.safeParse(event).success).toBe(true);
	});

	it("builds canonical no_events envelope", () => {
		const event = buildNoEventsEvent({
			eventId: 0,
			ts: "2026-03-18T12:03:00.000Z",
			matchId: null,
		});
		expect(event.eventVersion).toBe(2);
		expect(event.event).toBe("no_events");
		expect(event.payload).toEqual({});
		expect(MatchEventEnvelopeSchema.safeParse(event).success).toBe(true);
	});
});

describe("sse format", () => {
	it("formats event frames", () => {
		const payload = { ok: true };
		const frame = formatSse("game_ended", payload);
		expect(frame).toContain("event: game_ended");
		expect(frame).toContain(`data: ${JSON.stringify(payload)}`);
		expect(frame.endsWith("\n\n")).toBe(true);
	});
});
