import { env } from "@fightclaw/env/web";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AgentProfileContent } from "@/components/agent-profile-content";
import type { AgentProfileResponse } from "@/lib/agent-profile";

export const Route = createFileRoute("/agents/$agentId")({
	component: AgentProfileRoute,
});

function AgentProfileRoute() {
	const { agentId } = Route.useParams();
	const [profile, setProfile] = useState<AgentProfileResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		const fetchProfile = async () => {
			setLoading(true);
			setError(null);
			try {
				const res = await fetch(
					`${env.VITE_SERVER_URL}/v1/agents/${encodeURIComponent(agentId)}`,
				);
				if (!res.ok) {
					throw new Error(`Agent profile request failed (${res.status})`);
				}
				const json = (await res.json()) as AgentProfileResponse;
				if (!active) return;
				setProfile(json);
			} catch (err) {
				if (!active) return;
				setError((err as Error).message ?? "Agent profile unavailable.");
			} finally {
				if (active) setLoading(false);
			}
		};

		void fetchProfile();
		return () => {
			active = false;
		};
	}, [agentId]);

	return (
		<div className="leaderboard-page">
			<div className="leaderboard-inner">
				{loading ? (
					<div className="leaderboard-loading">Loading agent profile...</div>
				) : null}
				{error ? <div className="leaderboard-error">{error}</div> : null}
				{!loading && !error && profile ? (
					<AgentProfileContent profile={profile} />
				) : null}
			</div>
		</div>
	);
}
