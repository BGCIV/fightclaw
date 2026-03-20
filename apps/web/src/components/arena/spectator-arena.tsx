import type { MatchState } from "@fightclaw/engine";
import type { CSSProperties, ReactNode } from "react";
import type {
	BroadcastAgentCard,
	BroadcastFeaturedDesk,
	BroadcastResultSummary,
	BroadcastTickerItem,
} from "@/lib/spectator-desk";
import { ActionTicker } from "./action-ticker";
import { AgentBroadcastCard } from "./agent-broadcast-card";
import { HexBoard, type HexBoardProps } from "./hex-board";
import { ResultBand } from "./result-band";
import { ThoughtPanel } from "./thought-panel";

type SpectatorArenaProps = {
	statusBadge: string;
	state: MatchState | null;
	topBarRight?: ReactNode;
	topBarCenterFallback?: string;
	hudPassPulse?: boolean;
	emptyStateLabel?: string;
	featuredDesk: BroadcastFeaturedDesk;
	agentCards: {
		A: BroadcastAgentCard;
		B: BroadcastAgentCard;
	};
	tickerItems: BroadcastTickerItem[];
	tickerVisibleLimit?: number;
	resultSummary: BroadcastResultSummary | null;
} & Pick<
	HexBoardProps,
	| "effects"
	| "unitAnimStates"
	| "dyingUnitIds"
	| "damageNumbers"
	| "lungeTargets"
>;

export type SpectatorArenaMainProps = {
	state: MatchState | null;
	thoughtsA: string[];
	thoughtsB: string[];
	isThinkingA: boolean;
	isThinkingB: boolean;
	emptyStateLabel?: string;
	mainStyle?: CSSProperties;
} & Pick<
	HexBoardProps,
	| "effects"
	| "unitAnimStates"
	| "dyingUnitIds"
	| "damageNumbers"
	| "lungeTargets"
>;

export function SpectatorArenaMain({
	state,
	thoughtsA,
	thoughtsB,
	isThinkingA,
	isThinkingB,
	emptyStateLabel = "Awaiting state stream...",
	mainStyle,
	effects,
	unitAnimStates,
	dyingUnitIds,
	damageNumbers,
	lungeTargets,
}: SpectatorArenaMainProps) {
	return (
		<div className="spectator-main" style={mainStyle}>
			<ThoughtPanel player="A" thoughts={thoughtsA} isThinking={isThinkingA} />

			{state ? (
				<HexBoard
					state={state}
					effects={effects}
					unitAnimStates={unitAnimStates}
					dyingUnitIds={dyingUnitIds}
					damageNumbers={damageNumbers}
					lungeTargets={lungeTargets}
					activePlayer={state.activePlayer}
				/>
			) : (
				<div className="spectator-board-empty">
					<div className="muted">{emptyStateLabel}</div>
				</div>
			)}

			<ThoughtPanel player="B" thoughts={thoughtsB} isThinking={isThinkingB} />
		</div>
	);
}

export function SpectatorArena({
	statusBadge,
	state,
	topBarRight,
	topBarCenterFallback = "WAR OF ATTRITION",
	emptyStateLabel = "Awaiting state stream...",
	hudPassPulse = false,
	featuredDesk,
	agentCards,
	tickerItems,
	tickerVisibleLimit,
	resultSummary,
	effects,
	unitAnimStates,
	dyingUnitIds,
	damageNumbers,
	lungeTargets,
}: SpectatorArenaProps) {
	return (
		<div className="spectator-landing">
			<div className="spectator-top-bar">
				<span className="status-badge">{statusBadge}</span>
				<div className="top-bar-center">
					<div className="top-bar-primary">
						{state ? (
							<>
								T{state.turn}{" "}
								<span
									className={
										state.activePlayer === "A"
											? "player-a-color"
											: "player-b-color"
									}
								>
									{state.activePlayer}
								</span>{" "}
								| AP {state.actionsRemaining}
								{hudPassPulse ? " | PASS" : ""}
							</>
						) : (
							topBarCenterFallback
						)}
					</div>
					<div className="top-bar-secondary">
						<span>{featuredDesk.label}</span>
						<span>{featuredDesk.playersLabel}</span>
					</div>
				</div>
				<div className="top-bar-right">{topBarRight}</div>
			</div>
			<div className="spectator-broadcast-shell">
				{resultSummary ? (
					<ResultBand summary={resultSummary} agentCards={agentCards} />
				) : null}
				<div className="spectator-broadcast-grid">
					<AgentBroadcastCard card={agentCards.A} />
					<div className="spectator-stage">
						<div className="spectator-stage-body">
							<div className="spectator-stage-board">
								{state ? (
									<HexBoard
										state={state}
										effects={effects}
										unitAnimStates={unitAnimStates}
										dyingUnitIds={dyingUnitIds}
										damageNumbers={damageNumbers}
										lungeTargets={lungeTargets}
										activePlayer={state.activePlayer}
									/>
								) : (
									<div className="spectator-board-empty">
										<div className="muted">{emptyStateLabel}</div>
									</div>
								)}
							</div>
						</div>
						<div className="spectator-stage-ticker">
							<ActionTicker
								items={tickerItems}
								visibleItemLimit={tickerVisibleLimit}
							/>
						</div>
					</div>
					<AgentBroadcastCard card={agentCards.B} />
				</div>
			</div>
		</div>
	);
}
