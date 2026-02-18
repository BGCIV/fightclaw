import {
	applyMove,
	createInitialState,
	listLegalMoves,
	type MatchState,
	type Move,
} from "@fightclaw/engine";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HexBoard } from "@/components/arena/hex-board";
import { ThoughtPanel } from "@/components/arena/thought-panel";
import {
	type EngineEventsEnvelopeV1,
	useArenaAnimator,
} from "@/lib/arena-animator";

export const Route = createFileRoute("/dev")({
	component: DevConsole,
});

// ── Replay bundle types (matches export-web-replay.ts) ──────────────────

type ReplayStep = {
	ply: number;
	playerID: string;
	move: Move;
	preHash: string;
	postHash: string;
};

type ReplayMatch = {
	id: string;
	label: string;
	scenario: string | null;
	seed: number;
	participants: [string, string];
	result: { winner: string | null; reason: string };
	initialState: MatchState;
	steps: ReplayStep[];
};

type ReplayBundle = {
	version: 1;
	generatedAt: string;
	runDir: string;
	summaryPath: string | null;
	matchCount: number;
	matches: ReplayMatch[];
};

// ── Mode type ───────────────────────────────────────────────────────────

type DevMode = "sandbox" | "replay";

// ── Component ───────────────────────────────────────────────────────────

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
	const [mode, setMode] = useState<DevMode>("sandbox");

	// ── Shared board state ──────────────────────────────────────────────
	const [boardState, setBoardState] = useState<MatchState>(() =>
		createInitialState(42, { boardColumns: 17 }, ["dev-a", "dev-b"]),
	);

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

	// ── Sandbox state ───────────────────────────────────────────────────
	const [seed, setSeed] = useState(42);
	const [moveCount, setMoveCount] = useState(0);

	const createPreviewState = useCallback(
		(s: number) =>
			createInitialState(s, { boardColumns: 17 }, ["dev-a", "dev-b"]),
		[],
	);

	const resetSandbox = useCallback(
		(s: number) => {
			resetAnimator();
			setBoardState(createPreviewState(s));
			setMoveCount(0);
		},
		[createPreviewState, resetAnimator],
	);

	const legalMoves = useMemo(
		() => (mode === "sandbox" ? listLegalMoves(boardState) : []),
		[boardState, mode],
	);

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

	// ── Replay state ────────────────────────────────────────────────────
	const [replayUrl, setReplayUrl] = useState("/dev-replay/latest.json");
	const [bundle, setBundle] = useState<ReplayBundle | null>(null);
	const [selectedMatchIdx, setSelectedMatchIdx] = useState(0);
	const [replayPly, setReplayPly] = useState(0);
	const [replayPlaying, setReplayPlaying] = useState(false);
	const [stepMs, setStepMs] = useState(400);
	const [actionLog, setActionLog] = useState<string[]>([]);
	const [replayError, setReplayError] = useState<string | null>(null);
	const playIntervalRef = useRef<number | null>(null);

	const selectedMatch = bundle?.matches[selectedMatchIdx] ?? null;

	const loadBundle = useCallback(
		async (url: string) => {
			setReplayError(null);
			try {
				const res = await fetch(url);
				if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
				const data = (await res.json()) as ReplayBundle;
				if (!data.matches || data.matches.length === 0) {
					throw new Error("No matches in bundle");
				}
				setBundle(data);
				setSelectedMatchIdx(0);
				setReplayPly(0);
				setReplayPlaying(false);
				setActionLog([]);
				resetAnimator();
				const first = data.matches[0];
				if (first) setBoardState(first.initialState);
			} catch (err) {
				setReplayError((err as Error).message);
			}
		},
		[resetAnimator],
	);

	const selectMatch = useCallback(
		(idx: number) => {
			if (!bundle) return;
			const match = bundle.matches[idx];
			if (!match) return;
			setSelectedMatchIdx(idx);
			setReplayPly(0);
			setReplayPlaying(false);
			setActionLog([]);
			resetAnimator();
			setBoardState(match.initialState);
		},
		[bundle, resetAnimator],
	);

	const resetMatch = useCallback(() => {
		if (!selectedMatch) return;
		setReplayPly(0);
		setReplayPlaying(false);
		setActionLog([]);
		resetAnimator();
		setBoardState(selectedMatch.initialState);
	}, [selectedMatch, resetAnimator]);

	const stepReplay = useCallback(() => {
		if (!selectedMatch) return;
		if (replayPly >= selectedMatch.steps.length) return;

		const step = selectedMatch.steps[replayPly];
		if (!step) return;
		const result = applyMove(boardState, step.move);
		if (!result.ok) {
			setActionLog((prev) =>
				[`[${replayPly}] ERR: ${result.error}`, ...prev].slice(0, 200),
			);
			return;
		}

		const envelope: EngineEventsEnvelopeV1 = {
			eventVersion: 1,
			event: "engine_events",
			matchId: selectedMatch.id,
			stateVersion: replayPly + 1,
			agentId: step.playerID,
			moveId: `replay-${replayPly}`,
			move: step.move,
			engineEvents: result.engineEvents,
			ts: new Date().toISOString(),
		};
		enqueue(envelope, { postState: result.state });

		const moveText = `${step.move.action}${step.move.action === "move" || step.move.action === "attack" ? ` ${step.move.unitId}` : ""}`;
		setActionLog((prev) =>
			[`[${replayPly}] ${step.playerID}: ${moveText}`, ...prev].slice(0, 200),
		);
		setReplayPly((p) => p + 1);
	}, [selectedMatch, replayPly, boardState, enqueue]);

	// Auto-play interval
	useEffect(() => {
		if (
			replayPlaying &&
			selectedMatch &&
			replayPly < selectedMatch.steps.length
		) {
			playIntervalRef.current = window.setInterval(() => {
				stepReplay();
			}, stepMs);
			return () => {
				if (playIntervalRef.current !== null) {
					clearInterval(playIntervalRef.current);
					playIntervalRef.current = null;
				}
			};
		}
		if (playIntervalRef.current !== null) {
			clearInterval(playIntervalRef.current);
			playIntervalRef.current = null;
		}
		if (selectedMatch && replayPly >= selectedMatch.steps.length) {
			setReplayPlaying(false);
		}
	}, [replayPlaying, stepMs, selectedMatch, replayPly, stepReplay]);

	// Switch mode resets
	const switchMode = useCallback(
		(m: DevMode) => {
			setMode(m);
			setReplayPlaying(false);
			resetAnimator();
			if (m === "sandbox") {
				setBoardState(createPreviewState(seed));
				setMoveCount(0);
			} else if (m === "replay" && selectedMatch) {
				setBoardState(selectedMatch.initialState);
				setReplayPly(0);
				setActionLog([]);
			}
		},
		[createPreviewState, resetAnimator, seed, selectedMatch],
	);

	// ── Derived ─────────────────────────────────────────────────────────
	const unitCountA = useMemo(
		() => boardState.players.A.units.length,
		[boardState.players.A.units.length],
	);
	const unitCountB = useMemo(
		() => boardState.players.B.units.length,
		[boardState.players.B.units.length],
	);

	const topBarRight =
		mode === "sandbox" ? (
			<span className="muted">seed:{seed}</span>
		) : selectedMatch ? (
			<span className="muted">
				{replayPly}/{selectedMatch.steps.length}
			</span>
		) : (
			<span className="muted">no replay</span>
		);

	return (
		<div className="spectator-landing">
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
				{topBarRight}
			</div>

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
					{/* Mode toggle */}
					<div className="dev-panel-row">
						<button
							type="button"
							className={`dev-panel-btn ${mode === "sandbox" ? "dev-panel-btn-primary" : ""}`}
							onClick={() => switchMode("sandbox")}
						>
							Sandbox
						</button>
						<button
							type="button"
							className={`dev-panel-btn ${mode === "replay" ? "dev-panel-btn-primary" : ""}`}
							onClick={() => switchMode("replay")}
						>
							API Replay
						</button>
					</div>

					{mode === "sandbox" ? (
						<>
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
									onClick={() => resetSandbox(seed)}
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
						</>
					) : (
						<>
							<div className="dev-panel-section">
								<div className="dev-panel-stat-label">Replay URL</div>
								<input
									type="text"
									className="dev-panel-input"
									value={replayUrl}
									onChange={(e) => setReplayUrl(e.target.value)}
								/>
								<div className="dev-panel-row">
									<button
										type="button"
										className="dev-panel-btn dev-panel-btn-primary"
										onClick={() => void loadBundle(replayUrl)}
									>
										Load Replay
									</button>
									<button
										type="button"
										className="dev-panel-btn"
										onClick={() => void loadBundle("/dev-replay/latest.json")}
									>
										Load Latest
									</button>
								</div>
								{replayError ? (
									<div style={{ color: "#ff6b6b", fontSize: "0.65rem" }}>
										{replayError}
									</div>
								) : null}
							</div>

							{bundle ? (
								<>
									<div className="dev-panel-section">
										<div className="dev-panel-stat-label">
											Match ({bundle.matchCount})
										</div>
										<select
											className="dev-panel-input"
											value={selectedMatchIdx}
											onChange={(e) => selectMatch(Number(e.target.value))}
										>
											{bundle.matches.map((m, i) => (
												<option key={m.id} value={i}>
													{m.label}
												</option>
											))}
										</select>
									</div>

									{selectedMatch ? (
										<>
											<div className="dev-panel-section">
												<div className="dev-panel-stat-label">Playback</div>
												<div className="dev-panel-row">
													<button
														type="button"
														className="dev-panel-btn"
														onClick={resetMatch}
													>
														Reset Match
													</button>
													<button
														type="button"
														className="dev-panel-btn"
														onClick={stepReplay}
														disabled={replayPly >= selectedMatch.steps.length}
													>
														Step
													</button>
												</div>
												<div className="dev-panel-row">
													<button
														type="button"
														className={`dev-panel-btn ${replayPlaying ? "dev-panel-btn-primary" : ""}`}
														onClick={() => setReplayPlaying((p) => !p)}
														disabled={replayPly >= selectedMatch.steps.length}
													>
														{replayPlaying ? "Pause" : "Play"}
													</button>
												</div>
												<div className="dev-panel-row">
													<span className="dev-panel-stat-label">Step ms</span>
													<input
														type="number"
														className="dev-panel-input"
														style={{ width: 64 }}
														value={stepMs}
														onChange={(e) =>
															setStepMs(
																Math.max(50, Number(e.target.value) || 400),
															)
														}
													/>
												</div>
												<div className="dev-panel-stat">
													<span className="dev-panel-stat-label">Result</span>
													<span className="dev-panel-stat-accent">
														{selectedMatch.result.winner ?? "draw"} (
														{selectedMatch.result.reason})
													</span>
												</div>
											</div>

											<div
												className="dev-panel-section"
												style={{ flex: 1, minHeight: 0 }}
											>
												<div className="dev-panel-stat-label">
													Action Log ({actionLog.length})
												</div>
												<div
													style={{
														flex: 1,
														overflowY: "auto",
														fontSize: "0.6rem",
														lineHeight: 1.4,
														color: "var(--spectator-muted)",
														maxHeight: 200,
													}}
												>
													{actionLog.map((line, i) => (
														<div key={`log-${actionLog.length - i}`}>
															{line}
														</div>
													))}
												</div>
											</div>
										</>
									) : null}
								</>
							) : null}
						</>
					)}

					{/* State readout (always visible) */}
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
