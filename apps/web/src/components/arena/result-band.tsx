import type {
	BroadcastAgentCard,
	BroadcastResultSummary,
} from "@/lib/spectator-desk";

type ResultBandProps = {
	summary: BroadcastResultSummary;
	agentCards: {
		A: BroadcastAgentCard;
		B: BroadcastAgentCard;
	};
};

export function ResultBand({ summary, agentCards }: ResultBandProps) {
	const winnerName =
		summary.winningSide === "A"
			? agentCards.A.name
			: summary.winningSide === "B"
				? agentCards.B.name
				: "Draw";
	const loserName =
		summary.winningSide === "A"
			? agentCards.B.name
			: summary.winningSide === "B"
				? agentCards.A.name
				: null;
	const headline =
		summary.winningSide === "draw"
			? "Draw"
			: summary.winningSide
				? `${winnerName} wins`
				: summary.headline;

	return (
		<section
			className={`result-band result-band-${summary.winningSide ?? "neutral"}`}
			aria-label="Match result"
		>
			<div className="result-band-kicker">Final result</div>
			<div className="result-band-headline">{headline}</div>
			<div className="result-band-subtitle">
				{loserName
					? `${summary.reasonLabel} · ${loserName} falls`
					: summary.subtitle}
			</div>
		</section>
	);
}
