import type { AppBindings } from "../appTypes";
import { type LogLevel, log } from "./log";
import { emitMetric } from "./metrics";

type RunnerSessionScope = "matchmaker_do" | "match_do";
type RunnerStreamKind = "agent" | "spectator";
type RunnerStreamCloseReason =
	| "client_abort"
	| "write_timeout"
	| "resume_replaced"
	| "terminal_complete";

type RunnerSessionInput = {
	requestId?: string | null;
	agentId?: string | null;
	matchId?: string | null;
	route?: string | null;
	transport?: "sse";
};

type RunnerSessionBase = {
	requestId: string | null;
	correlationId: string;
	agentId: string | null;
	matchId: string | null;
	route: string | null;
	transport: "sse";
};

type RunnerSessionObservability = {
	correlationId: string;
	base: RunnerSessionBase;
	buildQueueWaitStarted: (input: {
		timeoutSeconds: number;
	}) => RunnerSessionEvent;
	buildQueueWaitResolved: (input: {
		waitMs: number;
		resolution: "match_found" | "timeout";
	}) => RunnerSessionEvent;
	buildStreamAttached: (input: {
		streamKind: RunnerStreamKind;
		afterId: number;
	}) => RunnerSessionEvent;
	buildStreamReplay: (input: {
		streamKind: RunnerStreamKind;
		afterId: number;
		replayedCount: number;
		replayedTerminal: boolean;
		stateVersion: number | null;
	}) => RunnerSessionEvent;
	buildStreamClosed: (input: {
		streamKind: RunnerStreamKind;
		reason: RunnerStreamCloseReason;
		afterId: number;
		lastObservedEventId: number | null;
	}) => RunnerSessionEvent;
	buildMoveConflict: (input: {
		expectedVersion: number;
		actualVersion: number;
	}) => RunnerSessionEvent;
	logQueueWaitStarted: (input: { timeoutSeconds: number }) => void;
	logQueueWaitResolved: (input: {
		waitMs: number;
		resolution: "match_found" | "timeout";
	}) => void;
	logStreamAttached: (input: {
		streamKind: RunnerStreamKind;
		afterId: number;
	}) => void;
	logStreamReplay: (input: {
		streamKind: RunnerStreamKind;
		afterId: number;
		replayedCount: number;
		replayedTerminal: boolean;
		stateVersion: number | null;
	}) => void;
	logStreamClosed: (input: {
		streamKind: RunnerStreamKind;
		reason: RunnerStreamCloseReason;
		afterId: number;
		lastObservedEventId: number | null;
	}) => void;
	logMoveConflict: (input: {
		expectedVersion: number;
		actualVersion: number;
	}) => void;
	emitQueueWaitNoEvents: (
		env: Pick<AppBindings, "OBS" | "SENTRY_ENVIRONMENT" | "TEST_MODE">,
	) => void;
	emitStreamResume: (
		env: Pick<AppBindings, "OBS" | "SENTRY_ENVIRONMENT" | "TEST_MODE">,
	) => void;
	emitStreamDisconnect: (
		env: Pick<AppBindings, "OBS" | "SENTRY_ENVIRONMENT" | "TEST_MODE">,
	) => void;
	emitMoveConflict: (
		env: Pick<AppBindings, "OBS" | "SENTRY_ENVIRONMENT" | "TEST_MODE">,
	) => void;
};

type RunnerSessionEvent = {
	event:
		| "runner_queue_wait_started"
		| "runner_queue_wait_resolved"
		| "runner_stream_attached"
		| "runner_stream_replayed"
		| "runner_stream_closed"
		| "runner_move_conflict";
	scope: RunnerSessionScope;
	requestId: string | null;
	correlationId: string;
	route: string | null;
	transport: "sse";
	agentId: string | null;
	matchId: string | null;
} & Record<string, unknown>;

const createCorrelationId = (requestId?: string | null) => {
	if (typeof requestId === "string" && requestId.trim().length > 0) {
		return requestId.trim();
	}
	const cryptoApi = globalThis as typeof globalThis & {
		crypto?: { randomUUID: () => string };
	};
	return cryptoApi.crypto?.randomUUID?.() ?? "runner-session";
};

const baseEvent = (
	base: RunnerSessionBase,
	scope: RunnerSessionScope,
	event: RunnerSessionEvent["event"],
	fields: Record<string, unknown>,
): RunnerSessionEvent => ({
	event,
	scope,
	requestId: base.requestId,
	correlationId: base.correlationId,
	route: base.route,
	transport: base.transport,
	agentId: base.agentId,
	matchId: base.matchId,
	...fields,
});

const emitEvent = (
	level: LogLevel,
	message: string,
	event: RunnerSessionEvent,
) => {
	log(level, message, event);
};

const emitRunnerMetric = (
	env: Pick<AppBindings, "OBS" | "SENTRY_ENVIRONMENT" | "TEST_MODE">,
	event:
		| "runner_queue_wait_no_events"
		| "runner_stream_resume"
		| "runner_stream_disconnect"
		| "runner_move_conflict",
	args: {
		scope: RunnerSessionScope;
		requestId: string | null;
		agentId: string | null;
		matchId: string | null;
	},
) => {
	emitMetric(env, event, {
		scope: args.scope,
		requestId: args.requestId ?? undefined,
		agentId: args.agentId ?? undefined,
		matchId: args.matchId ?? undefined,
	});
};

export const buildRunnerSessionObservability = (
	input: RunnerSessionInput,
): RunnerSessionObservability => {
	const correlationId = createCorrelationId(input.requestId);
	const base: RunnerSessionBase = {
		requestId:
			typeof input.requestId === "string" && input.requestId.trim().length > 0
				? input.requestId.trim()
				: null,
		correlationId,
		agentId: input.agentId ?? null,
		matchId: input.matchId ?? null,
		route: input.route ?? null,
		transport: input.transport ?? "sse",
	};

	return {
		correlationId,
		base,
		buildQueueWaitStarted: ({ timeoutSeconds }) =>
			baseEvent(base, "matchmaker_do", "runner_queue_wait_started", {
				timeoutSeconds,
			}),
		buildQueueWaitResolved: ({ waitMs, resolution }) =>
			baseEvent(base, "matchmaker_do", "runner_queue_wait_resolved", {
				waitMs,
				resolution,
			}),
		buildStreamAttached: ({ streamKind, afterId }) =>
			baseEvent(base, "match_do", "runner_stream_attached", {
				streamKind,
				afterId,
			}),
		buildStreamReplay: ({
			streamKind,
			afterId,
			replayedCount,
			replayedTerminal,
			stateVersion,
		}) =>
			baseEvent(base, "match_do", "runner_stream_replayed", {
				streamKind,
				afterId,
				replayedCount,
				replayedTerminal,
				stateVersion,
			}),
		buildStreamClosed: ({ streamKind, reason, afterId, lastObservedEventId }) =>
			baseEvent(base, "match_do", "runner_stream_closed", {
				streamKind,
				reason,
				afterId,
				lastObservedEventId,
			}),
		buildMoveConflict: ({ expectedVersion, actualVersion }) =>
			baseEvent(base, "match_do", "runner_move_conflict", {
				expectedVersion,
				actualVersion,
				delta: actualVersion - expectedVersion,
			}),
		logQueueWaitStarted: (input) => {
			emitEvent("info", "runner_queue_wait_started", {
				...baseEvent(base, "matchmaker_do", "runner_queue_wait_started", {
					timeoutSeconds: input.timeoutSeconds,
				}),
			});
		},
		logQueueWaitResolved: (input) => {
			emitEvent("info", "runner_queue_wait_resolved", {
				...baseEvent(base, "matchmaker_do", "runner_queue_wait_resolved", {
					waitMs: input.waitMs,
					resolution: input.resolution,
				}),
			});
		},
		logStreamAttached: (input) => {
			emitEvent("info", "runner_stream_attached", {
				...baseEvent(base, "match_do", "runner_stream_attached", {
					streamKind: input.streamKind,
					afterId: input.afterId,
				}),
			});
		},
		logStreamReplay: (input) => {
			emitEvent("info", "runner_stream_replayed", {
				...baseEvent(base, "match_do", "runner_stream_replayed", {
					streamKind: input.streamKind,
					afterId: input.afterId,
					replayedCount: input.replayedCount,
					replayedTerminal: input.replayedTerminal,
					stateVersion: input.stateVersion,
				}),
			});
		},
		logStreamClosed: (input) => {
			emitEvent("info", "runner_stream_closed", {
				...baseEvent(base, "match_do", "runner_stream_closed", {
					streamKind: input.streamKind,
					reason: input.reason,
					afterId: input.afterId,
					lastObservedEventId: input.lastObservedEventId,
				}),
			});
		},
		logMoveConflict: (input) => {
			emitEvent("warn", "runner_move_conflict", {
				...baseEvent(base, "match_do", "runner_move_conflict", {
					expectedVersion: input.expectedVersion,
					actualVersion: input.actualVersion,
					delta: input.actualVersion - input.expectedVersion,
				}),
			});
		},
		emitQueueWaitNoEvents: (env) =>
			emitRunnerMetric(env, "runner_queue_wait_no_events", {
				scope: "matchmaker_do",
				requestId: base.requestId,
				agentId: base.agentId,
				matchId: base.matchId,
			}),
		emitStreamResume: (env) =>
			emitRunnerMetric(env, "runner_stream_resume", {
				scope: "match_do",
				requestId: base.requestId,
				agentId: base.agentId,
				matchId: base.matchId,
			}),
		emitStreamDisconnect: (env) =>
			emitRunnerMetric(env, "runner_stream_disconnect", {
				scope: "match_do",
				requestId: base.requestId,
				agentId: base.agentId,
				matchId: base.matchId,
			}),
		emitMoveConflict: (env) =>
			emitRunnerMetric(env, "runner_move_conflict", {
				scope: "match_do",
				requestId: base.requestId,
				agentId: base.agentId,
				matchId: base.matchId,
			}),
	};
};
