import { env, SELF } from "cloudflare:test";
import { currentPlayer, listLegalMoves } from "@fightclaw/engine";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	authHeader,
	bindRunnerAgent,
	openSse,
	pollUntil,
	readSseUntil,
	resetDb,
	runnerHeaders,
	setupMatch,
} from "../helpers";

beforeEach(async () => {
	await resetDb();
});

afterEach(async () => {
	await resetDb();
	// Allow stream aborts to propagate and DOs to settle before next test.
	await new Promise((resolve) => setTimeout(resolve, 100));
});

const SSE_TIMEOUT_MS = 15000;
const SSE_MAX_BYTES = 1_000_000;
const TEST_TIMEOUT_MS = SSE_TIMEOUT_MS + 5000;

const readInfoLogs = (spy: ReturnType<typeof vi.spyOn>) => {
	return spy.mock.calls
		.map(([message]) => {
			if (typeof message !== "string") return null;
			try {
				return JSON.parse(message) as Record<string, unknown>;
			} catch {
				return null;
			}
		})
		.filter((entry): entry is Record<string, unknown> => entry !== null);
};

const waitForInfoLog = async (
	spy: ReturnType<typeof vi.spyOn>,
	predicate: (entry: Record<string, unknown>) => boolean,
) => {
	return await pollUntil(
		async () => readInfoLogs(spy),
		(entries) => entries.some(predicate),
		2_000,
		20,
	);
};

// Note: Additional SSE tests (your_turn isolation, terminal alias coverage) were removed
// due to workerd teardown instability. See TEST_SUITE_REVISION.md Priority 4.
// This smoke test verifies basic SSE functionality.

it(
	"spectate stream sends initial state",
	async () => {
		const { matchId } = await setupMatch();

		const stream = await openSse(
			`https://example.com/v1/matches/${matchId}/spectate`,
		);

		let text = "";
		try {
			const result = await readSseUntil(
				stream.res,
				(value) => value.includes("event: state"),
				SSE_TIMEOUT_MS,
				SSE_MAX_BYTES,
				{
					throwOnTimeout: true,
					label: "spectate initial state",
					abortController: stream.controller,
				},
			);
			text = result.text;
		} finally {
			await stream.close();
		}
		expect(text).toContain("event: state");
	},
	TEST_TIMEOUT_MS,
);

it(
	"agent stream emits canonical engine_events envelopes after a move",
	async () => {
		const { matchId, agentA } = await setupMatch();

		const stream = await openSse(
			`https://example.com/v1/matches/${matchId}/stream`,
			authHeader(agentA.key),
		);

		try {
			const waitForEngineEvents = readSseUntil(
				stream.res,
				(value) => value.includes("event: engine_events"),
				SSE_TIMEOUT_MS,
				SSE_MAX_BYTES,
				{
					throwOnTimeout: true,
					label: "agent stream engine_events",
					abortController: stream.controller,
				},
			);

			const stateRes = await SELF.fetch(
				`https://example.com/v1/matches/${matchId}/state`,
				{
					headers: authHeader(agentA.key),
				},
			);
			const stateJson = (await stateRes.json()) as {
				state: { stateVersion: number } | null;
			};
			const expectedVersion = stateJson.state?.stateVersion ?? 0;

			await SELF.fetch(`https://example.com/v1/matches/${matchId}/move`, {
				method: "POST",
				headers: {
					...authHeader(agentA.key),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					moveId: crypto.randomUUID(),
					expectedVersion,
					move: { action: "fortify", unitId: "A-1" },
				}),
			});

			const result = await waitForEngineEvents;
			const frame =
				result.framesPreview.find((value) =>
					value.includes("event: engine_events"),
				) ?? null;
			expect(frame).toBeTruthy();

			const dataLine =
				frame?.split("\n").find((line) => line.startsWith("data: ")) ?? null;
			expect(dataLine).toBeTruthy();

			const payload = JSON.parse(String(dataLine).slice("data: ".length)) as {
				event?: string;
				eventId?: unknown;
				stateVersion?: unknown;
				payload?: {
					engineEvents?: unknown[];
				};
			};

			expect(payload.event).toBe("engine_events");
			expect(typeof payload.eventId).toBe("number");
			expect(typeof payload.stateVersion).toBe("number");
			expect(Array.isArray(payload.payload?.engineEvents)).toBe(true);
		} finally {
			await stream.close();
		}
	},
	TEST_TIMEOUT_MS,
);

it(
	"spectator stream replays missed canonical events when afterId is provided",
	async () => {
		const { matchId, agentA } = await setupMatch();

		const stateRes = await SELF.fetch(
			`https://example.com/v1/matches/${matchId}/state`,
		);
		const stateJson = (await stateRes.json()) as {
			state: { stateVersion: number } | null;
		};
		const expectedVersion = stateJson.state?.stateVersion ?? 0;

		await SELF.fetch(`https://example.com/v1/matches/${matchId}/move`, {
			method: "POST",
			headers: {
				...authHeader(agentA.key),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				moveId: crypto.randomUUID(),
				expectedVersion,
				move: { action: "fortify", unitId: "A-1" },
			}),
		});

		const firstPageRes = await SELF.fetch(
			`https://example.com/v1/matches/${matchId}/log?limit=1`,
		);
		const firstPage = (await firstPageRes.json()) as {
			nextAfterId?: number | null;
		};
		const afterId = firstPage.nextAfterId ?? 0;

		const stream = await openSse(
			`https://example.com/v1/matches/${matchId}/spectate?afterId=${afterId}`,
		);

		try {
			const result = await readSseUntil(
				stream.res,
				(value) => value.includes("event: engine_events"),
				SSE_TIMEOUT_MS,
				SSE_MAX_BYTES,
				{
					throwOnTimeout: true,
					label: "spectate afterId replay",
					abortController: stream.controller,
				},
			);
			const frame =
				result.framesPreview.find((value) =>
					value.includes("event: engine_events"),
				) ?? null;
			expect(frame).toBeTruthy();
			const dataLine =
				frame?.split("\n").find((line) => line.startsWith("data: ")) ?? null;
			expect(dataLine).toBeTruthy();
			const payload = JSON.parse(String(dataLine).slice("data: ".length)) as {
				event?: string;
				eventId?: unknown;
			};
			expect(payload.event).toBe("engine_events");
			expect(typeof payload.eventId).toBe("number");
			expect((payload.eventId as number) > afterId).toBe(true);
		} finally {
			await stream.close();
		}
	},
	TEST_TIMEOUT_MS,
);

it(
	"logs stream attach and replay summaries when spectating with afterId",
	async () => {
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			const { matchId, agentA } = await setupMatch();

			const stateRes = await SELF.fetch(
				`https://example.com/v1/matches/${matchId}/state`,
			);
			const stateJson = (await stateRes.json()) as {
				state: { stateVersion: number } | null;
			};
			const expectedVersion = stateJson.state?.stateVersion ?? 0;

			await SELF.fetch(`https://example.com/v1/matches/${matchId}/move`, {
				method: "POST",
				headers: {
					...authHeader(agentA.key),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					moveId: crypto.randomUUID(),
					expectedVersion,
					move: { action: "fortify", unitId: "A-1" },
				}),
			});

			const firstPageRes = await SELF.fetch(
				`https://example.com/v1/matches/${matchId}/log?limit=1`,
			);
			const firstPage = (await firstPageRes.json()) as {
				nextAfterId?: number | null;
			};
			const afterId = firstPage.nextAfterId ?? 0;

			const resumedStateRes = await SELF.fetch(
				`https://example.com/v1/matches/${matchId}/state`,
			);
			const resumedStateJson = (await resumedStateRes.json()) as {
				state: { stateVersion: number } | null;
			};
			const resumedStateVersion = resumedStateJson.state?.stateVersion ?? 0;

			const stream = await openSse(
				`https://example.com/v1/matches/${matchId}/spectate?afterId=${afterId}`,
			);

			try {
				const result = await readSseUntil(
					stream.res,
					(value) => value.includes("event: engine_events"),
					SSE_TIMEOUT_MS,
					SSE_MAX_BYTES,
					{
						throwOnTimeout: true,
						label: "spectate afterId replay logs",
						abortController: stream.controller,
					},
				);
				expect(result.text).toContain("event: engine_events");

				const logs = readInfoLogs(infoSpy);
				const attached = logs.find(
					(entry) => entry.message === "runner_stream_attached",
				);
				const replayed = logs.find(
					(entry) => entry.message === "runner_stream_replayed",
				);

				expect(attached).toMatchObject({
					event: "runner_stream_attached",
					route: `/v1/matches/${matchId}/spectate`,
					streamKind: "spectator",
					afterId,
				});
				expect(replayed).toMatchObject({
					event: "runner_stream_replayed",
					route: `/v1/matches/${matchId}/spectate`,
					streamKind: "spectator",
					afterId,
					stateVersion: resumedStateVersion,
				});
				expect(
					typeof replayed?.replayedCount === "number" &&
						Number.isFinite(replayed.replayedCount as number),
				).toBe(true);
			} finally {
				await stream.close();
			}
		} finally {
			infoSpy.mockRestore();
		}
	},
	TEST_TIMEOUT_MS,
);

it(
	"does not duplicate match_ended when resuming just before a terminal match event",
	async () => {
		const { matchId, agentA } = await setupMatch();

		const finishRes = await SELF.fetch(
			`https://example.com/v1/matches/${matchId}/finish`,
			{
				method: "POST",
				headers: {
					...authHeader(agentA.key),
					"content-type": "application/json",
					"x-admin-key": env.ADMIN_KEY,
				},
				body: JSON.stringify({ reason: "forfeit" }),
			},
		);
		expect(finishRes.ok).toBe(true);

		const hasTerminalEvent = (payload: {
			events: Array<{ event: string; eventId: number }>;
		}) => payload.events.some((event) => event.event === "match_ended");

		const terminalPage = await pollUntil(async () => {
			const res = await SELF.fetch(
				`https://example.com/v1/matches/${matchId}/log?limit=50`,
			);
			expect(res.ok).toBe(true);
			return (await res.json()) as {
				events: Array<{ event: string; eventId: number }>;
			};
		}, hasTerminalEvent);

		const terminalEvent = terminalPage.events.find(
			(event) => event.event === "match_ended",
		);
		expect(terminalEvent).toBeTruthy();
		if (!terminalEvent) throw new Error("Missing terminal log event.");

		const stream = await openSse(
			`https://example.com/v1/matches/${matchId}/spectate?afterId=${Math.max(
				0,
				terminalEvent.eventId - 1,
			)}`,
		);

		try {
			const result = await readSseUntil(
				stream.res,
				() => false,
				1250,
				SSE_MAX_BYTES,
				{
					abortController: stream.controller,
				},
			);
			const matchEndedCount = (result.text.match(/event: match_ended/g) ?? [])
				.length;
			expect(matchEndedCount).toBe(1);
			expect(result.text).toContain("event: state");
			expect(result.text).toContain("event: match_ended");
			expect(result.text).not.toContain("event: game_ended");
		} finally {
			await stream.close();
		}
	},
	TEST_TIMEOUT_MS,
);

it(
	"replays the remaining terminal tail on resumed agent streams and closes cleanly",
	async () => {
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			const { matchId, agentA } = await setupMatch();

			const finishRes = await SELF.fetch(
				`https://example.com/v1/matches/${matchId}/finish`,
				{
					method: "POST",
					headers: {
						...authHeader(agentA.key),
						"content-type": "application/json",
						"x-admin-key": env.ADMIN_KEY,
					},
					body: JSON.stringify({ reason: "forfeit" }),
				},
			);
			expect(finishRes.ok).toBe(true);

			const terminalPage = await pollUntil(
				async () => {
					const res = await SELF.fetch(
						`https://example.com/v1/matches/${matchId}/log?limit=50`,
					);
					expect(res.ok).toBe(true);
					return (await res.json()) as {
						events: Array<{ event: string; eventId: number }>;
					};
				},
				({ events }) => events.some((event) => event.event === "match_ended"),
			);

			const terminalEvent = terminalPage.events.find(
				(event) => event.event === "match_ended",
			);
			expect(terminalEvent).toBeTruthy();
			if (!terminalEvent) throw new Error("Missing terminal log event.");

			const afterId = Math.max(0, terminalEvent.eventId - 1);
			const stream = await openSse(
				`https://example.com/v1/matches/${matchId}/stream?afterId=${afterId}`,
				authHeader(agentA.key),
			);
			expect(stream.res.ok).toBe(true);

			try {
				const result = await readSseUntil(
					stream.res,
					(value) => value.includes("event: match_ended"),
					SSE_TIMEOUT_MS,
					SSE_MAX_BYTES,
					{
						throwOnTimeout: true,
						label: "agent stream terminal tail replay",
						abortController: stream.controller,
					},
				);
				expect(result.text).toContain("event: match_ended");
				expect(result.text).not.toContain("event: game_ended");

				const logs = readInfoLogs(infoSpy);
				const replayed = logs.find(
					(entry) => entry.message === "runner_stream_replayed",
				);
				await waitForInfoLog(
					infoSpy,
					(entry) =>
						entry.message === "runner_stream_closed" &&
						entry.route === `/v1/matches/${matchId}/stream`,
				);
				const closed = readInfoLogs(infoSpy).find(
					(entry) =>
						entry.message === "runner_stream_closed" &&
						entry.route === `/v1/matches/${matchId}/stream`,
				);

				expect(replayed).toMatchObject({
					event: "runner_stream_replayed",
					route: `/v1/matches/${matchId}/stream`,
					streamKind: "agent",
					afterId,
					replayedTerminal: true,
				});
				expect(closed).toMatchObject({
					event: "runner_stream_closed",
					route: `/v1/matches/${matchId}/stream`,
					streamKind: "agent",
					reason: "terminal_complete",
				});
			} finally {
				await stream.close();
			}
		} finally {
			infoSpy.mockRestore();
		}
	},
	TEST_TIMEOUT_MS,
);

it(
	"logs a terminal stream close exactly once when spectate ends",
	async () => {
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			const { matchId, agentA } = await setupMatch();

			const finishRes = await SELF.fetch(
				`https://example.com/v1/matches/${matchId}/finish`,
				{
					method: "POST",
					headers: {
						...authHeader(agentA.key),
						"content-type": "application/json",
						"x-admin-key": env.ADMIN_KEY,
					},
					body: JSON.stringify({ reason: "forfeit" }),
				},
			);
			expect(finishRes.ok).toBe(true);

			const stream = await openSse(
				`https://example.com/v1/matches/${matchId}/spectate`,
			);

			try {
				const result = await readSseUntil(
					stream.res,
					(value) => value.includes("event: match_ended"),
					SSE_TIMEOUT_MS,
					SSE_MAX_BYTES,
					{
						throwOnTimeout: true,
						label: "terminal spectate close",
						abortController: stream.controller,
					},
				);
				expect(result.text).toContain("event: state");
				expect(result.text).toContain("event: match_ended");
				expect(result.text).not.toContain("event: game_ended");

				await waitForInfoLog(
					infoSpy,
					(entry) =>
						entry.message === "runner_stream_closed" &&
						entry.route === `/v1/matches/${matchId}/spectate`,
				);
				const closed = readInfoLogs(infoSpy).filter(
					(entry) => entry.message === "runner_stream_closed",
				);
				expect(closed).toHaveLength(1);
				expect(closed[0]).toMatchObject({
					event: "runner_stream_closed",
					route: `/v1/matches/${matchId}/spectate`,
					streamKind: "spectator",
					reason: "terminal_complete",
				});
			} finally {
				await stream.close();
			}
		} finally {
			infoSpy.mockRestore();
		}
	},
	TEST_TIMEOUT_MS,
);

it(
	"does not emit game_ended on live terminal agent streams",
	async () => {
		const { matchId, agentA } = await setupMatch();

		const stream = await openSse(
			`https://example.com/v1/matches/${matchId}/stream`,
			authHeader(agentA.key),
		);

		try {
			const waitForTerminal = readSseUntil(
				stream.res,
				() => false,
				SSE_TIMEOUT_MS,
				SSE_MAX_BYTES,
				{
					label: "agent terminal",
					abortController: stream.controller,
				},
			);

			const finishRes = await SELF.fetch(
				`https://example.com/v1/matches/${matchId}/finish`,
				{
					method: "POST",
					headers: {
						...authHeader(agentA.key),
						"content-type": "application/json",
						"x-admin-key": env.ADMIN_KEY,
					},
					body: JSON.stringify({ reason: "forfeit" }),
				},
			);
			expect(finishRes.ok).toBe(true);

			const result = await waitForTerminal;
			expect(result.text).toContain("event: state");
			expect(result.text).toContain("event: match_ended");
			expect(result.text).not.toContain("event: game_ended");
		} finally {
			await stream.close();
		}
	},
	TEST_TIMEOUT_MS,
);

it(
	"spectate stream emits engine_events after successful move",
	async () => {
		const { matchId, agentA } = await setupMatch();

		const stream = await openSse(
			`https://example.com/v1/matches/${matchId}/spectate`,
		);

		try {
			// Begin consuming the SSE stream before applying the move so DO writes don't
			// backpressure and hit the SSE write timeout.
			const waitForEngineEvents = readSseUntil(
				stream.res,
				(value) => value.includes("event: engine_events"),
				SSE_TIMEOUT_MS,
				SSE_MAX_BYTES,
				{
					throwOnTimeout: true,
					label: "engine_events",
					abortController: stream.controller,
				},
			);

			const stateRes = await SELF.fetch(
				`https://example.com/v1/matches/${matchId}/state`,
			);
			const stateJson = (await stateRes.json()) as {
				state: { stateVersion: number } | null;
			};
			const expectedVersion = stateJson.state?.stateVersion ?? 0;

			await SELF.fetch(`https://example.com/v1/matches/${matchId}/move`, {
				method: "POST",
				headers: {
					...{ authorization: `Bearer ${agentA.key}` },
					"content-type": "application/json",
				},
				body: JSON.stringify({
					moveId: crypto.randomUUID(),
					expectedVersion,
					move: { action: "fortify", unitId: "A-1" },
				}),
			});

			const result = await waitForEngineEvents;

			const frame =
				result.framesPreview.find((value) =>
					value.includes("event: engine_events"),
				) ?? null;
			expect(frame).toBeTruthy();

			const dataLine =
				frame?.split("\n").find((line) => line.startsWith("data: ")) ?? null;
			expect(dataLine).toBeTruthy();

			const payload = JSON.parse(String(dataLine).slice("data: ".length)) as {
				event?: string;
				payload?: {
					engineEvents?: unknown[];
				};
			};

			expect(payload.event).toBe("engine_events");
			const engineEvents = Array.isArray(payload.payload?.engineEvents)
				? payload.payload.engineEvents
				: [];
			expect(
				engineEvents.some((event) => {
					if (!event || typeof event !== "object") return false;
					const record = event as { type?: unknown; at?: unknown };
					return record.type === "fortify" && typeof record.at === "string";
				}),
			).toBe(true);
		} finally {
			await stream.close();
		}
	},
	TEST_TIMEOUT_MS,
);

it(
	"spectate stream emits sanitized agent_thought for accepted internal moves",
	async () => {
		const { matchId, agentA, agentB } = await setupMatch();
		await bindRunnerAgent(agentA.id);
		await bindRunnerAgent(agentB.id);

		const stream = await openSse(
			`https://example.com/v1/matches/${matchId}/spectate`,
		);

		try {
			const waitForThought = readSseUntil(
				stream.res,
				(value) => value.includes("event: agent_thought"),
				SSE_TIMEOUT_MS,
				SSE_MAX_BYTES,
				{
					throwOnTimeout: true,
					label: "agent_thought",
					abortController: stream.controller,
				},
			);

			const stateRes = await SELF.fetch(
				`https://example.com/v1/matches/${matchId}/state`,
			);
			const stateJson = (await stateRes.json()) as {
				state: {
					stateVersion: number;
					game: Parameters<typeof listLegalMoves>[0];
				} | null;
			};
			const state = stateJson.state;
			expect(state).toBeTruthy();
			const game = state?.game;
			if (!game) throw new Error("Missing game state.");
			const activeAgentId = currentPlayer(game);
			const move = listLegalMoves(game)[0];
			if (!move) throw new Error("No legal move available.");

			await SELF.fetch(
				`https://example.com/v1/internal/matches/${matchId}/move`,
				{
					method: "POST",
					headers: {
						...runnerHeaders(),
						"content-type": "application/json",
						"x-agent-id": activeAgentId,
					},
					body: JSON.stringify({
						moveId: crypto.randomUUID(),
						expectedVersion: state?.stateVersion ?? 0,
						move,
						publicThought: "  Attack now.\nKeep pressure. \u0007  ",
					}),
				},
			);

			const result = await waitForThought;
			const frame =
				result.framesPreview.find((value) =>
					value.includes("event: agent_thought"),
				) ?? null;
			expect(frame).toBeTruthy();
			const dataLine =
				frame?.split("\n").find((line) => line.startsWith("data: ")) ?? null;
			expect(dataLine).toBeTruthy();
			const payload = JSON.parse(String(dataLine).slice("data: ".length)) as {
				event?: string;
				payload?: {
					text?: string;
					player?: string;
				};
			};
			expect(payload.event).toBe("agent_thought");
			expect(
				payload.payload?.player === "A" || payload.payload?.player === "B",
			).toBe(true);
			expect(payload.payload?.text).toBe("Attack now. Keep pressure.");
		} finally {
			await stream.close();
		}
	},
	TEST_TIMEOUT_MS,
);
