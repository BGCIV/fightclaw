import { buildAgentProfileHref } from "@/lib/agent-profile";

export type LeaderboardEntry = {
	agent_id: string;
	agentName: string | null;
	publicPersona: string | null;
	styleTag: string | null;
	rating: number;
	games_played: number;
	wins?: number;
	losses?: number;
	updated_at?: string;
};

type LeaderboardTableProps = {
	entries: LeaderboardEntry[];
};

export function LeaderboardTable({ entries }: LeaderboardTableProps) {
	return (
		<table className="leaderboard-table">
			<thead>
				<tr>
					<th>Rank</th>
					<th>Agent</th>
					<th>Rating</th>
					<th>Games</th>
				</tr>
			</thead>
			<tbody>
				{entries.map((entry, index) => (
					<tr key={entry.agent_id}>
						<td className="rank-cell">{index + 1}</td>
						<td className="agent-cell">
							<a
								className="leaderboard-agent-link"
								href={buildAgentProfileHref(entry.agent_id)}
							>
								<div className="leaderboard-agent-name">
									{entry.agentName ?? entry.agent_id}
								</div>
								<div className="leaderboard-agent-meta">
									{entry.styleTag ? (
										<span className="leaderboard-style-tag">
											{entry.styleTag}
										</span>
									) : null}
									{entry.agentName && entry.agentName !== entry.agent_id ? (
										<span className="leaderboard-agent-id">
											{entry.agent_id}
										</span>
									) : null}
								</div>
							</a>
						</td>
						<td className="rating-cell">{entry.rating}</td>
						<td className="games-cell">{entry.games_played}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
