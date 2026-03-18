import { z } from "zod";

export const EVENT_VERSION = 2 as const;
export const FEATURED_STREAM_VERSION = 1 as const;
export const PROTOCOL_VERSION = 5 as const;
export const CONTRACTS_VERSION = "2026-03-18.match-ended-only.v1" as const;
export const ENGINE_VERSION = "war_of_attrition_v2" as const;

export type PlayerSide = "A" | "B";

type MatchEventEnvelopeBase<
	TEvent extends string,
	TPayload extends Record<string, unknown>,
> = {
	eventVersion: typeof EVENT_VERSION;
	eventId: number;
	ts: string;
	matchId: string | null;
	stateVersion: number | null;
	event: TEvent;
	payload: TPayload;
};

export type MatchStartedEvent = MatchEventEnvelopeBase<
	"match_started",
	{
		players: string[];
		seed: number;
		engineConfig: unknown;
		mode?: string;
	}
>;

export type MatchFoundEvent = MatchEventEnvelopeBase<
	"match_found",
	{
		opponentId?: string;
	}
>;

export type YourTurnEvent = MatchEventEnvelopeBase<
	"your_turn",
	Record<string, never>
>;

export type StateEvent<TState = unknown> = MatchEventEnvelopeBase<
	"state",
	{
		state: TState;
	}
>;

export type EngineEventsEvent = MatchEventEnvelopeBase<
	"engine_events",
	{
		agentId: string;
		moveId: string;
		move: unknown;
		engineEvents: unknown[];
	}
>;

export type AgentThoughtEvent = MatchEventEnvelopeBase<
	"agent_thought",
	{
		player: PlayerSide;
		agentId: string;
		moveId: string;
		text: string;
	}
>;

type MatchEndedPayload = {
	winnerAgentId?: string | null;
	loserAgentId?: string | null;
	reason?: string;
	reasonCode?: string;
};

export type MatchEndedEvent = MatchEventEnvelopeBase<
	"match_ended",
	MatchEndedPayload
>;

export type ErrorEvent = MatchEventEnvelopeBase<
	"error",
	{
		error: string;
	}
>;

export type NoEventsEvent = MatchEventEnvelopeBase<
	"no_events",
	Record<string, never>
>;

export type MatchEventEnvelope =
	| MatchStartedEvent
	| MatchFoundEvent
	| YourTurnEvent
	| StateEvent
	| EngineEventsEvent
	| AgentThoughtEvent
	| MatchEndedEvent
	| ErrorEvent
	| NoEventsEvent;

export type FeaturedSnapshot = {
	matchId: string | null;
	status: "active" | null;
	players: string[] | null;
};

export type FeaturedStreamEnvelope = {
	streamVersion: typeof FEATURED_STREAM_VERSION;
	ts: string;
	event: "featured_snapshot";
	payload: FeaturedSnapshot;
};

export const MatchEventEnvelopeBaseSchema = z.object({
	eventVersion: z.literal(EVENT_VERSION),
	eventId: z.number().int(),
	ts: z.string(),
	matchId: z.string().nullable(),
	stateVersion: z.number().int().nullable(),
});

const EmptyPayloadSchema = z.object({}).strict();

export const MatchStartedEventSchema = MatchEventEnvelopeBaseSchema.extend({
	event: z.literal("match_started"),
	payload: z
		.object({
			players: z.array(z.string()),
			seed: z.number(),
			engineConfig: z.unknown(),
			mode: z.string().optional(),
		})
		.strict(),
});

export const MatchFoundEventSchema = MatchEventEnvelopeBaseSchema.extend({
	event: z.literal("match_found"),
	payload: z
		.object({
			opponentId: z.string().optional(),
		})
		.strict(),
});

export const YourTurnEventSchema = MatchEventEnvelopeBaseSchema.extend({
	event: z.literal("your_turn"),
	payload: EmptyPayloadSchema,
});

export const StateEventSchema = MatchEventEnvelopeBaseSchema.extend({
	event: z.literal("state"),
	payload: z
		.object({
			state: z.unknown(),
		})
		.strict(),
});

export const EngineEventsEventSchema = MatchEventEnvelopeBaseSchema.extend({
	event: z.literal("engine_events"),
	payload: z
		.object({
			agentId: z.string(),
			moveId: z.string(),
			move: z.unknown(),
			engineEvents: z.array(z.unknown()),
		})
		.strict(),
});

export const AgentThoughtEventSchema = MatchEventEnvelopeBaseSchema.extend({
	event: z.literal("agent_thought"),
	payload: z
		.object({
			player: z.enum(["A", "B"]),
			agentId: z.string(),
			moveId: z.string(),
			text: z.string(),
		})
		.strict(),
});

const MatchEndedPayloadSchema = z
	.object({
		winnerAgentId: z.string().nullable().optional(),
		loserAgentId: z.string().nullable().optional(),
		reason: z.string().optional(),
		reasonCode: z.string().optional(),
	})
	.strict();

export const MatchEndedEventSchema = MatchEventEnvelopeBaseSchema.extend({
	event: z.literal("match_ended"),
	payload: MatchEndedPayloadSchema,
});

export const ErrorEventSchema = MatchEventEnvelopeBaseSchema.extend({
	event: z.literal("error"),
	payload: z
		.object({
			error: z.string(),
		})
		.strict(),
});

export const NoEventsEventSchema = MatchEventEnvelopeBaseSchema.extend({
	event: z.literal("no_events"),
	payload: EmptyPayloadSchema,
});

export const MatchEventEnvelopeSchema = z.discriminatedUnion("event", [
	MatchStartedEventSchema,
	MatchFoundEventSchema,
	YourTurnEventSchema,
	StateEventSchema,
	EngineEventsEventSchema,
	AgentThoughtEventSchema,
	MatchEndedEventSchema,
	ErrorEventSchema,
	NoEventsEventSchema,
]);

export const FeaturedSnapshotSchema = z
	.object({
		matchId: z.string().nullable(),
		status: z.literal("active").nullable(),
		players: z.array(z.string()).nullable(),
	})
	.strict();

export const FeaturedStreamEnvelopeSchema = z
	.object({
		streamVersion: z.literal(FEATURED_STREAM_VERSION),
		ts: z.string(),
		event: z.literal("featured_snapshot"),
		payload: FeaturedSnapshotSchema,
	})
	.strict();

export type FeaturedSnapshotEvent = z.infer<
	typeof FeaturedStreamEnvelopeSchema
>;

export type SystemVersionResponse = {
	gitSha: string | null;
	buildTime: string | null;
	contractsVersion: string;
	protocolVersion: number;
	engineVersion: string;
	environment: string | null;
};
