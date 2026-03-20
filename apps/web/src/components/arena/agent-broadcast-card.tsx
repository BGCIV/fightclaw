import type { BroadcastAgentCard } from "@/lib/spectator-desk";

type AgentBroadcastCardProps = {
	card: BroadcastAgentCard;
};

export function AgentBroadcastCard({ card }: AgentBroadcastCardProps) {
	return (
		<aside
			className={`agent-broadcast-card agent-broadcast-card-${card.side.toLowerCase()}`}
		>
			<div className="agent-broadcast-card-header">
				<span className="agent-broadcast-seat">Side {card.side}</span>
				<span className="agent-broadcast-style">{card.styleTag}</span>
			</div>
			<div
				className={`agent-broadcast-name player-${card.side.toLowerCase()}-color`}
			>
				{card.name}
			</div>
			{card.publicPersona ? (
				<p className="agent-broadcast-persona">{card.publicPersona}</p>
			) : null}
			<dl className="agent-broadcast-stats">
				<div>
					<dt>VP</dt>
					<dd>{card.vp}</dd>
				</div>
				<div>
					<dt>Units</dt>
					<dd>{card.unitCount}</dd>
				</div>
				<div>
					<dt>Gold</dt>
					<dd>{card.gold}</dd>
				</div>
				<div>
					<dt>Wood</dt>
					<dd>{card.wood}</dd>
				</div>
			</dl>
			<div className="agent-broadcast-commentary-label">Public commentary</div>
			<p className="agent-broadcast-commentary">{card.publicCommentary}</p>
		</aside>
	);
}
