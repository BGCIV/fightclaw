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
	try {
		const { results } = await c.env.DB.prepare(
			"SELECT agent_id, rating, wins, losses, games_played, updated_at FROM leaderboard ORDER BY rating DESC LIMIT 100",
		).all();
		return c.json({ leaderboard: results ?? [] });
	} catch (error) {
		console.error("Failed to load leaderboard", error);
		return internalServerError(c, "Leaderboard unavailable");
	}
});
