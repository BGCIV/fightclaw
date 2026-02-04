import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const matchResults = sqliteTable("match_results", {
	matchId: text("match_id").primaryKey(),
	winnerAgentId: text("winner_agent_id"),
	loserAgentId: text("loser_agent_id"),
	reason: text("reason").notNull(),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});
