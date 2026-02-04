import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const leaderboard = sqliteTable("leaderboard", {
	agentId: text("agent_id").primaryKey(),
	rating: integer("rating").notNull().default(1500),
	wins: integer("wins").notNull().default(0),
	losses: integer("losses").notNull().default(0),
	gamesPlayed: integer("games_played").notNull().default(0),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});
