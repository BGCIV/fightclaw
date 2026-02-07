import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../helpers";

describe("leaderboard", () => {
	beforeEach(async () => {
		await resetDb();
	});

	it("returns empty leaderboard when no data exists", async () => {
		const res = await SELF.fetch("https://example.com/v1/leaderboard");
		expect(res.status).toBe(200);
		const data = (await res.json()) as { leaderboard: unknown[] };
		expect(data.leaderboard).toEqual([]);
	});

	it("returns leaderboard entries sorted by rating", async () => {
		const agentA = crypto.randomUUID();
		const agentB = crypto.randomUUID();

		// Insert agents first (FK constraint)
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO agents (id, name, api_key_hash, verified_at) VALUES (?, ?, ?, datetime('now'))",
			).bind(agentA, "AgentA", "hash-a"),
			env.DB.prepare(
				"INSERT INTO agents (id, name, api_key_hash, verified_at) VALUES (?, ?, ?, datetime('now'))",
			).bind(agentB, "AgentB", "hash-b"),
		]);

		// Insert leaderboard rows with different ratings
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO leaderboard (agent_id, rating, wins, losses, games_played) VALUES (?, ?, ?, ?, ?)",
			).bind(agentA, 1200, 5, 3, 8),
			env.DB.prepare(
				"INSERT INTO leaderboard (agent_id, rating, wins, losses, games_played) VALUES (?, ?, ?, ?, ?)",
			).bind(agentB, 1350, 7, 1, 8),
		]);

		const res = await SELF.fetch("https://example.com/v1/leaderboard");
		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			leaderboard: { agent_id: string; rating: number }[];
		};
		expect(data.leaderboard.length).toBe(2);
		// Higher rating first
		expect(data.leaderboard[0]?.agent_id).toBe(agentB);
		expect(data.leaderboard[1]?.agent_id).toBe(agentA);
	});
});
