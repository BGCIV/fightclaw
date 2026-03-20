import type { BroadcastTickerItem } from "@/lib/spectator-desk";

type ActionTickerProps = {
	items: BroadcastTickerItem[];
	visibleItemLimit?: number;
};

const MAX_VISIBLE_ITEMS = 8;

export function ActionTicker({
	items,
	visibleItemLimit = MAX_VISIBLE_ITEMS,
}: ActionTickerProps) {
	const visibleItems = [...items.slice(-visibleItemLimit)].reverse();

	return (
		<section className="action-ticker" aria-label="Recent actions">
			<div className="action-ticker-header">
				<span>Action ticker</span>
				<span>
					{visibleItems.length > 0 ? `${visibleItems.length} recent` : "Idle"}
				</span>
			</div>
			{visibleItems.length === 0 ? (
				<div className="action-ticker-empty">Awaiting live action...</div>
			) : (
				<ul className="action-ticker-list">
					{visibleItems.map((item) => (
						<li
							key={item.eventId}
							className={`action-ticker-item action-ticker-item-${item.tone}`}
						>
							<span className="action-ticker-turn">
								{item.turn === null ? "T?" : `T${item.turn}`}
							</span>
							<span
								className={`action-ticker-player ${item.player ? `player-${item.player.toLowerCase()}-color` : ""}`}
							>
								{item.player ?? "?"}
							</span>
							<span className="action-ticker-text">{item.text}</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
