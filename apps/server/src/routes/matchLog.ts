import type { MatchEventEnvelope } from "@fightclaw/protocol";
import { buildStoredMatchEventEnvelope } from "../protocol/events";

export type RawMatchLogRow = {
	id: number;
	match_id: string;
	turn: number;
	ts: string;
	event_type: string;
	payload_json: string;
};

const toEnvelope = (row: RawMatchLogRow): MatchEventEnvelope | null => {
	let payload: unknown = null;
	try {
		payload = JSON.parse(row.payload_json);
	} catch {
		payload = null;
	}
	return buildStoredMatchEventEnvelope({
		eventId: row.id,
		matchId: row.match_id,
		ts: row.ts,
		eventType: row.event_type,
		payload,
	});
};

export const loadCanonicalLogPage = async (input: {
	afterId: number;
	limit: number;
	loadRows: (afterId: number, rawLimit: number) => Promise<RawMatchLogRow[]>;
	maxFilteredPages?: number;
}) => {
	const rawLimit = input.limit + 1;
	const maxFilteredPages = input.maxFilteredPages ?? 16;
	let cursor = input.afterId;
	let hasMore = false;
	let nextAfterId: number | null = null;

	for (let attempt = 0; attempt < maxFilteredPages; attempt += 1) {
		const rows = await input.loadRows(cursor, rawLimit);
		hasMore = rows.length > input.limit;
		const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
		nextAfterId =
			pageRows.length > 0 ? (pageRows[pageRows.length - 1]?.id ?? null) : null;
		const events = pageRows.flatMap((row) => {
			const envelope = toEnvelope(row);
			return envelope ? [envelope] : [];
		});
		if (events.length > 0 || !hasMore || nextAfterId === null) {
			return { events, hasMore, nextAfterId };
		}
		cursor = nextAfterId;
	}

	return {
		events: [] as MatchEventEnvelope[],
		hasMore,
		nextAfterId,
	};
};
