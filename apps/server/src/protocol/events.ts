import type {
	AgentThoughtEvent,
	EngineEventsEvent,
	GameEndedEvent,
	MatchEndedEvent,
	MatchEventEnvelope,
	MatchFoundEvent,
	MatchStartedEvent,
	NoEventsEvent,
	StateEvent,
	YourTurnEvent,
} from "@fightclaw/protocol";
import { EVENT_VERSION } from "@fightclaw/protocol";

export { EVENT_VERSION };
export type {
	AgentThoughtEvent,
	EngineEventsEvent,
	GameEndedEvent,
	MatchEventEnvelope,
	MatchEndedEvent,
	MatchFoundEvent,
	MatchStartedEvent,
	NoEventsEvent,
	StateEvent,
	YourTurnEvent,
};

type StoredMatchEventRow = {
	eventId: number;
	matchId: string;
	ts: string;
	eventType: string;
	payload: unknown;
};

const LIVE_SNAPSHOT_EVENT_ID = 0;

const buildEnvelope = <
	TEvent extends MatchEventEnvelope["event"],
	TPayload extends Extract<MatchEventEnvelope, { event: TEvent }>["payload"],
>(input: {
	eventId: number;
	ts: string;
	matchId: string | null;
	stateVersion: number | null;
	event: TEvent;
	payload: TPayload;
}): Extract<MatchEventEnvelope, { event: TEvent }> =>
	({
		eventVersion: EVENT_VERSION,
		eventId: input.eventId,
		ts: input.ts,
		matchId: input.matchId,
		stateVersion: input.stateVersion,
		event: input.event,
		payload: input.payload,
	}) as Extract<MatchEventEnvelope, { event: TEvent }>;

export const buildMatchStartedEvent = (input: {
	eventId: number;
	ts: string;
	matchId: string;
	stateVersion: number;
	players: string[];
	seed: number;
	engineConfig: unknown;
	mode?: string;
}): MatchStartedEvent =>
	buildEnvelope({
		eventId: input.eventId,
		ts: input.ts,
		matchId: input.matchId,
		stateVersion: input.stateVersion,
		event: "match_started",
		payload: {
			players: input.players,
			seed: input.seed,
			engineConfig: input.engineConfig,
			...(input.mode ? { mode: input.mode } : {}),
		},
	});

export const buildMatchFoundEvent = (input: {
	eventId: number;
	ts: string;
	matchId: string;
	opponentId?: string;
}): MatchFoundEvent => ({
	...buildEnvelope({
		eventId: input.eventId,
		ts: input.ts,
		matchId: input.matchId,
		stateVersion: null,
		event: "match_found",
		payload: {
			...(input.opponentId ? { opponentId: input.opponentId } : {}),
		},
	}),
});

export const buildYourTurnEvent = (input: {
	eventId: number;
	ts: string;
	matchId: string;
	stateVersion: number;
}): YourTurnEvent => ({
	...buildEnvelope({
		eventId: input.eventId,
		ts: input.ts,
		matchId: input.matchId,
		stateVersion: input.stateVersion,
		event: "your_turn",
		payload: {},
	}),
});

export const buildLiveYourTurnEvent = (
	input: Omit<Parameters<typeof buildYourTurnEvent>[0], "eventId">,
): YourTurnEvent =>
	buildYourTurnEvent({
		eventId: LIVE_SNAPSHOT_EVENT_ID,
		...input,
	});

export const buildStateEvent = (input: {
	eventId: number;
	ts: string;
	matchId: string;
	stateVersion: number;
	state: unknown;
}): StateEvent => ({
	...buildEnvelope({
		eventId: input.eventId,
		ts: input.ts,
		matchId: input.matchId,
		stateVersion: input.stateVersion,
		event: "state",
		payload: {
			state: input.state,
		},
	}),
});

export const buildLiveStateEvent = (
	input: Omit<Parameters<typeof buildStateEvent>[0], "eventId">,
): StateEvent =>
	buildStateEvent({
		eventId: LIVE_SNAPSHOT_EVENT_ID,
		...input,
	});

export const buildEngineEventsEvent = (input: {
	eventId: number;
	ts: string;
	matchId: string;
	stateVersion: number;
	agentId: string;
	moveId: string;
	move: unknown;
	engineEvents: unknown[];
}): EngineEventsEvent => ({
	...buildEnvelope({
		eventId: input.eventId,
		ts: input.ts,
		matchId: input.matchId,
		stateVersion: input.stateVersion,
		event: "engine_events",
		payload: {
			agentId: input.agentId,
			moveId: input.moveId,
			move: input.move,
			engineEvents: input.engineEvents,
		},
	}),
});

export const buildAgentThoughtEvent = (input: {
	eventId: number;
	ts: string;
	matchId: string;
	stateVersion: number;
	player: AgentThoughtEvent["payload"]["player"];
	agentId: string;
	moveId: string;
	text: string;
}): AgentThoughtEvent => ({
	...buildEnvelope({
		eventId: input.eventId,
		ts: input.ts,
		matchId: input.matchId,
		stateVersion: input.stateVersion,
		event: "agent_thought",
		payload: {
			player: input.player,
			agentId: input.agentId,
			moveId: input.moveId,
			text: input.text,
		},
	}),
});

export const buildMatchEndedEvent = (input: {
	eventId: number;
	ts: string;
	matchId: string;
	stateVersion: number | null;
	winnerAgentId: MatchEndedEvent["payload"]["winnerAgentId"];
	loserAgentId: MatchEndedEvent["payload"]["loserAgentId"];
	reason: string;
}): MatchEndedEvent => ({
	...buildEnvelope({
		eventId: input.eventId,
		ts: input.ts,
		matchId: input.matchId,
		stateVersion: input.stateVersion,
		event: "match_ended",
		payload: {
			winnerAgentId: input.winnerAgentId,
			loserAgentId: input.loserAgentId,
			reason: input.reason,
			reasonCode: input.reason,
		},
	}),
});

export const buildLiveMatchEndedEvent = (
	input: Omit<Parameters<typeof buildMatchEndedEvent>[0], "eventId">,
): MatchEndedEvent =>
	buildMatchEndedEvent({
		eventId: LIVE_SNAPSHOT_EVENT_ID,
		...input,
	});

export const buildGameEndedAliasEvent = (
	matchEnded: MatchEndedEvent,
): GameEndedEvent => ({
	...matchEnded,
	event: "game_ended",
});

export const buildNoEventsEvent = (input: {
	eventId: number;
	ts: string;
	matchId?: string | null;
}): NoEventsEvent => ({
	...buildEnvelope({
		eventId: input.eventId,
		ts: input.ts,
		matchId: input.matchId ?? null,
		stateVersion: null,
		event: "no_events",
		payload: {},
	}),
});

const asRecord = (value: unknown): Record<string, unknown> | null => {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
};

const asOptionalNumber = (value: unknown): number | null => {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const asOptionalString = (value: unknown): string | undefined => {
	return typeof value === "string" ? value : undefined;
};

export const buildStoredMatchEventEnvelope = (
	row: StoredMatchEventRow,
): MatchEventEnvelope | null => {
	const payload = asRecord(row.payload);
	switch (row.eventType) {
		case "match_started": {
			const players = Array.isArray(payload?.players)
				? payload.players.filter(
						(value): value is string => typeof value === "string",
					)
				: [];
			const seed = asOptionalNumber(payload?.seed);
			const stateVersion = asOptionalNumber(payload?.stateVersion) ?? 0;
			if (players.length !== 2 || seed === null) return null;
			return buildMatchStartedEvent({
				eventId: row.eventId,
				ts: row.ts,
				matchId: row.matchId,
				stateVersion,
				players,
				seed,
				engineConfig: payload?.engineConfig ?? null,
				mode: asOptionalString(payload?.mode),
			});
		}
		case "move_applied": {
			const stateVersion = asOptionalNumber(payload?.stateVersion);
			const agentId = asOptionalString(payload?.agentId);
			const moveId = asOptionalString(payload?.moveId);
			if (stateVersion === null || !agentId || !moveId) return null;
			return buildEngineEventsEvent({
				eventId: row.eventId,
				ts: row.ts,
				matchId: row.matchId,
				stateVersion,
				agentId,
				moveId,
				move: payload?.move ?? null,
				engineEvents: Array.isArray(payload?.engineEvents)
					? payload.engineEvents
					: [],
			});
		}
		case "agent_thought": {
			const stateVersion = asOptionalNumber(payload?.stateVersion);
			const player = payload?.player;
			const agentId = asOptionalString(payload?.agentId);
			const moveId = asOptionalString(payload?.moveId);
			const text = asOptionalString(payload?.text);
			if (
				stateVersion === null ||
				(player !== "A" && player !== "B") ||
				!agentId ||
				!moveId ||
				!text
			) {
				return null;
			}
			return buildAgentThoughtEvent({
				eventId: row.eventId,
				ts: row.ts,
				matchId: row.matchId,
				stateVersion,
				player,
				agentId,
				moveId,
				text,
			});
		}
		case "match_ended": {
			return buildMatchEndedEvent({
				eventId: row.eventId,
				ts: row.ts,
				matchId: row.matchId,
				stateVersion: asOptionalNumber(payload?.stateVersion),
				winnerAgentId:
					typeof payload?.winnerAgentId === "string" ||
					payload?.winnerAgentId === null
						? payload.winnerAgentId
						: null,
				loserAgentId:
					typeof payload?.loserAgentId === "string" ||
					payload?.loserAgentId === null
						? payload.loserAgentId
						: null,
				reason: asOptionalString(payload?.reason) ?? "ended",
			});
		}
		default:
			return null;
	}
};
