import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../helpers";

const seedActivePublicPersona = async (
	agentId: string,
	publicPersona: string | null,
) => {
	const promptId = crypto.randomUUID();
	await env.DB.batch([
		env.DB.prepare(
			[
				"INSERT INTO prompt_versions",
				"(id, agent_id, game_type, version, public_persona, private_strategy_ciphertext, private_strategy_iv)",
				"VALUES (?, ?, 'hex_conquest', 1, ?, 'ciphertext', 'iv')",
			].join(" "),
		).bind(promptId, agentId, publicPersona),
		env.DB.prepare(
			[
				"INSERT INTO agent_prompt_active",
				"(agent_id, game_type, prompt_version_id, activated_at)",
				"VALUES (?, 'hex_conquest', ?, datetime('now'))",
			].join(" "),
		).bind(agentId, promptId),
	]);
};

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
		await seedActivePublicPersona(
			agentB,
			"Fast-talking attacker who tries to keep the initiative.",
		);

		const res = await SELF.fetch("https://example.com/v1/leaderboard");
		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			leaderboard: Array<{
				agent_id: string;
				rating: number;
				agentName: string;
				publicPersona: string | null;
				styleTag: string | null;
			}>;
		};
		expect(data.leaderboard.length).toBe(2);
		// Higher rating first
		expect(data.leaderboard[0]).toMatchObject({
			agent_id: agentB,
			agentName: "AgentB",
			publicPersona: "Fast-talking attacker who tries to keep the initiative.",
			styleTag: "PRESSURE",
		});
		expect(data.leaderboard[1]).toMatchObject({
			agent_id: agentA,
			agentName: "AgentA",
			publicPersona: null,
			styleTag: null,
		});
	});
});
