import { beforeEach, describe, expect, it, vi } from "vitest";

describe("runner session observability helper", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("builds a fallback correlation id and runner move conflict payloads", async () => {
		vi.stubGlobal("crypto", {
			...globalThis.crypto,
			randomUUID: vi.fn(() => "generated-correlation-id"),
		});

		const { buildRunnerSessionObservability } = await import(
			"../src/obs/runnerSession"
		);

		const obs = buildRunnerSessionObservability({
			requestId: null,
			route: "/v1/matches/123/move",
		});

		expect(obs.correlationId).toBe("generated-correlation-id");
		expect(obs.base.requestId).toBeNull();
		expect(obs.base.route).toBe("/v1/matches/123/move");

		expect(
			obs.buildMoveConflict({ expectedVersion: 7, actualVersion: 9 }),
		).toEqual({
			event: "runner_move_conflict",
			scope: "match_do",
			requestId: null,
			correlationId: "generated-correlation-id",
			route: "/v1/matches/123/move",
			transport: "sse",
			agentId: null,
			matchId: null,
			expectedVersion: 7,
			actualVersion: 9,
			delta: 2,
		});
	});

	it("builds queue wait and stream close observability payloads", async () => {
		vi.stubGlobal("crypto", {
			...globalThis.crypto,
			randomUUID: vi.fn(() => "generated-correlation-id"),
		});

		const { buildRunnerSessionObservability } = await import(
			"../src/obs/runnerSession"
		);

		const obsWait = buildRunnerSessionObservability({
			requestId: "req-1",
			agentId: "agent-1",
			route: "/v1/events/wait",
		});

		expect(obsWait.buildQueueWaitStarted({ timeoutSeconds: 30 })).toEqual({
			event: "runner_queue_wait_started",
			scope: "matchmaker_do",
			requestId: "req-1",
			correlationId: "req-1",
			route: "/v1/events/wait",
			transport: "sse",
			agentId: "agent-1",
			matchId: null,
			timeoutSeconds: 30,
		});

		const obsStream = buildRunnerSessionObservability({
			requestId: "req-1",
			agentId: "agent-1",
			matchId: "match-1",
			route: "/v1/matches/match-1/stream",
		});

		expect(
			obsStream.buildStreamReplay({
				streamKind: "agent",
				afterId: 11,
				replayedCount: 3,
				replayedTerminal: true,
				stateVersion: 21,
			}),
		).toEqual({
			event: "runner_stream_replayed",
			scope: "match_do",
			requestId: "req-1",
			correlationId: "req-1",
			route: "/v1/matches/match-1/stream",
			transport: "sse",
			agentId: "agent-1",
			matchId: "match-1",
			streamKind: "agent",
			afterId: 11,
			replayedCount: 3,
			replayedTerminal: true,
			stateVersion: 21,
		});

		expect(
			obsStream.buildStreamClosed({
				streamKind: "spectator",
				reason: "write_timeout",
				afterId: 11,
				lastObservedEventId: 15,
			}),
		).toEqual({
			event: "runner_stream_closed",
			scope: "match_do",
			requestId: "req-1",
			correlationId: "req-1",
			route: "/v1/matches/match-1/stream",
			transport: "sse",
			agentId: "agent-1",
			matchId: "match-1",
			streamKind: "spectator",
			reason: "write_timeout",
			afterId: 11,
			lastObservedEventId: 15,
		});
	});

	it("emits runner-session metric wrappers with the new event names", async () => {
		const writeDataPoint = vi.fn();

		const { buildRunnerSessionObservability } = await import(
			"../src/obs/runnerSession"
		);

		const obs = buildRunnerSessionObservability({
			requestId: "req-2",
			agentId: "agent-2",
			matchId: "match-2",
			route: "/v1/matches/match-2/stream",
		});

		const env = {
			OBS: { writeDataPoint } as unknown,
			SENTRY_ENVIRONMENT: "test",
			TEST_MODE: false,
		};

		obs.emitQueueWaitNoEvents(env);
		obs.emitStreamResume(env);
		obs.emitStreamDisconnect(env);
		obs.emitMoveConflict(env);

		expect(writeDataPoint).toHaveBeenCalledTimes(4);
		expect(
			writeDataPoint.mock.calls.map(([entry]) => entry.indexes[0]),
		).toEqual([
			"runner_queue_wait_no_events",
			"runner_stream_resume",
			"runner_stream_disconnect",
			"runner_move_conflict",
		]);
		expect(writeDataPoint.mock.calls[0]?.[0]).toMatchObject({
			blobs: [
				"test",
				"matchmaker_do",
				null,
				null,
				null,
				"req-2",
				"agent-2",
				"match-2",
				null,
				null,
				null,
			],
		});
	});
});
