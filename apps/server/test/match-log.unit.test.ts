import { describe, expect, it, vi } from "vitest";
import {
	loadCanonicalLogPage,
	type RawMatchLogRow,
} from "../src/routes/matchLog";

const row = (
	id: number,
	eventType: string,
	payload: unknown,
): RawMatchLogRow => ({
	id,
	match_id: "match-1",
	turn: 1,
	ts: "2026-03-18T12:00:00.000Z",
	event_type: eventType,
	payload_json: JSON.stringify(payload),
});

describe("loadCanonicalLogPage", () => {
	it("skips filtered rows before returning the next canonical page", async () => {
		const loadRows = vi
			.fn<(_: number, __: number) => Promise<RawMatchLogRow[]>>()
			.mockResolvedValueOnce([
				row(10, "move_forfeit", {
					loserAgentId: "agent-a",
					winnerAgentId: "agent-b",
					reason: "forfeit",
					stateVersion: 2,
				}),
				row(11, "match_ended", {
					winnerAgentId: "agent-b",
					loserAgentId: "agent-a",
					reason: "forfeit",
					stateVersion: 2,
				}),
			])
			.mockResolvedValueOnce([
				row(11, "match_ended", {
					winnerAgentId: "agent-b",
					loserAgentId: "agent-a",
					reason: "forfeit",
					stateVersion: 2,
				}),
			]);

		const page = await loadCanonicalLogPage({
			afterId: 9,
			limit: 1,
			loadRows,
		});

		expect(loadRows).toHaveBeenCalledTimes(2);
		expect(page.events).toHaveLength(1);
		expect(page.events[0]?.event).toBe("match_ended");
		expect(page.nextAfterId).toBe(11);
		expect(page.hasMore).toBe(false);
	});
});
