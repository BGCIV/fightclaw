import { SELF } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { authHeader, resetDb, setupMatch } from "../helpers";

const readStructuredLogs = (...spies: Array<ReturnType<typeof vi.spyOn>>) =>
	spies
		.flatMap((spy) => spy.mock.calls)
		.map(([message]) => {
			if (typeof message !== "string") return null;
			try {
				return JSON.parse(message) as Record<string, unknown>;
			} catch {
				return null;
			}
		})
		.filter((entry): entry is Record<string, unknown> => entry !== null);

beforeEach(async () => {
	await resetDb();
});

it("rejects stale versions", async () => {
	const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
	const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const { matchId, agentA, agentB } = await setupMatch();

		const stateRes = await SELF.fetch(
			`https://example.com/v1/matches/${matchId}/state`,
		);
		const payload = (await stateRes.json()) as {
			state: { stateVersion: number } | null;
		};
		const expectedVersion = payload.state?.stateVersion ?? 0;

		const advanceRes = await SELF.fetch(
			`https://example.com/v1/matches/${matchId}/move`,
			{
				method: "POST",
				headers: {
					...authHeader(agentA.key),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					moveId: crypto.randomUUID(),
					expectedVersion,
					move: { action: "pass" },
				}),
			},
		);
		expect(advanceRes.status).toBe(200);

		const res = await SELF.fetch(
			`https://example.com/v1/matches/${matchId}/move`,
			{
				method: "POST",
				headers: {
					...authHeader(agentB.key),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					moveId: crypto.randomUUID(),
					expectedVersion,
					move: { action: "pass" },
				}),
			},
		);

		expect(res.status).toBe(409);
		const json = (await res.json()) as { ok: boolean; stateVersion?: number };
		expect(json.ok).toBe(false);
		expect(typeof json.stateVersion).toBe("number");

		const logs = readStructuredLogs(infoSpy, warnSpy);
		const conflict = logs.find(
			(entry) => entry.message === "runner_move_conflict",
		);
		expect(conflict).toMatchObject({
			event: "runner_move_conflict",
			route: `/v1/matches/${matchId}/move`,
			expectedVersion,
			actualVersion: expectedVersion + 1,
			delta: 1,
			agentId: agentB.id,
		});
	} finally {
		infoSpy.mockRestore();
		warnSpy.mockRestore();
	}
});

it("rejects wrong agent turn", async () => {
	const { matchId, agentB } = await setupMatch();

	const stateRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	const payload = (await stateRes.json()) as {
		state: { stateVersion: number } | null;
	};

	const res = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/move`,
		{
			method: "POST",
			headers: {
				...authHeader(agentB.key),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				moveId: crypto.randomUUID(),
				expectedVersion: payload.state?.stateVersion ?? 0,
				move: { action: "pass" },
			}),
		},
	);

	expect(res.status).toBe(409);
	const json = (await res.json()) as { ok: boolean };
	expect(json.ok).toBe(false);
});

it("forfeits on invalid move schema", async () => {
	const { matchId, agentA, agentB } = await setupMatch();

	const stateRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	const payload = (await stateRes.json()) as {
		state: { stateVersion: number } | null;
	};

	const res = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/move`,
		{
			method: "POST",
			headers: {
				...authHeader(agentA.key),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				moveId: crypto.randomUUID(),
				expectedVersion: payload.state?.stateVersion ?? 0,
				move: { action: "cheat" },
			}),
		},
	);

	expect(res.status).toBe(400);
	const json = (await res.json()) as {
		forfeited?: boolean;
		matchStatus?: string;
		reason?: string;
		reasonCode?: string;
	};
	expect(json.forfeited).toBe(true);
	expect(json.matchStatus).toBe("ended");
	expect(json.reason).toBe("invalid_move_schema");
	expect(json.reasonCode).toBe("invalid_move_schema");

	const endRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	const endPayload = (await endRes.json()) as {
		state: { status: string; winnerAgentId?: string | null } | null;
	};
	expect(endPayload.state?.status).toBe("ended");
	expect(endPayload.state?.winnerAgentId).toBe(agentB.id);
});

it("applies valid move and increments version", async () => {
	const { matchId, agentA } = await setupMatch();

	const stateRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	const payload = (await stateRes.json()) as {
		state: { stateVersion: number } | null;
	};

	const res = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/move`,
		{
			method: "POST",
			headers: {
				...authHeader(agentA.key),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				moveId: crypto.randomUUID(),
				expectedVersion: payload.state?.stateVersion ?? 0,
				move: { action: "pass" },
			}),
		},
	);

	expect(res.status).toBe(200);
	const json = (await res.json()) as {
		ok: boolean;
		state?: { stateVersion: number };
	};
	expect(json.ok).toBe(true);
	expect(json.state?.stateVersion).toBe((payload.state?.stateVersion ?? 0) + 1);
});
