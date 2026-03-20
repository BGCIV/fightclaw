import { describe, expect, it, vi } from "vitest";
import { ArenaHttpError } from "../../../packages/agent-client/src/errors";
import {
	createRunnerSession,
	runMatch,
} from "../../../packages/agent-client/src/runner";
import type { MatchStreamSubscriptionOptions } from "../../../packages/agent-client/src/types";

describe("agent-client runMatch canonical SSE flow", () => {
	it("resolves a waiting queue join through one session start lifecycle", async () => {
		const client = {
			me: vi.fn(async () => ({ agentId: "agent-a" })),
			queueJoin: vi.fn(async () => ({
				status: "waiting" as const,
				matchId: "queue-ticket-1",
			})),
			waitForMatch: vi
				.fn()
				.mockResolvedValueOnce({
					events: [
						{
							eventVersion: 2,
							eventId: 1,
							ts: "2026-03-18T12:00:00.000Z",
							matchId: null,
							stateVersion: null,
							event: "no_events",
							payload: {},
						},
					],
				})
				.mockResolvedValueOnce({
					events: [
						{
							eventVersion: 2,
							eventId: 2,
							ts: "2026-03-18T12:00:01.000Z",
							matchId: "match-1",
							stateVersion: null,
							event: "match_found",
							payload: { opponentId: "agent-b" },
						},
					],
				}),
		};

		const session = createRunnerSession(client as never, {
			queueTimeoutMs: 100,
			queueWaitTimeoutSeconds: 1,
		});
		const started = await session.start();

		expect(started).toEqual({
			agentId: "agent-a",
			matchId: "match-1",
			opponentId: "agent-b",
		});
		expect(client.queueJoin).toHaveBeenCalledTimes(1);
		expect(client.waitForMatch).toHaveBeenCalledTimes(2);
	});

	it("survives a transient disconnect while waiting for queue resolution without starting over", async () => {
		vi.useFakeTimers();
		try {
			const queueDisconnect = new ArenaHttpError(
				408,
				"Queue wait connection closed.",
				{
					ok: false,
					error: "Queue wait connection closed.",
					code: "queue_wait_disconnect",
				},
			);
			const client = {
				me: vi.fn(async () => ({ agentId: "agent-a" })),
				queueJoin: vi.fn(async () => ({
					status: "waiting" as const,
					matchId: "queue-ticket-1",
				})),
				waitForMatch: vi
					.fn()
					.mockRejectedValueOnce(queueDisconnect)
					.mockResolvedValueOnce({
						events: [
							{
								eventVersion: 2,
								eventId: 2,
								ts: "2026-03-18T12:00:01.000Z",
								matchId: "match-1",
								stateVersion: null,
								event: "match_found",
								payload: { opponentId: "agent-b" },
							},
						],
					}),
			};

			const session = createRunnerSession(client as never, {
				queueTimeoutMs: 100,
				queueWaitTimeoutSeconds: 1,
				queueWaitRetryDelayMs: 25,
			});
			const startPromise = session.start();
			await vi.advanceTimersByTimeAsync(0);
			expect(client.waitForMatch).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(24);
			expect(client.waitForMatch).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			await expect(startPromise).resolves.toEqual({
				agentId: "agent-a",
				matchId: "match-1",
				opponentId: "agent-b",
			});
			expect(client.queueJoin).toHaveBeenCalledTimes(1);
			expect(client.waitForMatch).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("still rejects non-transient queue wait errors", async () => {
		const queueDisconnect = new ArenaHttpError(
			500,
			"Queue wait connection permanently failed.",
			{
				ok: false,
				error: "Queue wait connection permanently failed.",
				code: "queue_wait_permanent",
			},
		);
		const client = {
			me: vi.fn(async () => ({ agentId: "agent-a" })),
			queueJoin: vi.fn(async () => ({
				status: "waiting" as const,
				matchId: "queue-ticket-1",
			})),
			waitForMatch: vi.fn().mockRejectedValueOnce(queueDisconnect),
		};

		const session = createRunnerSession(client as never, {
			queueTimeoutMs: 100,
			queueWaitTimeoutSeconds: 1,
		});

		await expect(session.start()).rejects.toThrow(
			"Queue wait connection permanently failed.",
		);
		expect(client.queueJoin).toHaveBeenCalledTimes(1);
		expect(client.waitForMatch).toHaveBeenCalledTimes(1);
	});

	it("reuses a prestarted session instead of queueing twice", async () => {
		const stopStream = vi.fn();
		const subscribeMatchStream = vi.fn(
			async (
				matchId: string,
				handler: (event: Parameters<typeof handler>[0]) => Promise<void>,
			) => {
				queueMicrotask(() => {
					void handler({
						eventVersion: 2,
						eventId: 1,
						ts: "2026-03-18T12:00:00.000Z",
						matchId,
						stateVersion: 0,
						event: "your_turn",
						payload: {},
					});
				});
				return stopStream;
			},
		);
		const submitMove = vi.fn(async () => ({
			ok: true as const,
			state: {
				stateVersion: 1,
				status: "ended" as const,
				winnerAgentId: "agent-a",
				endReason: "terminal",
			},
		}));
		const client = {
			me: vi.fn(async () => ({ agentId: "agent-a" })),
			queueJoin: vi.fn(async () => ({
				status: "ready" as const,
				matchId: "match-1",
				opponentId: "agent-b",
			})),
			waitForMatch: vi.fn(),
			subscribeMatchStream,
			submitMove,
		};

		const session = createRunnerSession(client as never);
		await session.start();

		await runMatch(client as never, {
			moveProvider: {
				nextMove: vi.fn(async () => ({ action: "pass" })),
			},
			session,
		});

		expect(client.queueJoin).toHaveBeenCalledTimes(1);
		expect(client.waitForMatch).not.toHaveBeenCalled();
		expect(submitMove).toHaveBeenCalledTimes(1);
		expect(stopStream).toHaveBeenCalledTimes(1);
	});

	it("reconnects the stream with afterId after an unexpected close", async () => {
		const stopFirst = vi.fn();
		const stopSecond = vi.fn();
		const submitMove = vi.fn(async () => ({
			ok: true as const,
			state: {
				stateVersion: 1,
				status: "ended" as const,
				winnerAgentId: "agent-a",
				endReason: "terminal",
			},
		}));

		const subscribeMatchStream = vi
			.fn()
			.mockImplementationOnce(
				async (
					matchId: string,
					handler: (event: Parameters<typeof handler>[0]) => Promise<void>,
					options?: MatchStreamSubscriptionOptions,
				) => {
					expect(matchId).toBe("match-1");
					expect(options?.afterId ?? 0).toBe(0);
					queueMicrotask(() => {
						void handler({
							eventVersion: 2,
							eventId: 5,
							ts: "2026-03-18T12:00:00.000Z",
							matchId,
							stateVersion: 0,
							event: "state",
							payload: { state: { game: "snapshot" } },
						});
						queueMicrotask(() => {
							options?.onClose?.();
						});
					});
					return stopFirst;
				},
			)
			.mockImplementationOnce(
				async (
					matchId: string,
					handler: (event: Parameters<typeof handler>[0]) => Promise<void>,
					options?: MatchStreamSubscriptionOptions,
				) => {
					expect(matchId).toBe("match-1");
					expect(options?.afterId).toBe(5);
					queueMicrotask(() => {
						void handler({
							eventVersion: 2,
							eventId: 6,
							ts: "2026-03-18T12:00:01.000Z",
							matchId,
							stateVersion: 0,
							event: "your_turn",
							payload: {},
						});
					});
					return stopSecond;
				},
			);

		const client = {
			me: vi.fn(async () => ({ agentId: "agent-a" })),
			queueJoin: vi.fn(async () => ({
				status: "ready" as const,
				matchId: "match-1",
				opponentId: "agent-b",
			})),
			waitForMatch: vi.fn(),
			submitMove,
			subscribeMatchStream,
		};

		const moveProvider = {
			nextMove: vi.fn(async () => ({ action: "pass" })),
		};

		const result = await runMatch(client as never, {
			moveProvider,
			streamReconnectDelayMs: 0,
		});

		expect(result.matchId).toBe("match-1");
		expect(result.transport).toBe("sse");
		expect(subscribeMatchStream).toHaveBeenCalledTimes(2);
		expect(submitMove).toHaveBeenCalledTimes(1);
		expect(submitMove).toHaveBeenCalledWith(
			"match-1",
			expect.objectContaining({ expectedVersion: 0 }),
		);
		expect(stopFirst).toHaveBeenCalledTimes(0);
		expect(stopSecond).toHaveBeenCalledTimes(1);
	});

	it("ignores a duplicate boundary replay after reconnect once the turn was already handled", async () => {
		const stopFirst = vi.fn();
		const stopSecond = vi.fn();
		const submitMove = vi.fn().mockResolvedValueOnce({
			ok: true as const,
			state: {
				stateVersion: 1,
				status: "active" as const,
				game: {
					activePlayer: "B",
					players: {
						A: { id: "agent-a" },
						B: { id: "agent-b" },
					},
				},
			},
		});

		const subscribeMatchStream = vi
			.fn()
			.mockImplementationOnce(
				async (
					matchId: string,
					handler: (event: Parameters<typeof handler>[0]) => Promise<void>,
					options?: MatchStreamSubscriptionOptions,
				) => {
					expect(matchId).toBe("match-1");
					expect(options?.afterId ?? 0).toBe(0);
					queueMicrotask(() => {
						void handler({
							eventVersion: 2,
							eventId: 5,
							ts: "2026-03-18T12:00:00.000Z",
							matchId,
							stateVersion: 0,
							event: "your_turn",
							payload: {},
						});
						queueMicrotask(() => {
							options?.onClose?.();
						});
					});
					return stopFirst;
				},
			)
			.mockImplementationOnce(
				async (
					matchId: string,
					handler: (event: Parameters<typeof handler>[0]) => Promise<void>,
					options?: MatchStreamSubscriptionOptions,
				) => {
					expect(matchId).toBe("match-1");
					expect(options?.afterId).toBe(5);
					queueMicrotask(() => {
						void handler({
							eventVersion: 2,
							eventId: 5,
							ts: "2026-03-18T12:00:01.000Z",
							matchId,
							stateVersion: 0,
							event: "your_turn",
							payload: {},
						});
						queueMicrotask(() => {
							void handler({
								eventVersion: 2,
								eventId: 6,
								ts: "2026-03-18T12:00:02.000Z",
								matchId,
								stateVersion: 1,
								event: "match_ended",
								payload: {
									winnerAgentId: "agent-b",
									loserAgentId: "agent-a",
									reasonCode: "terminal",
									reason: "terminal",
								},
							});
							queueMicrotask(() => {
								options?.onClose?.();
							});
						});
					});
					return stopSecond;
				},
			);

		const client = {
			me: vi.fn(async () => ({ agentId: "agent-a" })),
			queueJoin: vi.fn(async () => ({
				status: "ready" as const,
				matchId: "match-1",
				opponentId: "agent-b",
			})),
			waitForMatch: vi.fn(),
			submitMove,
			subscribeMatchStream,
		};

		const moveProvider = {
			nextMove: vi.fn(async () => ({ action: "pass" })),
		};

		const result = await runMatch(client as never, {
			moveProvider,
			streamReconnectDelayMs: 0,
		});

		expect(result.matchId).toBe("match-1");
		expect(subscribeMatchStream).toHaveBeenCalledTimes(2);
		expect(submitMove).toHaveBeenCalledTimes(1);
		expect(stopFirst).toHaveBeenCalledTimes(0);
		expect(stopSecond).toHaveBeenCalledTimes(1);
	});

	it("does not resubmit when a stale move response already advanced the turn", async () => {
		const stopFirst = vi.fn();
		const stopSecond = vi.fn();
		const submitMove = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false as const,
				error: "Version mismatch.",
				stateVersion: 1,
				reason: "stale_version",
				reasonCode: "stale_version",
			})
			.mockResolvedValueOnce({
				ok: true as const,
				state: {
					stateVersion: 2,
					status: "ended" as const,
					winnerAgentId: "agent-b",
					endReason: "terminal",
				},
			});

		const subscribeMatchStream = vi
			.fn()
			.mockImplementationOnce(
				async (
					matchId: string,
					handler: (event: Parameters<typeof handler>[0]) => Promise<void>,
					options?: MatchStreamSubscriptionOptions,
				) => {
					expect(matchId).toBe("match-1");
					expect(options?.afterId ?? 0).toBe(0);
					queueMicrotask(() => {
						void handler({
							eventVersion: 2,
							eventId: 11,
							ts: "2026-03-18T12:00:00.000Z",
							matchId,
							stateVersion: 0,
							event: "your_turn",
							payload: {},
						});
						queueMicrotask(() => {
							options?.onClose?.();
						});
					});
					return stopFirst;
				},
			)
			.mockImplementationOnce(
				async (
					matchId: string,
					handler: (event: Parameters<typeof handler>[0]) => Promise<void>,
					options?: MatchStreamSubscriptionOptions,
				) => {
					expect(matchId).toBe("match-1");
					expect(options?.afterId).toBe(11);
					queueMicrotask(() => {
						void handler({
							eventVersion: 2,
							eventId: 11,
							ts: "2026-03-18T12:00:01.000Z",
							matchId,
							stateVersion: 0,
							event: "your_turn",
							payload: {},
						});
						queueMicrotask(() => {
							void handler({
								eventVersion: 2,
								eventId: 12,
								ts: "2026-03-18T12:00:02.000Z",
								matchId,
								stateVersion: 1,
								event: "match_ended",
								payload: {
									winnerAgentId: "agent-b",
									loserAgentId: "agent-a",
									reasonCode: "stale_version",
									reason: "stale_version",
								},
							});
							queueMicrotask(() => {
								options?.onClose?.();
							});
						});
					});
					return stopSecond;
				},
			);

		const client = {
			me: vi.fn(async () => ({ agentId: "agent-a" })),
			queueJoin: vi.fn(async () => ({
				status: "ready" as const,
				matchId: "match-1",
				opponentId: "agent-b",
			})),
			waitForMatch: vi.fn(),
			submitMove,
			subscribeMatchStream,
		};

		const moveProvider = {
			nextMove: vi.fn(async () => ({ action: "pass" })),
		};

		await expect(
			runMatch(client as never, {
				moveProvider,
				streamReconnectDelayMs: 0,
			}),
		).resolves.toMatchObject({
			matchId: "match-1",
			transport: "sse",
		});

		expect(subscribeMatchStream).toHaveBeenCalledTimes(2);
		expect(submitMove).toHaveBeenCalledTimes(1);
		expect(stopFirst).toHaveBeenCalledTimes(0);
		expect(stopSecond).toHaveBeenCalledTimes(1);
	});

	it("reaches the stream after a transient attach-gap failure without requeueing", async () => {
		const stopSecond = vi.fn();
		const submitMove = vi.fn(async () => ({
			ok: true as const,
			state: {
				stateVersion: 1,
				status: "ended" as const,
				winnerAgentId: "agent-a",
				endReason: "terminal",
			},
		}));

		const subscribeMatchStream = vi
			.fn()
			.mockRejectedValueOnce(
				new ArenaHttpError(404, "Match stream attach failed transiently.", {
					ok: false,
					error: "Match stream attach failed transiently.",
					code: "match_stream_attach_gap",
				}),
			)
			.mockImplementationOnce(
				async (
					matchId: string,
					handler: (event: Parameters<typeof handler>[0]) => Promise<void>,
					options?: MatchStreamSubscriptionOptions,
				) => {
					expect(matchId).toBe("match-1");
					expect(options?.afterId ?? 0).toBe(0);
					queueMicrotask(() => {
						void handler({
							eventVersion: 2,
							eventId: 1,
							ts: "2026-03-18T12:00:00.000Z",
							matchId,
							stateVersion: 0,
							event: "your_turn",
							payload: {},
						});
					});
					return stopSecond;
				},
			);

		const client = {
			me: vi.fn(async () => ({ agentId: "agent-a" })),
			queueJoin: vi.fn(async () => ({
				status: "ready" as const,
				matchId: "match-1",
				opponentId: "agent-b",
			})),
			waitForMatch: vi.fn(),
			submitMove,
			subscribeMatchStream,
		};

		const moveProvider = {
			nextMove: vi.fn(async () => ({ action: "pass" })),
		};

		await expect(
			runMatch(client as never, {
				moveProvider,
				streamReconnectDelayMs: 0,
			}),
		).resolves.toMatchObject({
			matchId: "match-1",
			transport: "sse",
		});

		expect(client.queueJoin).toHaveBeenCalledTimes(1);
		expect(subscribeMatchStream).toHaveBeenCalledTimes(2);
		expect(submitMove).toHaveBeenCalledTimes(1);
		expect(stopSecond).toHaveBeenCalledTimes(1);
	});

	it("still rejects a non-transient attach 404", async () => {
		const client = {
			me: vi.fn(async () => ({ agentId: "agent-a" })),
			queueJoin: vi.fn(async () => ({
				status: "ready" as const,
				matchId: "match-1",
				opponentId: "agent-b",
			})),
			waitForMatch: vi.fn(),
			submitMove: vi.fn(),
			subscribeMatchStream: vi.fn().mockRejectedValueOnce(
				new ArenaHttpError(404, "Match stream not ready.", {
					ok: false,
					error: "Match stream not ready.",
					code: "match_stream_permanent_404",
				}),
			),
		};

		const moveProvider = {
			nextMove: vi.fn(async () => ({ action: "pass" })),
		};

		await expect(
			runMatch(client as never, {
				moveProvider,
				streamReconnectDelayMs: 0,
			}),
		).rejects.toThrow("Match stream not ready.");

		expect(client.queueJoin).toHaveBeenCalledTimes(1);
		expect(client.subscribeMatchStream).toHaveBeenCalledTimes(1);
	});

	it("continues submitting actions within the same turn when still active", async () => {
		const stopStream = vi.fn();
		const subscribeMatchStream = vi.fn(
			async (
				matchId: string,
				handler: (event: Parameters<typeof handler>[0]) => Promise<void>,
			) => {
				queueMicrotask(() => {
					void handler({
						eventVersion: 2,
						eventId: 1,
						ts: "2026-03-18T12:00:00.000Z",
						matchId,
						stateVersion: 0,
						event: "your_turn",
						payload: {},
					});
				});
				return stopStream;
			},
		);

		const submitMove = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true as const,
				state: {
					stateVersion: 1,
					status: "active" as const,
					game: {
						activePlayer: "A",
						players: {
							A: { id: "agent-a" },
							B: { id: "agent-b" },
						},
					},
				},
			})
			.mockResolvedValueOnce({
				ok: true as const,
				state: {
					stateVersion: 2,
					status: "ended" as const,
					winnerAgentId: "agent-a",
					endReason: "terminal",
					game: {
						activePlayer: "B",
						players: {
							A: { id: "agent-a" },
							B: { id: "agent-b" },
						},
					},
				},
			});

		const client = {
			me: vi.fn(async () => ({ agentId: "agent-a" })),
			queueJoin: vi.fn(async () => ({
				status: "ready" as const,
				matchId: "match-1",
				opponentId: "agent-b",
			})),
			waitForMatch: vi.fn(),
			submitMove,
			subscribeMatchStream,
		};

		const moveProvider = {
			nextMove: vi.fn(async () => ({ action: "move", unitId: "u1", to: "B2" })),
		};

		await runMatch(client as never, {
			moveProvider,
		});

		expect(submitMove).toHaveBeenCalledTimes(2);
		expect(submitMove).toHaveBeenNthCalledWith(
			1,
			"match-1",
			expect.objectContaining({ expectedVersion: 0 }),
		);
		expect(submitMove).toHaveBeenNthCalledWith(
			2,
			"match-1",
			expect.objectContaining({ expectedVersion: 1 }),
		);
		expect(moveProvider.nextMove).toHaveBeenCalledTimes(2);
		expect(stopStream).toHaveBeenCalledTimes(1);
	});

	it("forwards move reasoning as publicThought on submit", async () => {
		const stopStream = vi.fn();
		const subscribeMatchStream = vi.fn(
			async (
				matchId: string,
				handler: (event: Parameters<typeof handler>[0]) => Promise<void>,
			) => {
				queueMicrotask(() => {
					void handler({
						eventVersion: 2,
						eventId: 1,
						ts: "2026-03-18T12:00:00.000Z",
						matchId,
						stateVersion: 0,
						event: "your_turn",
						payload: {},
					});
				});
				return stopStream;
			},
		);

		const submitMove = vi.fn(async () => ({
			ok: true as const,
			state: {
				stateVersion: 1,
				status: "ended" as const,
				winnerAgentId: "agent-a",
				endReason: "terminal",
			},
		}));

		const client = {
			me: vi.fn(async () => ({ agentId: "agent-a" })),
			queueJoin: vi.fn(async () => ({
				status: "ready" as const,
				matchId: "match-1",
				opponentId: "agent-b",
			})),
			waitForMatch: vi.fn(),
			submitMove,
			subscribeMatchStream,
		};

		const moveProvider = {
			nextMove: vi.fn(async () => ({
				action: "pass" as const,
				reasoning: "Opening line of thought",
			})),
		};

		await runMatch(client as never, {
			moveProvider,
		});

		expect(submitMove).toHaveBeenCalledTimes(1);
		expect(submitMove).toHaveBeenCalledWith(
			"match-1",
			expect.objectContaining({
				expectedVersion: 0,
				publicThought: "Opening line of thought",
			}),
		);
		expect(stopStream).toHaveBeenCalledTimes(1);
	});

	it("falls back to pass when move provider exceeds timeout", async () => {
		const stopStream = vi.fn();
		const subscribeMatchStream = vi.fn(
			async (
				matchId: string,
				handler: (event: Parameters<typeof handler>[0]) => Promise<void>,
			) => {
				queueMicrotask(() => {
					void handler({
						eventVersion: 2,
						eventId: 1,
						ts: "2026-03-18T12:00:00.000Z",
						matchId,
						stateVersion: 0,
						event: "your_turn",
						payload: {},
					});
				});
				return stopStream;
			},
		);

		const submitMove = vi.fn(
			async (_matchId: string, payload: { move: { action: string } }) => {
				expect(payload.move.action).toBe("pass");
				return {
					ok: true as const,
					state: {
						stateVersion: 1,
						status: "ended" as const,
						winnerAgentId: "agent-a",
						endReason: "terminal",
					},
				};
			},
		);

		const client = {
			me: vi.fn(async () => ({ agentId: "agent-a" })),
			queueJoin: vi.fn(async () => ({
				status: "ready" as const,
				matchId: "match-1",
				opponentId: "agent-b",
			})),
			waitForMatch: vi.fn(),
			submitMove,
			subscribeMatchStream,
		};

		const slowMoveProvider = {
			nextMove: vi.fn(
				() =>
					new Promise((resolve) => {
						setTimeout(() => resolve({ action: "end_turn" }), 50);
					}),
			),
		};

		await runMatch(client as never, {
			moveProvider: slowMoveProvider,
			moveProviderTimeoutMs: 5,
		});

		expect(submitMove).toHaveBeenCalledTimes(1);
		expect(slowMoveProvider.nextMove).toHaveBeenCalledTimes(1);
		expect(stopStream).toHaveBeenCalledTimes(1);
	});

	it("falls back to authoritative terminal state after repeated reconnects at the same cursor", async () => {
		vi.useFakeTimers();
		try {
			const stopFirst = vi.fn();
			const stopSecond = vi.fn();
			const stopThird = vi.fn();
			const subscribeMatchStream = vi
				.fn()
				.mockImplementationOnce(
					async (
						matchId: string,
						handler: (event: Parameters<typeof handler>[0]) => Promise<void>,
						options?: MatchStreamSubscriptionOptions,
					) => {
						expect(matchId).toBe("match-1");
						expect(options?.afterId ?? 0).toBe(0);
						queueMicrotask(() => {
							void handler({
								eventVersion: 2,
								eventId: 111,
								ts: "2026-03-18T12:00:00.000Z",
								matchId,
								stateVersion: 55,
								event: "state",
								payload: { state: { game: "snapshot" } },
							});
							queueMicrotask(() => {
								options?.onClose?.();
							});
						});
						return stopFirst;
					},
				)
				.mockImplementationOnce(
					async (
						matchId: string,
						_handler: (event: Parameters<typeof _handler>[0]) => Promise<void>,
						options?: MatchStreamSubscriptionOptions,
					) => {
						expect(matchId).toBe("match-1");
						expect(options?.afterId).toBe(111);
						queueMicrotask(() => {
							options?.onClose?.();
						});
						return stopSecond;
					},
				)
				.mockImplementationOnce(
					async (
						matchId: string,
						_handler: (event: Parameters<typeof _handler>[0]) => Promise<void>,
						options?: MatchStreamSubscriptionOptions,
					) => {
						expect(matchId).toBe("match-1");
						expect(options?.afterId).toBe(111);
						queueMicrotask(() => {
							options?.onClose?.();
						});
						return stopThird;
					},
				);

			const getMatchState = vi.fn(async () => ({
				state: {
					stateVersion: 59,
					status: "ended" as const,
					winnerAgentId: "agent-b",
					loserAgentId: "agent-a",
					endReason: "forfeit",
				},
			}));

			const client = {
				me: vi.fn(async () => ({ agentId: "agent-a" })),
				queueJoin: vi.fn(async () => ({
					status: "ready" as const,
					matchId: "match-1",
					opponentId: "agent-b",
				})),
				waitForMatch: vi.fn(),
				submitMove: vi.fn(),
				subscribeMatchStream,
				getMatchState,
			};

			const resultPromise = runMatch(client as never, {
				moveProvider: {
					nextMove: vi.fn(async () => ({ action: "pass" })),
				},
				streamReconnectDelayMs: 10,
			});

			const outcome = await Promise.race([
				resultPromise.then((result) => ({ kind: "result" as const, result })),
				vi.advanceTimersByTimeAsync(1000).then(() => ({
					kind: "timeout" as const,
				})),
			]);

			expect(outcome.kind).toBe("result");
			if (outcome.kind !== "result") return;
			expect(outcome.result).toMatchObject({
				matchId: "match-1",
				reason: "forfeit",
				winnerAgentId: "agent-b",
				loserAgentId: "agent-a",
			});
			expect(getMatchState).toHaveBeenCalledWith("match-1");
			expect(subscribeMatchStream).toHaveBeenCalledTimes(3);
			expect(stopFirst).toHaveBeenCalledTimes(0);
			expect(stopThird).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps reconnecting when the repeated same-cursor state probe fails", async () => {
		vi.useFakeTimers();
		try {
			const stopFirst = vi.fn();
			const stopSecond = vi.fn();
			const stopThird = vi.fn();
			const stopFourth = vi.fn();
			const subscribeMatchStream = vi
				.fn()
				.mockImplementationOnce(
					async (
						matchId: string,
						handler: (event: Parameters<typeof handler>[0]) => Promise<void>,
						options?: MatchStreamSubscriptionOptions,
					) => {
						expect(matchId).toBe("match-1");
						expect(options?.afterId ?? 0).toBe(0);
						queueMicrotask(() => {
							void handler({
								eventVersion: 2,
								eventId: 111,
								ts: "2026-03-18T12:00:00.000Z",
								matchId,
								stateVersion: 55,
								event: "state",
								payload: { state: { game: "snapshot" } },
							});
							queueMicrotask(() => {
								options?.onClose?.();
							});
						});
						return stopFirst;
					},
				)
				.mockImplementationOnce(
					async (
						matchId: string,
						_handler: (event: Parameters<typeof _handler>[0]) => Promise<void>,
						options?: MatchStreamSubscriptionOptions,
					) => {
						expect(matchId).toBe("match-1");
						expect(options?.afterId).toBe(111);
						queueMicrotask(() => {
							options?.onClose?.();
						});
						return stopSecond;
					},
				)
				.mockImplementationOnce(
					async (
						matchId: string,
						_handler: (event: Parameters<typeof _handler>[0]) => Promise<void>,
						options?: MatchStreamSubscriptionOptions,
					) => {
						expect(matchId).toBe("match-1");
						expect(options?.afterId).toBe(111);
						queueMicrotask(() => {
							options?.onClose?.();
						});
						return stopThird;
					},
				)
				.mockImplementationOnce(
					async (
						matchId: string,
						handler: (event: Parameters<typeof handler>[0]) => Promise<void>,
						options?: MatchStreamSubscriptionOptions,
					) => {
						expect(matchId).toBe("match-1");
						expect(options?.afterId).toBe(111);
						queueMicrotask(() => {
							void handler({
								eventVersion: 2,
								eventId: 112,
								ts: "2026-03-18T12:00:01.000Z",
								matchId,
								stateVersion: 56,
								event: "match_ended",
								payload: {
									winnerAgentId: "agent-b",
									loserAgentId: "agent-a",
									reasonCode: "forfeit",
									reason: "forfeit",
								},
							});
						});
						return stopFourth;
					},
				);

			const getMatchState = vi
				.fn()
				.mockRejectedValueOnce(new Error("state lookup failed"));

			const client = {
				me: vi.fn(async () => ({ agentId: "agent-a" })),
				queueJoin: vi.fn(async () => ({
					status: "ready" as const,
					matchId: "match-1",
					opponentId: "agent-b",
				})),
				waitForMatch: vi.fn(),
				submitMove: vi.fn(),
				subscribeMatchStream,
				getMatchState,
			};

			const resultPromise = runMatch(client as never, {
				moveProvider: {
					nextMove: vi.fn(async () => ({ action: "pass" })),
				},
				streamReconnectDelayMs: 10,
			});

			const outcome = await Promise.race([
				resultPromise.then((result) => ({ kind: "result" as const, result })),
				vi.advanceTimersByTimeAsync(1000).then(() => ({
					kind: "timeout" as const,
				})),
			]);

			expect(outcome.kind).toBe("result");
			if (outcome.kind !== "result") return;
			expect(outcome.result).toMatchObject({
				matchId: "match-1",
				reason: "forfeit",
				winnerAgentId: "agent-b",
				loserAgentId: "agent-a",
			});
			expect(getMatchState).toHaveBeenCalledWith("match-1");
			expect(subscribeMatchStream).toHaveBeenCalledTimes(4);
			expect(stopFourth).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
