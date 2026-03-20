import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { authHeader, pollUntil, resetDb, setupMatch } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

it("exposes match_events log for active featured match with engineEvents payload", async () => {
	const { matchId, agentA } = await setupMatch();

	const featuredRes = await SELF.fetch("https://example.com/v1/featured");
	expect(featuredRes.ok).toBe(true);
	const featuredJson = (await featuredRes.json()) as { matchId: string | null };
	expect(featuredJson.matchId).toBe(matchId);

	const stateRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	expect(stateRes.ok).toBe(true);
	const stateJson = (await stateRes.json()) as {
		state: { stateVersion: number } | null;
	};
	const expectedVersion = stateJson.state?.stateVersion ?? 0;

	await SELF.fetch(`https://example.com/v1/matches/${matchId}/move`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${agentA.key}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			moveId: crypto.randomUUID(),
			expectedVersion,
			move: { action: "fortify", unitId: "A-1" },
		}),
	});

	const logRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/log`,
	);
	expect(logRes.ok).toBe(true);
	const logJson = (await logRes.json()) as {
		matchId: string;
		events: Array<{
			event: string;
			eventId: number;
			stateVersion: number | null;
			payload: unknown;
		}>;
	};
	expect(logJson.matchId).toBe(matchId);

	const moveApplied = logJson.events.find(
		(event) => event.event === "engine_events",
	);
	const matchStarted = logJson.events.find(
		(event) => event.event === "match_started",
	);
	expect(matchStarted).toBeTruthy();
	const startedPayload = matchStarted?.payload as
		| {
				seed?: unknown;
				players?: unknown;
				engineConfig?: { boardColumns?: unknown };
		  }
		| undefined;
	expect(typeof startedPayload?.seed).toBe("number");
	expect(Array.isArray(startedPayload?.players)).toBe(true);
	expect(startedPayload?.engineConfig?.boardColumns).toBe(17);

	expect(moveApplied).toBeTruthy();
	expect(typeof moveApplied?.eventId).toBe("number");
	expect(
		typeof moveApplied?.stateVersion === "number" ||
			moveApplied?.stateVersion === null,
	).toBe(true);
	const payload = moveApplied?.payload as
		| {
				moveId?: unknown;
				move?: unknown;
				engineEvents?: unknown;
		  }
		| undefined;

	expect(typeof payload?.moveId).toBe("string");
	expect(payload?.move).toBeTruthy();
	expect(Array.isArray(payload?.engineEvents)).toBe(true);
});

it("provides pagination metadata for replay log consumers", async () => {
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
			authorization: `Bearer ${agentA.key}`,
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
	expect(firstPageRes.ok).toBe(true);
	const firstPage = (await firstPageRes.json()) as {
		matchId: string;
		events: Array<{ eventId: number }>;
		hasMore?: boolean;
		nextAfterId?: number | null;
	};
	expect(firstPage.matchId).toBe(matchId);
	expect(firstPage.events.length).toBe(1);
	expect(firstPage.hasMore).toBe(true);
	expect(typeof firstPage.nextAfterId).toBe("number");

	const cursor = firstPage.nextAfterId as number;
	const secondPageRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/log?limit=2&afterId=${cursor}`,
	);
	expect(secondPageRes.ok).toBe(true);
	const secondPage = (await secondPageRes.json()) as {
		events: Array<{ eventId: number }>;
		hasMore?: boolean;
		nextAfterId?: number | null;
	};
	expect(secondPage.events.length).toBeGreaterThan(0);
	secondPage.events.forEach((event) => {
		expect(event.eventId).toBeGreaterThan(cursor);
	});
	expect(typeof secondPage.hasMore).toBe("boolean");
	expect(
		secondPage.nextAfterId === null ||
			typeof secondPage.nextAfterId === "number",
	).toBe(true);
});

it("keeps the replay cursor strict at the terminal boundary", async () => {
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
		(payload) => payload.events.some((event) => event.event === "match_ended"),
	);

	const terminalEvent = terminalPage.events.find(
		(event) => event.event === "match_ended",
	);
	expect(terminalEvent).toBeTruthy();
	if (!terminalEvent) throw new Error("Missing terminal log event.");

	const replayRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/log?afterId=${terminalEvent.eventId}`,
	);
	expect(replayRes.ok).toBe(true);
	const replayJson = (await replayRes.json()) as {
		events: Array<{ event: string; eventId: number }>;
	};

	expect(replayJson.events.some((event) => event.event === "match_ended")).toBe(
		false,
	);
	expect(
		replayJson.events.every((event) => event.eventId > terminalEvent.eventId),
	).toBe(true);
});
