import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { openSse, resetDb, setupMatch } from "../helpers";

const matchId = "11111111-1111-4111-8111-111111111111";

// Auth test consolidation: Keeping one test per auth type.
// Removed redundant middleware checks (queue join/status/leave, stream, events wait)
// since they all verify the same Hono middleware wiring.
// See TEST_SUITE_REVISION.md Priority 6.

describe("auth", () => {
	afterEach(async () => {
		await resetDb();
		await new Promise((resolve) => setTimeout(resolve, 100));
	});

	it("requires auth for queue", async () => {
		const res = await SELF.fetch("https://example.com/v1/matches/queue", {
			method: "POST",
		});
		expect(res.status).toBe(401);
	});

	it("requires auth for move submission", async () => {
		const res = await SELF.fetch(
			`https://example.com/v1/matches/${matchId}/move`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({
					moveId: "test",
					expectedVersion: 0,
					move: { action: "pass" },
				}),
			},
		);
		expect(res.status).toBe(401);
	});

	it("allows public state and spectate", async () => {
		const { matchId: publicMatchId } = await setupMatch(
			"PublicAlpha",
			"public-alpha-key",
			"PublicBeta",
			"public-beta-key",
		);
		const stateRes = await SELF.fetch(
			`https://example.com/v1/matches/${publicMatchId}/state`,
		);
		expect(stateRes.status).toBe(200);

		const stream = await openSse(
			`https://example.com/v1/matches/${publicMatchId}/spectate`,
		);
		try {
			expect(stream.res.status).toBe(200);
		} finally {
			await stream.close();
		}
	});

	it("allows public events stream", async () => {
		const stream = await openSse(
			`https://example.com/v1/matches/${matchId}/events`,
		);
		try {
			expect(stream.res.status).toBe(200);
		} finally {
			await stream.close();
		}
	});
});
