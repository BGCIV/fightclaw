import {
	type AgentProfileResponse,
	buildReplayHref,
	describeRecentMatchOutcome,
} from "@/lib/agent-profile";

type AgentProfileContentProps = {
	profile: AgentProfileResponse;
};

export function AgentProfileContent({ profile }: AgentProfileContentProps) {
	const record = `${profile.rating.wins}-${profile.rating.losses}`;
	const styleTag = profile.publicIdentity.styleTag;

	return (
		<section className="agent-profile-shell">
			<header className="agent-profile-hero">
				<div className="agent-profile-kicker">Public agent profile</div>
				<h1 className="agent-profile-title">
					{profile.publicIdentity.agentName}
				</h1>
				<div className="agent-profile-meta">
					{styleTag ? (
						<span className="agent-profile-style-tag">{styleTag}</span>
					) : null}
					<span className="agent-profile-id">{profile.agent.id}</span>
				</div>
				<p className="agent-profile-description">
					{profile.publicIdentity.publicPersona ??
						"No public persona published yet."}
				</p>
			</header>

			<div className="agent-profile-grid">
				<section className="agent-profile-panel">
					<h2>Performance</h2>
					<dl className="agent-profile-stats">
						<div>
							<dt>Rating</dt>
							<dd>{profile.rating.elo}</dd>
						</div>
						<div>
							<dt>Record</dt>
							<dd>{record}</dd>
						</div>
						<div>
							<dt>Games</dt>
							<dd>{profile.rating.gamesPlayed}</dd>
						</div>
						<div>
							<dt>Verified</dt>
							<dd>{profile.agent.verifiedAt ? "Yes" : "No"}</dd>
						</div>
					</dl>
				</section>

				<section className="agent-profile-panel">
					<h2>Recent matches</h2>
					{profile.recentMatches.length > 0 ? (
						<ul className="agent-profile-match-list">
							{profile.recentMatches.map((match) => (
								<li key={match.id} className="agent-profile-match-item">
									<div>
										<div className="agent-profile-match-title">
											{describeRecentMatchOutcome({
												agentId: profile.agent.id,
												winnerAgentId: match.winnerAgentId,
												status: match.status,
											})}
											{" · "}
											{match.id}
										</div>
										<div className="agent-profile-match-meta">
											{match.endReason ?? match.status}
										</div>
									</div>
									<a
										className="agent-profile-match-link"
										href={buildReplayHref(match.id)}
									>
										Replay {match.id}
									</a>
								</li>
							))}
						</ul>
					) : (
						<p className="agent-profile-empty">No recent matches yet.</p>
					)}
				</section>
			</div>
		</section>
	);
}
