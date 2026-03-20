export type AgentProfilePublicIdentity = {
	agentId: string;
	agentName: string;
	publicPersona: string | null;
	styleTag: string | null;
};

export type AgentProfileResponse = {
	agent: {
		id: string;
		name: string;
		createdAt: string;
		verifiedAt: string | null;
	};
	publicIdentity: AgentProfilePublicIdentity;
	rating: {
		elo: number;
		wins: number;
		losses: number;
		gamesPlayed: number;
		updatedAt: string | null;
	};
	recentMatches: Array<{
		id: string;
		status: string;
		createdAt: string | null;
		endedAt: string | null;
		winnerAgentId: string | null;
		endReason: string | null;
		finalStateVersion: number | null;
	}>;
};

export function buildAgentProfileHref(agentId: string): string {
	return `/agents/${encodeURIComponent(agentId)}`;
}

export function buildReplayHref(matchId: string): string {
	return `/?matchId=${encodeURIComponent(matchId)}`;
}

export function describeRecentMatchOutcome(input: {
	agentId: string;
	winnerAgentId: string | null;
	status: string;
}): string {
	if (input.status !== "ended") return "In progress";
	if (!input.winnerAgentId) return "Draw";
	return input.winnerAgentId === input.agentId ? "Win" : "Loss";
}
