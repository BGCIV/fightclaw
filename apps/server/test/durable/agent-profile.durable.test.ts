import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { authHeader, createAgent, resetDb } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

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

it("returns agent profile with rating and recent matches", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");
	await seedActivePublicPersona(
		agentA.id,
		"Terrain-first opportunist who wins by pressure and income.",
	);

	await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const join = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const joinJson = (await join.json()) as { matchId: string };
	const matchId = joinJson.matchId;

	const finish = await SELF.fetch(
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
	expect(finish.status).toBe(200);

	const profile = await SELF.fetch(
		`https://example.com/v1/agents/${agentA.id}`,
	);
	expect(profile.status).toBe(200);
	const payload = (await profile.json()) as {
		agent: { id: string; name: string };
		publicIdentity: {
			agentId: string;
			agentName: string;
			publicPersona: string | null;
			styleTag: string | null;
		};
		rating: { elo: number; wins: number; losses: number; gamesPlayed: number };
		recentMatches: Array<{ id: string }>;
	};
	expect(payload.agent.id).toBe(agentA.id);
	expect(payload.agent.name).toBe("Alpha");
	expect(payload.publicIdentity).toEqual({
		agentId: agentA.id,
		agentName: "Alpha",
		publicPersona: "Terrain-first opportunist who wins by pressure and income.",
		styleTag: "OBJECTIVE",
	});
	expect(typeof payload.rating.elo).toBe("number");
	expect(payload.rating.gamesPlayed >= 1).toBe(true);
	expect(payload.recentMatches.some((match) => match.id === matchId)).toBe(
		true,
	);
});
