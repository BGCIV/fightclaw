import type { FeaturedSnapshot } from "@fightclaw/protocol";

export type FeaturedView =
	| FeaturedSnapshot
	| {
			matchId: string | null;
			status: "replay";
			players: string[] | null;
	  };

export type FeaturedLiveState = {
	featured: FeaturedView | null;
	hasSeenStream: boolean;
};

export type FeaturedUpdateSource = "fetch" | "stream";

export const applyFeaturedUpdate = (
	state: FeaturedLiveState,
	source: FeaturedUpdateSource,
	next: FeaturedSnapshot,
): FeaturedLiveState => {
	if (source === "stream") {
		return {
			featured: next,
			hasSeenStream: true,
		};
	}

	if (state.hasSeenStream) {
		return state;
	}

	return {
		...state,
		featured: next,
	};
};
