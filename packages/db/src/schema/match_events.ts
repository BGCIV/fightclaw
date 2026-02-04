import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const matchEvents = sqliteTable("match_events", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	matchId: text("match_id").notNull(),
	turn: integer("turn").notNull(),
	ts: text("ts").notNull().default(sql`(datetime('now'))`),
	eventType: text("event_type").notNull(),
	payloadJson: text("payload_json").notNull(),
});
