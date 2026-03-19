import { describe, expect, it } from "vitest";
import {
	applyFeaturedUpdate,
	type FeaturedLiveState,
} from "../../web/src/routes/featured-updates";

describe("applyFeaturedUpdate", () => {
	it("ignores fetch updates after a stream snapshot has been seen", () => {
		const state: FeaturedLiveState = {
			featured: {
				matchId: "live-match",
				status: "active",
				players: ["agent-a", "agent-b"],
			},
			hasSeenStream: true,
		};

		expect(
			applyFeaturedUpdate(state, "fetch", {
				matchId: "stale-match",
				status: "active",
				players: ["agent-c", "agent-d"],
			}),
		).toEqual(state);
	});

	it("accepts fetch updates before the stream has produced a snapshot", () => {
		expect(
			applyFeaturedUpdate(
				{
					featured: null,
					hasSeenStream: false,
				},
				"fetch",
				{
					matchId: "initial-match",
					status: "active",
					players: ["agent-a", "agent-b"],
				},
			),
		).toEqual({
			featured: {
				matchId: "initial-match",
				status: "active",
				players: ["agent-a", "agent-b"],
			},
			hasSeenStream: false,
		});
	});
});
