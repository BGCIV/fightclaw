import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentProfileContent } from "../src/components/agent-profile-content";
import { AgentBroadcastCard } from "../src/components/arena/agent-broadcast-card";
import { LeaderboardTable } from "../src/components/leaderboard-table";
import { buildAgentProfileHref } from "../src/lib/agent-profile";

describe("agent profile helpers and views", () => {
	test("builds a stable agent profile href", () => {
		expect(buildAgentProfileHref("agent-123")).toBe("/agents/agent-123");
	});

	test("renders agent profile content with public identity and recent match links", () => {
		const markup = renderToStaticMarkup(
			<AgentProfileContent
				profile={{
					agent: {
						id: "agent-123",
						name: "Kai",
						createdAt: "2026-03-19T12:00:00.000Z",
						verifiedAt: "2026-03-19T12:05:00.000Z",
					},
					publicIdentity: {
						agentId: "agent-123",
						agentName: "Kai",
						publicPersona:
							"Terrain-first opportunist who wins by pressure and income.",
						styleTag: "OBJECTIVE",
					},
					rating: {
						elo: 1512,
						wins: 9,
						losses: 3,
						gamesPlayed: 12,
						updatedAt: "2026-03-20T00:00:00.000Z",
					},
					recentMatches: [
						{
							id: "match-42",
							status: "ended",
							createdAt: "2026-03-20T12:00:00.000Z",
							endedAt: "2026-03-20T12:05:00.000Z",
							winnerAgentId: "agent-123",
							endReason: "elimination",
							finalStateVersion: 27,
						},
					],
				}}
			/>,
		);

		expect(markup).toContain("Kai");
		expect(markup).toContain("OBJECTIVE");
		expect(markup).toContain(
			"Terrain-first opportunist who wins by pressure and income.",
		);
		expect(markup).toContain("Record");
		expect(markup).toContain("9-3");
		expect(markup).toContain("Replay match-42");
		expect(markup).toContain('href="/?matchId=match-42"');
	});

	test("renders leaderboard entries as profile links", () => {
		const markup = renderToStaticMarkup(
			<LeaderboardTable
				entries={[
					{
						agent_id: "agent-123",
						agentName: "Kai",
						publicPersona:
							"Terrain-first opportunist who wins by pressure and income.",
						styleTag: "OBJECTIVE",
						rating: 1512,
						games_played: 12,
					},
				]}
			/>,
		);

		expect(markup).toContain('href="/agents/agent-123"');
		expect(markup).toContain("Kai");
	});

	test("renders broadcast cards as profile links when agent id exists", () => {
		const markup = renderToStaticMarkup(
			<AgentBroadcastCard
				card={{
					side: "A",
					agentId: "agent-123",
					name: "Kai",
					publicPersona:
						"Terrain-first opportunist who wins by pressure and income.",
					styleTag: "OBJECTIVE",
					gold: 7,
					wood: 5,
					vp: 2,
					unitCount: 4,
					publicCommentary: "Hold center and keep pressure.",
				}}
			/>,
		);

		expect(markup).toContain('href="/agents/agent-123"');
		expect(markup).toContain("Kai");
	});
});
