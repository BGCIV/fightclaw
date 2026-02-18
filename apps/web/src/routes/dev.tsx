import {
	applyMove,
	createInitialState,
	listLegalMoves,
	type MatchState,
	type Move,
} from "@fightclaw/engine";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { HexBoard } from "@/components/arena/hex-board";
import { ThoughtPanel } from "@/components/arena/thought-panel";
import {
	type EngineEventsEnvelopeV1,
	useArenaAnimator,
} from "@/lib/arena-animator";

export const Route = createFileRoute("/dev")({
	component: DevConsole,
});

function DevConsole() {
	if (!import.meta.env.DEV) {
		return (
			<div className="leaderboard-page">
				<div className="leaderboard-inner">
					<h1 className="leaderboard-title">Dev tools disabled</h1>
					<p className="leaderboard-subtitle">
						This route is only available in dev mode.
					</p>
				</div>
			</div>
		);
	}

	return <DevLayout />;
}

function DevLayout() {
	const [seed, setSeed] = useState(42);
	const createPreviewState = useCallback(
		(s: number) =>
			createInitialState(s, { boardColumns: 17 }, ["dev-a", "dev-b"]),
		[],
	);
	const [boardState, setBoardState] = useState<MatchState>(() =>
		createPreviewState(seed),
	);
	const [moveCount, setMoveCount] = useState(0);

	const {
		effects,
		unitAnimStates,
		dyingUnitIds,
		hudFx,
		damageNumbers,
		lungeTargets,
		enqueue,
		reset: resetAnimator,
	} = useArenaAnimator({
		onApplyBaseState: (state) => setBoardState(state),
	});

	const resetBoard = useCallback(
		(s: number) => {
			resetAnimator();
			setBoardState(createPreviewState(s));
			setMoveCount(0);
		},
		[createPreviewState, resetAnimator],
	);

	const legalMoves = useMemo(() => listLegalMoves(boardState), [boardState]);

	const playRandomMove = useCallback(() => {
		if (boardState.status !== "active" || legalMoves.length === 0) return;
		const move = legalMoves[
			Math.floor(Math.random() * legalMoves.length)
		] as Move;
		const result = applyMove(boardState, move);
		if (!result.ok) return;

		const envelope: EngineEventsEnvelopeV1 = {
			eventVersion: 1,
			event: "engine_events",
			matchId: "dev-preview",
			stateVersion: moveCount + 1,
			agentId: "dev",
			moveId: `dev-${moveCount + 1}`,
			move,
			engineEvents: result.engineEvents,
			ts: new Date().toISOString(),
		};
		enqueue(envelope, { postState: result.state });
		setMoveCount((n) => n + 1);
	}, [boardState, legalMoves, moveCount, enqueue]);

	const playBurst = useCallback(
		(count: number) => {
			let state = boardState;
			let mc = moveCount;
			for (let i = 0; i < count; i++) {
				if (state.status !== "active") break;
				const moves = listLegalMoves(state);
				if (moves.length === 0) break;
				const move = moves[Math.floor(Math.random() * moves.length)] as Move;
				const result = applyMove(state, move);
				if (!result.ok) break;
				state = result.state;
				mc += 1;

				const envelope: EngineEventsEnvelopeV1 = {
					eventVersion: 1,
					event: "engine_events",
					matchId: "dev-preview",
					stateVersion: mc,
					agentId: "dev",
					moveId: `dev-${mc}`,
					move,
					engineEvents: result.engineEvents,
					ts: new Date().toISOString(),
				};
				enqueue(envelope, { postState: state });
			}
			setMoveCount(mc);
		},
		[boardState, moveCount, enqueue],
	);

	const unitCountA = useMemo(
		() => boardState.players.A.units.length,
		[boardState.players.A.units.length],
	);
	const unitCountB = useMemo(
		() => boardState.players.B.units.length,
		[boardState.players.B.units.length],
	);

	return (
		<div className="spectator-landing">
			{/* Game-info bar (mirrors spectator) */}
			<div className="spectator-top-bar">
				<span className="status-badge">DEV</span>
				<span className="top-bar-center">
					T{boardState.turn}{" "}
					<span
						className={
							boardState.activePlayer === "A"
								? "player-a-color"
								: "player-b-color"
						}
					>
						{boardState.activePlayer}
					</span>{" "}
					| AP {boardState.actionsRemaining}
					{hudFx.passPulse ? " | PASS" : ""}
				</span>
				<span className="muted">seed:{seed}</span>
			</div>

			{/* Three-column layout: thought panel | board | dev panel */}
			<div className="spectator-main">
				<ThoughtPanel player="A" thoughts={[]} isThinking={false} />

				<div className="hex-board-container">
					<HexBoard
						state={boardState}
						effects={effects}
						unitAnimStates={unitAnimStates}
						dyingUnitIds={dyingUnitIds}
						damageNumbers={damageNumbers}
						lungeTargets={lungeTargets}
						activePlayer={boardState.activePlayer}
					/>
				</div>

				<div className="dev-panel">
					<div className="dev-panel-label">Dev Controls</div>

					<div className="dev-panel-section">
						<div className="dev-panel-stat-label">Seed</div>
						<div className="dev-panel-row">
							<input
								type="number"
								className="dev-panel-input"
								value={seed}
								onChange={(e) => setSeed(Number(e.target.value) || 0)}
							/>
						</div>
						<button
							type="button"
							className="dev-panel-btn"
							onClick={() => resetBoard(seed)}
						>
							Reset
						</button>
					</div>

					<div className="dev-panel-section">
						<div className="dev-panel-stat-label">Actions</div>
						<button
							type="button"
							className="dev-panel-btn dev-panel-btn-primary"
							onClick={playRandomMove}
							disabled={boardState.status !== "active"}
						>
							Random Move
						</button>
						<div className="dev-panel-row">
							<button
								type="button"
								className="dev-panel-btn"
								onClick={() => playBurst(5)}
								disabled={boardState.status !== "active"}
							>
								+5
							</button>
							<button
								type="button"
								className="dev-panel-btn"
								onClick={() => playBurst(20)}
								disabled={boardState.status !== "active"}
							>
								+20
							</button>
						</div>
					</div>

					<div className="dev-panel-section">
						<div className="dev-panel-label">State</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Status</span>
							<span className="dev-panel-stat-accent">{boardState.status}</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Turn</span>
							<span className="dev-panel-stat-value">{boardState.turn}</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Active</span>
							<span className="dev-panel-stat-value">
								{boardState.activePlayer}
							</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">AP</span>
							<span className="dev-panel-stat-value">
								{boardState.actionsRemaining}
							</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Moves</span>
							<span className="dev-panel-stat-value">{moveCount}</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Units A</span>
							<span className="player-a-color">{unitCountA}</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Units B</span>
							<span className="player-b-color">{unitCountB}</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
