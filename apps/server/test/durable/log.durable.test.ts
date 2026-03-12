import { SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { resetDb, setupMatch } from "../helpers";

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
		events: Array<{ eventType: string; payload: unknown }>;
	};
	expect(logJson.matchId).toBe(matchId);

	const moveApplied = logJson.events.find(
		(event) => event.eventType === "move_applied",
	);
	const matchStarted = logJson.events.find(
		(event) => event.eventType === "match_started",
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
	const payload = moveApplied?.payload as
		| {
				payloadVersion?: unknown;
				moveId?: unknown;
				engineEvents?: unknown;
		  }
		| undefined;

	expect(payload?.payloadVersion).toBe(2);
	expect(typeof payload?.moveId).toBe("string");
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
		events: Array<{ id: number }>;
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
		events: Array<{ id: number }>;
		hasMore?: boolean;
		nextAfterId?: number | null;
	};
	expect(secondPage.events.length).toBeGreaterThan(0);
	expect(secondPage.events[0]?.id).toBeGreaterThan(cursor);
	expect(typeof secondPage.hasMore).toBe("boolean");
	expect(
		secondPage.nextAfterId === null ||
			typeof secondPage.nextAfterId === "number",
	).toBe(true);
});
