import { randomUUID } from "node:crypto";
import type { Move } from "@fightclaw/engine";
import type { MatchEventEnvelope } from "@fightclaw/protocol";
import type { ArenaClient } from "./client";
import { ArenaHttpError } from "./errors";
import type {
	MatchEventHandler,
	MoveSubmitResponse,
	QueueWaitEvent,
	RunMatchOptions,
	RunMatchResult,
	RunnerSession,
	RunnerSessionOptions,
} from "./types";

const DEFAULT_TIMEOUT_FALLBACK_MOVE: Move = {
	action: "pass",
	reasoning: "Timed safety fallback: pass turn.",
};

const MAX_CONSECUTIVE_ACTIONS_PER_TURN = 32;

const getActiveAgentIdFromGame = (
	game:
		| {
				activePlayer?: string;
				players?: Record<string, { id?: string }>;
		  }
		| undefined,
) => {
	const activePlayer = game?.activePlayer;
	const players = game?.players;
	if (!activePlayer || !players) return null;
	const active = players[activePlayer];
	if (!active || typeof active.id !== "string") return null;
	return active.id;
};

const normalizeLoser = (
	agentA: string,
	agentB: string | null,
	winner: string | null,
): string | null => {
	if (!winner) return null;
	if (winner === agentA) return agentB;
	if (winner === agentB) return agentA;
	return null;
};

const resolveTerminalFromMove = (
	result: MoveSubmitResponse,
	agentId: string,
	opponentId: string | null,
): RunMatchResult | null => {
	if (result.ok) {
		if (result.state.status !== "ended") return null;
		const winner = result.state.winnerAgentId ?? null;
		return {
			matchId: "",
			transport: "sse",
			reason: result.state.endReason ?? "terminal",
			winnerAgentId: winner,
			loserAgentId: normalizeLoser(agentId, opponentId, winner),
		};
	}
	if (result.matchStatus !== "ended") return null;
	return {
		matchId: "",
		transport: "sse",
		reason: result.reasonCode ?? result.reason ?? "ended",
		winnerAgentId: result.winnerAgentId ?? null,
		loserAgentId: normalizeLoser(
			agentId,
			opponentId,
			result.winnerAgentId ?? null,
		),
	};
};

const parseQueueEvent = (events: QueueWaitEvent[]) => {
	for (const event of events) {
		if (event.event === "match_found" && typeof event.matchId === "string") {
			return {
				type: "match_found" as const,
				matchId: event.matchId,
				opponentId: event.payload.opponentId ?? null,
			};
		}
	}
	return null;
};

const shouldFailStreamConnect = (error: unknown) => {
	return (
		error instanceof ArenaHttpError &&
		error.status >= 400 &&
		error.status < 500 &&
		error.status !== 429
	);
};

const asTerminalResult = (
	event: MatchEventEnvelope,
	matchId: string,
	agentId: string,
	opponentId: string | null,
): RunMatchResult | null => {
	if (event.event !== "match_ended" && event.event !== "game_ended") {
		return null;
	}
	const winner = event.payload.winnerAgentId ?? null;
	return {
		matchId,
		transport: "sse",
		reason: event.payload.reasonCode ?? event.payload.reason ?? "ended",
		winnerAgentId: winner,
		loserAgentId:
			event.payload.loserAgentId ?? normalizeLoser(agentId, opponentId, winner),
	};
};

export const createRunnerSession = (
	client: ArenaClient,
	options: RunnerSessionOptions = {},
): RunnerSession => {
	const queueWaitTimeoutSeconds = options.queueWaitTimeoutSeconds ?? 30;
	const queueTimeoutMs = options.queueTimeoutMs ?? 10 * 60 * 1000;
	const streamReconnectDelayMs = options.streamReconnectDelayMs ?? 250;

	let agentId: string | null = null;
	let matchId: string | null = null;
	let opponentId: string | null = null;
	let lastEventId = 0;
	let startPromise: Promise<{
		agentId: string;
		matchId: string;
		opponentId: string | null;
	}> | null = null;
	let stopStream: (() => void) | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;

	const clearReconnectTimer = () => {
		if (!reconnectTimer) return;
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	};

	const stopActiveStream = () => {
		if (!stopStream) return;
		const stop = stopStream;
		stopStream = null;
		stop();
	};

	const close = () => {
		closed = true;
		clearReconnectTimer();
		stopActiveStream();
	};

	const start = async () => {
		if (startPromise) return await startPromise;
		startPromise = (async () => {
			const me = await client.me();
			agentId = me.agentId;

			const joined = await client.queueJoin();
			matchId = joined.matchId;
			opponentId = joined.opponentId ?? null;

			if (joined.status !== "ready") {
				const startedAt = Date.now();
				while (true) {
					if (Date.now() - startedAt > queueTimeoutMs) {
						throw new Error("Timed out waiting for queue match.");
					}
					const waited = await client.waitForMatch(queueWaitTimeoutSeconds);
					const queueEvent = parseQueueEvent(waited.events);
					if (!queueEvent) continue;
					matchId = queueEvent.matchId;
					opponentId = queueEvent.opponentId;
					break;
				}
			}

			if (!matchId) {
				throw new Error("Runner session did not resolve a matchId.");
			}

			return {
				agentId,
				matchId,
				opponentId,
			};
		})().catch((error) => {
			startPromise = null;
			throw error;
		});

		return await startPromise;
	};

	const connect = async (handler: MatchEventHandler): Promise<() => void> => {
		const started = await start();
		closed = false;
		clearReconnectTimer();
		stopActiveStream();

		const scheduleReconnect = () => {
			if (closed || reconnectTimer) return;
			reconnectTimer = setTimeout(() => {
				reconnectTimer = null;
				void connectStream();
			}, streamReconnectDelayMs);
		};

		const connectStream = async () => {
			if (closed) return;
			try {
				const nextStop = await client.subscribeMatchStream(
					started.matchId,
					async (event) => {
						lastEventId = Math.max(lastEventId, event.eventId);
						await handler(event);
					},
					{
						afterId: lastEventId,
						onClose: () => {
							if (closed) return;
							scheduleReconnect();
						},
					},
				);
				if (closed) {
					nextStop();
					return;
				}
				stopStream = nextStop;
			} catch (error) {
				if (shouldFailStreamConnect(error)) {
					throw error;
				}
				scheduleReconnect();
			}
		};

		await connectStream();
		return () => close();
	};

	return {
		get agentId() {
			return agentId;
		},
		get matchId() {
			return matchId;
		},
		get opponentId() {
			return opponentId;
		},
		get lastEventId() {
			return lastEventId;
		},
		start,
		connect,
		close,
	};
};

export const runMatch = async (
	client: ArenaClient,
	options: RunMatchOptions,
): Promise<RunMatchResult> => {
	const moveProviderTimeoutMs = options.moveProviderTimeoutMs;
	const moveProviderTimeoutFallbackMove =
		options.moveProviderTimeoutFallbackMove ?? DEFAULT_TIMEOUT_FALLBACK_MOVE;
	const session =
		options.session ??
		createRunnerSession(client, {
			queueTimeoutMs: options.queueTimeoutMs,
			queueWaitTimeoutSeconds: options.queueWaitTimeoutSeconds,
			streamReconnectDelayMs: options.streamReconnectDelayMs,
		});
	const started = await session.start();
	const agentId = started.agentId;
	const matchId = started.matchId;
	const opponentId = started.opponentId;

	const resolveMove = async (stateVersion: number): Promise<Move> => {
		const moveContext = {
			agentId,
			matchId,
			stateVersion,
		};
		if (
			typeof moveProviderTimeoutMs !== "number" ||
			!Number.isFinite(moveProviderTimeoutMs) ||
			moveProviderTimeoutMs <= 0
		) {
			return await options.moveProvider.nextMove(moveContext);
		}

		let timeout: ReturnType<typeof setTimeout> | null = null;
		try {
			return await Promise.race([
				options.moveProvider.nextMove(moveContext),
				new Promise<Move>((resolveTimeout) => {
					timeout = setTimeout(() => {
						resolveTimeout(moveProviderTimeoutFallbackMove);
					}, moveProviderTimeoutMs);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	};

	let lastObservedVersion = -1;
	const handledTurns = new Set<number>();
	let turnLoopInFlight = false;
	let settled = false;

	try {
		return await new Promise<RunMatchResult>((resolve, reject) => {
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				session.close();
				reject(error);
			};

			const finish = (result: RunMatchResult) => {
				if (settled) return;
				settled = true;
				session.close();
				resolve(result);
			};

			const handleTurn = async (event: MatchEventEnvelope) => {
				const initialExpectedVersion =
					typeof event.stateVersion === "number"
						? event.stateVersion
						: lastObservedVersion;
				if (initialExpectedVersion < 0) return;
				if (handledTurns.has(initialExpectedVersion)) return;
				if (turnLoopInFlight) return;
				turnLoopInFlight = true;

				try {
					let expectedVersion = initialExpectedVersion;
					let actionsApplied = 0;

					while (actionsApplied < MAX_CONSECUTIVE_ACTIONS_PER_TURN) {
						if (handledTurns.has(expectedVersion)) {
							break;
						}

						const move = await resolveMove(expectedVersion);
						const publicThought =
							typeof move.reasoning === "string" &&
							move.reasoning.trim().length > 0
								? move.reasoning
								: undefined;

						const response = await client.submitMove(matchId, {
							moveId: randomUUID(),
							expectedVersion,
							move,
							...(publicThought ? { publicThought } : {}),
						});
						if (response.ok) {
							lastObservedVersion = response.state.stateVersion;
							handledTurns.add(expectedVersion);
						}

						const terminalFromMove = resolveTerminalFromMove(
							response,
							agentId,
							opponentId,
						);
						if (terminalFromMove) {
							finish({
								...terminalFromMove,
								matchId,
							});
							return;
						}

						if (!response.ok) {
							break;
						}

						const nextVersion = response.state.stateVersion;
						if (nextVersion <= expectedVersion) {
							break;
						}

						const activeAgentId = getActiveAgentIdFromGame(response.state.game);
						if (activeAgentId !== agentId) {
							break;
						}

						expectedVersion = nextVersion;
						actionsApplied += 1;
					}
				} catch (error) {
					fail(error instanceof Error ? error : new Error(String(error)));
				} finally {
					turnLoopInFlight = false;
				}
			};

			const handleEvent = async (event: MatchEventEnvelope) => {
				if (
					typeof event.stateVersion === "number" &&
					event.stateVersion > lastObservedVersion
				) {
					lastObservedVersion = event.stateVersion;
				}

				const terminal = asTerminalResult(event, matchId, agentId, opponentId);
				if (terminal) {
					finish(terminal);
					return;
				}

				if (event.event === "error") {
					fail(new Error(`Match stream error: ${event.payload.error}`));
					return;
				}

				if (event.event === "your_turn") {
					await handleTurn(event);
				}
			};

			void session.connect(handleEvent).catch((error) => {
				fail(error instanceof Error ? error : new Error(String(error)));
			});
		});
	} finally {
		session.close();
	}
};
