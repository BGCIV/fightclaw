import { env, SELF } from "cloudflare:test";
import { currentPlayer, listLegalMoves } from "@fightclaw/engine";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	authHeader,
	bindRunnerAgent,
	ensureResetDb,
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
	await ensureResetDb();
});

const SSE_TIMEOUT_MS = 15000;
const SSE_MAX_BYTES = 1_000_000;
const TEST_TIMEOUT_MS = SSE_TIMEOUT_MS + 5000;

// Note: Additional SSE tests (your_turn isolation, game_ended events) were removed
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
	"agent stream replays the remaining terminal tail when resumed just before match_ended",
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

		const stream = await openSse(
			`https://example.com/v1/matches/${matchId}/stream?afterId=${Math.max(
				0,
				terminalEvent.eventId - 1,
			)}`,
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
			const matchEndedCount = (result.text.match(/event: match_ended/g) ?? [])
				.length;
			expect(matchEndedCount).toBe(1);
			expect(result.text).toContain("event: match_ended");
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
