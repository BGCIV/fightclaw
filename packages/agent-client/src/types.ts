import type { Move } from "@fightclaw/engine";
import type {
	MatchEventEnvelope,
	MatchFoundEvent,
	NoEventsEvent,
} from "@fightclaw/protocol";
import type { RouteTable } from "./routes";

export type ErrorEnvelope = {
	ok: false;
	error: string;
	code?: string;
	requestId?: string;
} & Record<string, unknown>;

export type ClientLogEvent = {
	type: "request" | "response" | "runner";
	message: string;
	details?: Record<string, unknown>;
};

export type ArenaClientOptions = {
	baseUrl: string;
	agentApiKey?: string;
	routeOverrides?: Partial<RouteTable>;
	fetchImpl?: typeof fetch;
	requestIdProvider?: () => string;
	onLog?: (event: ClientLogEvent) => void;
};

export type RegisterResponse = {
	agentId: string;
	name: string;
	verified: boolean;
	apiKey: string;
	claimCode: string;
	apiKeyId: string | null;
	apiKeyPrefix: string | null;
};

export type VerifyResponse = {
	agentId: string;
	verifiedAt: string | null;
};

export type MeResponse = {
	agentId: string;
	name: string;
	verified: boolean;
	verifiedAt: string | null;
	createdAt: string | null;
	apiKeyId: string | null;
};

export type QueueJoinResponse = {
	status: "waiting" | "ready";
	matchId: string;
	opponentId?: string;
};

export type QueueStatusResponse =
	| { status: "idle" }
	| { status: "waiting"; matchId: string }
	| { status: "ready"; matchId: string; opponentId: string };

export type MoveSubmitResponse =
	| {
			ok: true;
			state: {
				stateVersion: number;
				status?: "active" | "ended";
				winnerAgentId?: string | null;
				endReason?: string;
				game?: {
					activePlayer?: string;
					players?: Record<string, { id?: string }>;
				};
			};
	  }
	| {
			ok: false;
			error: string;
			stateVersion?: number;
			forfeited?: boolean;
			matchStatus?: "ended";
			winnerAgentId?: string | null;
			reason?: string;
			reasonCode?: string;
	  };

export type MatchStateResponse = {
	state: {
		stateVersion: number;
		status: "active" | "ended";
		winnerAgentId?: string | null;
		loserAgentId?: string | null;
		endReason?: string;
		game?: {
			activePlayer?: string;
			players?: Record<string, { id?: string }>;
		};
	} | null;
};

export type QueueWaitEvent = MatchFoundEvent | NoEventsEvent;

export type QueueWaitResponse = {
	events: QueueWaitEvent[];
};

export type MoveProviderContext = {
	agentId: string;
	matchId: string;
	stateVersion: number;
};

export type MoveProvider = {
	nextMove: (context: MoveProviderContext) => Promise<Move>;
};

export type MatchEventHandler = (
	event: MatchEventEnvelope,
) => Promise<void> | void;

export type MatchStreamSubscriptionOptions = {
	afterId?: number;
	onClose?: () => void;
	onError?: (error: Error) => void;
};

export type RunnerSessionOptions = {
	queueTimeoutMs?: number;
	queueWaitTimeoutSeconds?: number;
	queueWaitRetryDelayMs?: number;
	streamReconnectDelayMs?: number;
};

export type RunnerSessionStartResult = {
	agentId: string;
	matchId: string;
	opponentId: string | null;
};

export type RunnerSession = {
	readonly agentId: string | null;
	readonly matchId: string | null;
	readonly opponentId: string | null;
	readonly lastEventId: number;
	start: () => Promise<RunnerSessionStartResult>;
	connect: (handler: MatchEventHandler) => Promise<() => void>;
	close: () => void;
};

export type RunMatchMoveResolutionEvent = {
	outcome: "provider_success" | "provider_timeout";
	fallbackUsed: boolean;
	fallbackKind: "non_terminal" | "terminal" | null;
	fallbackResolverTimedOut?: boolean;
	moveAction: Move["action"];
};

export type RunMatchOptions = RunnerSessionOptions & {
	moveProvider: MoveProvider;
	moveProviderTimeoutMs?: number;
	moveProviderTimeoutFallbackMove?: Move;
	resolveTimeoutFallbackMove?: (
		context: MoveProviderContext,
	) => Promise<Move | null> | Move | null;
	onMoveResolution?: (event: RunMatchMoveResolutionEvent) => void;
	session?: RunnerSession;
};

export type RunMatchResult = {
	matchId: string;
	transport: "sse";
	reason: string;
	winnerAgentId: string | null;
	loserAgentId: string | null;
};
