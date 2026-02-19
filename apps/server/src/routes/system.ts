import { Hono } from "hono";

import type { AppBindings, AppVariables } from "../appTypes";
import { internalServerError } from "../utils/httpErrors";

export const systemRoutes = new Hono<{
	Bindings: AppBindings;
	Variables: AppVariables;
}>();

systemRoutes.get("/", (c) => {
	return c.text("OK");
});

systemRoutes.get("/health", (c) => {
	return c.text("OK");
});

systemRoutes.get("/v1/leaderboard", async (c) => {
	const limitRaw = c.req.query("limit");
	const parsed = limitRaw ? Number.parseInt(limitRaw, 10) : 100;
	const limit =
		Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 100;
	try {
		const { results } = await c.env.DB.prepare(
			"SELECT agent_id, rating, wins, losses, games_played, updated_at FROM leaderboard ORDER BY rating DESC LIMIT ?",
		)
			.bind(limit)
			.all();
		return c.json({ leaderboard: results ?? [] });
	} catch (error) {
		console.error("Failed to load leaderboard", error);
		return internalServerError(c, "Leaderboard unavailable");
	}
});

systemRoutes.get("/v1/agents/:id", async (c) => {
	const agentId = c.req.param("id");
	if (!agentId)
		return c.json({ ok: false, error: "Agent id is required." }, 400);

	try {
		const agent = await c.env.DB.prepare(
			[
				"SELECT a.id, a.name, a.created_at, a.verified_at,",
				"l.rating, l.wins, l.losses, l.games_played, l.updated_at",
				"FROM agents a",
				"LEFT JOIN leaderboard l ON l.agent_id = a.id",
				"WHERE a.id = ?",
				"LIMIT 1",
			].join(" "),
		)
			.bind(agentId)
			.first<{
				id: string;
				name: string;
				created_at: string;
				verified_at: string | null;
				rating: number | null;
				wins: number | null;
				losses: number | null;
				games_played: number | null;
				updated_at: string | null;
			}>();
		if (!agent) return c.json({ ok: false, error: "Agent not found." }, 404);

		const { results: recent } = await c.env.DB.prepare(
			[
				"SELECT m.id, m.status, m.created_at, m.ended_at, m.winner_agent_id, m.end_reason, m.final_state_version",
				"FROM matches m",
				"LEFT JOIN match_players mp ON mp.match_id = m.id",
				"WHERE mp.agent_id = ?",
				"ORDER BY COALESCE(m.ended_at, m.created_at) DESC",
				"LIMIT 20",
			].join(" "),
		)
			.bind(agentId)
			.all();

		return c.json({
			agent: {
				id: agent.id,
				name: agent.name,
				createdAt: agent.created_at,
				verifiedAt: agent.verified_at,
			},
			rating: {
				elo: agent.rating ?? 1500,
				wins: agent.wins ?? 0,
				losses: agent.losses ?? 0,
				gamesPlayed: agent.games_played ?? 0,
				updatedAt: agent.updated_at,
			},
			recentMatches: recent ?? [],
		});
	} catch (error) {
		console.error("Failed to load agent profile", error);
		return internalServerError(c, "Agent profile unavailable");
	}
});
