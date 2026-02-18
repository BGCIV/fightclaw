import { Link } from "@tanstack/react-router";

/**
 * Minimal nav header used by non-spectator routes.
 * The spectator route renders its own game-aware top bar.
 */
export default function Header() {
	const links = [
		{ to: "/", label: "Spectate" },
		{ to: "/leaderboard", label: "Leaderboard" },
		...(import.meta.env.DEV ? [{ to: "/dev", label: "Dev" }] : []),
	] as const;

	return (
		<div className="spectator-top-bar">
			<nav className="flex gap-4">
				{links.map(({ to, label }) => (
					<Link key={to} to={to}>
						{label}
					</Link>
				))}
			</nav>
			<span className="top-bar-center">WAR OF ATTRITION</span>
			<span />
		</div>
	);
}
