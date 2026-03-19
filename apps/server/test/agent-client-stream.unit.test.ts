import {
	createRunnerSession,
	type MatchStreamSubscriptionOptions,
	runMatch,
} from "@fightclaw/agent-client";
import { describe, expect, it, vi } from "vitest";

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
});
