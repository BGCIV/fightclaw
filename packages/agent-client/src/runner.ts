import { randomUUID } from "node:crypto";
import type { Move } from "@fightclaw/engine";
import type { MatchEventEnvelope } from "@fightclaw/protocol";
import type { ArenaClient } from "./client";
import { ArenaHttpError } from "./errors";
import type {
	MoveSubmitResponse,
	QueueWaitEvent,
	RunMatchOptions,
	RunMatchResult,
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

export const runMatch = async (
	client: ArenaClient,
	options: RunMatchOptions,
): Promise<RunMatchResult> => {
	const queueWaitTimeoutSeconds = options.queueWaitTimeoutSeconds ?? 30;
	const queueTimeoutMs = options.queueTimeoutMs ?? 10 * 60 * 1000;
	const streamReconnectDelayMs = options.streamReconnectDelayMs ?? 250;
	const moveProviderTimeoutMs = options.moveProviderTimeoutMs;
	const moveProviderTimeoutFallbackMove =
		options.moveProviderTimeoutFallbackMove ?? DEFAULT_TIMEOUT_FALLBACK_MOVE;

	const me = await client.me();
	let matchId = "";
	let opponentId: string | null = null;

	const resolveMove = async (stateVersion: number): Promise<Move> => {
		const moveContext = {
			agentId: me.agentId,
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

	let lastEventId = 0;
	let lastObservedVersion = -1;
	const handledTurns = new Set<number>();
	let turnLoopInFlight = false;
	let stopStream: (() => void) | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let settled = false;

	const clearReconnectTimer = () => {
		if (!reconnectTimer) return;
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	};

	const closeStream = () => {
		if (!stopStream) return;
		const stop = stopStream;
		stopStream = null;
		stop();
	};

	try {
		return await new Promise<RunMatchResult>((resolve, reject) => {
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				clearReconnectTimer();
				closeStream();
				reject(error);
			};

			const finish = (result: RunMatchResult) => {
				if (settled) return;
				settled = true;
				clearReconnectTimer();
				closeStream();
				resolve(result);
			};

			const scheduleReconnect = () => {
				if (settled || reconnectTimer) return;
				reconnectTimer = setTimeout(() => {
					reconnectTimer = null;
					void connectStream();
				}, streamReconnectDelayMs);
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
							me.agentId,
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
						if (activeAgentId !== me.agentId) {
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
				lastEventId = Math.max(lastEventId, event.eventId);
				if (
					typeof event.stateVersion === "number" &&
					event.stateVersion > lastObservedVersion
				) {
					lastObservedVersion = event.stateVersion;
				}

				const terminal = asTerminalResult(
					event,
					matchId,
					me.agentId,
					opponentId,
				);
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

			const connectStream = async () => {
				if (settled) return;
				try {
					stopStream = await client.subscribeMatchStream(matchId, handleEvent, {
						afterId: lastEventId,
						onClose: () => {
							if (settled) return;
							scheduleReconnect();
						},
					});
				} catch (error) {
					if (shouldFailStreamConnect(error)) {
						fail(error instanceof Error ? error : new Error(String(error)));
						return;
					}
					scheduleReconnect();
				}
			};

			void connectStream();
		});
	} finally {
		clearReconnectTimer();
		closeStream();
	}
};
