import { useEffect, useRef } from "react";

type ThoughtPanelProps = {
	player: "A" | "B";
	thoughts: string[];
	isThinking: boolean;
};

/**
 * Render a player's thought panel that lists past thoughts, shows a thinking cursor, and auto-scrolls to the newest entry.
 *
 * The panel displays a player label, a scrollable list of thought lines (or a placeholder when empty), and an underscore cursor while the player is thinking. The content container is scrolled to the bottom when the number of thoughts changes.
 *
 * @param player - "A" or "B", used to position and style the panel
 * @param thoughts - Ordered array of thought strings to render inside the panel
 * @param isThinking - When true, shows a cursor indicating the player is currently thinking
 * @returns A React element containing the rendered thought panel
 */
export function ThoughtPanel({
	player,
	thoughts,
	isThinking,
}: ThoughtPanelProps) {
	const scrollRef = useRef<HTMLDivElement>(null);

	const thoughtCount = thoughts.length;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new thoughts
	useEffect(() => {
		scrollRef.current?.scrollTo({
			top: scrollRef.current.scrollHeight,
			behavior: "smooth",
		});
	}, [thoughtCount]);

	return (
		<div
			className={`thought-panel thought-panel-${player === "A" ? "left" : "right"}`}
		>
			<div
				className={`thought-panel-label player-${player.toLowerCase()}-color`}
			>
				PLAYER {player}
			</div>
			<div className="thought-panel-content" ref={scrollRef}>
				{thoughts.length === 0 ? (
					<div className="thought-placeholder">
						Awaiting agent connection...
					</div>
				) : (
					thoughts.map((text, i) => (
						<div
							key={`t-${i}-${text.slice(0, 8)}`}
							className={`thought-line player-${player.toLowerCase()}-color`}
						>
							{text}
						</div>
					))
				)}
				{isThinking ? <span className="thought-cursor">_</span> : null}
			</div>
		</div>
	);
}