import { describe, expect, test } from "bun:test";
import { createInitialState } from "@fightclaw/engine";
import type { EngineEventsEvent, MatchEndedEvent } from "@fightclaw/protocol";

import {
	buildSpectatorDeskProjection,
	projectBroadcastTickerItem,
} from "../src/lib/spectator-desk";

describe("spectator desk projections", () => {
	test("ignores engine events with an invalid move payload", () => {
		const event: EngineEventsEvent = {
			eventVersion: 2,
			eventId: 17,
			ts: "2026-03-19T12:00:00.000Z",
			matchId: "match-1",
			stateVersion: 9,
			event: "engine_events",
			payload: {
				agentId: "agent-a",
				moveId: "move-17",
				move: null,
				engineEvents: [],
			},
		};

		expect(projectBroadcastTickerItem(event)).toBeNull();
	});

	test("uses engine turn data for ticker items", () => {
		const event: EngineEventsEvent = {
			eventVersion: 2,
			eventId: 18,
			ts: "2026-03-19T12:00:02.000Z",
			matchId: "match-1",
			stateVersion: 9,
			event: "engine_events",
			payload: {
				agentId: "agent-a",
				moveId: "move-18",
				move: {
					action: "move",
					unitId: "u_a_1",
					to: "B2",
				},
				engineEvents: [
					{
						type: "move_unit",
						turn: 4,
						player: "A",
						unitId: "u_a_1",
						from: "A1",
						to: "B2",
					},
				],
			},
		};

		expect(projectBroadcastTickerItem(event)).toEqual({
			eventId: 18,
			ts: "2026-03-19T12:00:02.000Z",
			turn: 4,
			player: "A",
			text: "A advanced u_a_1 to B2",
			tone: "neutral",
		});
	});

	test("projects a final featured desk and winner summary from terminal state", () => {
		const state = createInitialState(7, undefined, ["Alpha", "Bravo"]);
		const terminalEvent: MatchEndedEvent = {
			eventVersion: 2,
			eventId: 43,
			ts: "2026-03-19T12:01:00.000Z",
			matchId: "match-2",
			stateVersion: 21,
			event: "match_ended",
			payload: {
				winnerAgentId: "Alpha",
				loserAgentId: "Bravo",
				reasonCode: "elimination",
			},
		};

		const projection = buildSpectatorDeskProjection({
			connectionStatus: "connecting",
			featured: {
				matchId: "match-2",
				status: "active",
				players: ["Alpha", "Bravo"],
			},
			state,
			thoughtsA: ["Hold center and keep pressure."],
			thoughtsB: [],
			tickerItems: [],
			terminalEvent,
		});

		expect(projection.featuredDesk.status).toBe("ended");
		expect(projection.featuredDesk.label).toBe("Featured final");
		expect(projection.agentCards.A.publicCommentary).toBe(
			"Hold center and keep pressure.",
		);
		expect(projection.resultSummary).toEqual({
			headline: "A wins",
			subtitle: "Elimination · B falls",
			winningSide: "A",
			reasonLabel: "Elimination",
		});
		expect(projection.topBarRightLabel).toBe("A wins");
	});
});
