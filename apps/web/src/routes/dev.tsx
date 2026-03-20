import {
	applyMove,
	bindEngineConfig,
	createInitialState,
	type EngineConfigInput,
	listLegalMoves,
	type MatchState,
	type Move,
} from "@fightclaw/engine";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SpectatorArena } from "@/components/arena/spectator-arena";
import {
	type EngineEventsEnvelope,
	useArenaAnimator,
} from "@/lib/arena-animator";
import { evaluateDevLayoutHealth } from "@/lib/dev-layout-health";
import {
	buildDevSpectatorLabModel,
	DEV_LAB_LAYOUT_PRESETS,
	DEV_LAB_SCENARIOS,
	type DevLabLayoutPresetId,
	type DevLabScenarioId,
} from "@/lib/dev-spectator-lab";
import { buildPublicAgentIdentityMap } from "@/lib/public-agent-identity";
import {
	type BroadcastTickerItem,
	buildSpectatorDeskProjection,
} from "@/lib/spectator-desk";

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
	engineConfig?: EngineConfigInput | null;
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

type DevMode = "lab" | "sandbox" | "replay";

type DevMeasuredLayout = {
	frameHeightPx: number;
	boardHeightPx: number;
	tickerHeightPx: number;
	resultBandHeightPx: number;
	viewportWidthPx: number;
	viewportHeightPx: number;
};

type DevActionLogEntry = {
	label: string;
	player: "A" | "B" | null;
	turn: number | null;
	tone: "neutral" | "danger" | "warning";
};

function deriveReplaySide(playerId: string): "A" | "B" | null {
	if (playerId === "0" || playerId === "A") return "A";
	if (playerId === "1" || playerId === "B") return "B";
	return null;
}

function buildActionLogEntry(
	label: string,
	player: "A" | "B" | null,
	turn: number | null,
	tone: DevActionLogEntry["tone"],
): DevActionLogEntry {
	return {
		label,
		player,
		turn,
		tone,
	};
}

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

export function DevLayout(props?: { initialMode?: DevMode }) {
	const [mode, setMode] = useState<DevMode>(props?.initialMode ?? "lab");
	const [labLayoutPreset, setLabLayoutPreset] =
		useState<DevLabLayoutPresetId>("desktop");
	const [labScenarioId, setLabScenarioId] =
		useState<DevLabScenarioId>("live-board");
	const [labTickerCountOverride, setLabTickerCountOverride] = useState<
		number | null
	>(null);
	const [labSeed, setLabSeed] = useState(42);
	const [labLongNames, setLabLongNames] = useState(false);
	const [labLongPersona, setLabLongPersona] = useState(false);
	const [labLongCommentary, setLabLongCommentary] = useState(false);
	const [labResultBandVisibleOverride, setLabResultBandVisibleOverride] =
		useState<boolean | null>(null);
	const [measuredLayout, setMeasuredLayout] = useState<DevMeasuredLayout>({
		frameHeightPx: 0,
		boardHeightPx: 0,
		tickerHeightPx: 0,
		resultBandHeightPx: 0,
		viewportWidthPx: 0,
		viewportHeightPx: 0,
	});
	const stageFrameRef = useRef<HTMLDivElement | null>(null);

	// ── Shared board state ──────────────────────────────────────────────
	const [boardState, setBoardState] = useState<MatchState>(() =>
		createInitialState(42, { boardColumns: 17 }, ["dev-a", "dev-b"]),
	);

	const { enqueue, reset: resetAnimator } = useArenaAnimator({
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
			setActionLog([]);
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

		const envelope: EngineEventsEnvelope = {
			eventVersion: 2,
			eventId: moveCount + 1,
			ts: new Date().toISOString(),
			matchId: "dev-preview",
			stateVersion: moveCount + 1,
			event: "engine_events",
			payload: {
				agentId: "dev",
				moveId: `dev-${moveCount + 1}`,
				move,
				engineEvents: result.engineEvents,
			},
		};
		enqueue(envelope, { postState: result.state });
		setActionLog((prev) =>
			[
				buildActionLogEntry(
					`[${moveCount + 1}] sandbox: ${move.action}${"unitId" in move ? ` ${move.unitId}` : ""}`,
					boardState.activePlayer,
					boardState.turn,
					"neutral",
				),
				...prev,
			].slice(0, 200),
		);
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

				const envelope: EngineEventsEnvelope = {
					eventVersion: 2,
					eventId: mc,
					ts: new Date().toISOString(),
					matchId: "dev-preview",
					stateVersion: mc,
					event: "engine_events",
					payload: {
						agentId: "dev",
						moveId: `dev-${mc}`,
						move,
						engineEvents: result.engineEvents,
					},
				};
				enqueue(envelope, { postState: state });
				setActionLog((prev) =>
					[
						buildActionLogEntry(
							`[${mc}] sandbox: ${move.action}${"unitId" in move ? ` ${move.unitId}` : ""}`,
							state.activePlayer === "A" ? "B" : "A",
							state.turn,
							"neutral",
						),
						...prev,
					].slice(0, 200),
				);
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
	const [actionLog, setActionLog] = useState<DevActionLogEntry[]>([]);
	const [logExpanded, setLogExpanded] = useState(false);
	const [replayError, setReplayError] = useState<string | null>(null);
	const playIntervalRef = useRef<number | null>(null);
	const replayStateRef = useRef<MatchState | null>(null);

	const selectedMatch = bundle?.matches[selectedMatchIdx] ?? null;
	const selectedLabScenario = useMemo(
		() =>
			DEV_LAB_SCENARIOS.find((scenario) => scenario.id === labScenarioId) ??
			DEV_LAB_SCENARIOS[0],
		[labScenarioId],
	);
	const labTickerCount =
		labTickerCountOverride ?? selectedLabScenario.defaultTickerCount;
	const labResultBandVisible =
		labResultBandVisibleOverride ?? selectedLabScenario.resultBandVisible;
	const labModel = useMemo(
		() =>
			buildDevSpectatorLabModel({
				layoutPreset: labLayoutPreset,
				scenarioId: labScenarioId,
				tickerCount:
					labTickerCountOverride === null ? undefined : labTickerCountOverride,
				seed: labSeed,
				longNames: labLongNames,
				longPersona: labLongPersona,
				longCommentary: labLongCommentary,
				resultBandVisible:
					labResultBandVisibleOverride === null
						? undefined
						: labResultBandVisibleOverride,
			}),
		[
			labLayoutPreset,
			labScenarioId,
			labTickerCountOverride,
			labSeed,
			labLongNames,
			labLongPersona,
			labLongCommentary,
			labResultBandVisibleOverride,
		],
	);
	const advancedTickerItems = useMemo<BroadcastTickerItem[]>(
		() =>
			[...actionLog].reverse().map((entry, index) => ({
				eventId: 10_000 + index + 1,
				ts: new Date(Date.UTC(2026, 2, 20, 12, index, 0)).toISOString(),
				turn:
					entry.turn ?? Math.max(1, boardState.turn - Math.floor(index / 2)),
				player: entry.player,
				text: entry.label,
				tone: entry.tone,
			})),
		[actionLog, boardState.turn],
	);
	const advancedProjection = useMemo(
		() =>
			buildSpectatorDeskProjection({
				connectionStatus: mode === "replay" ? "replay" : "live",
				featured:
					mode === "replay"
						? {
								matchId: selectedMatch?.id ?? null,
								status: "replay",
								players: selectedMatch ? [...selectedMatch.participants] : null,
							}
						: {
								matchId: "dev-preview",
								status: "active",
								players: ["dev-a", "dev-b"],
							},
				state: boardState,
				thoughtsA:
					actionLog.length > 0
						? [actionLog[0]?.label ?? "Advanced tool state active."]
						: ["Advanced tool state active."],
				thoughtsB:
					mode === "replay"
						? ["Replay tool is driving the visible stage."]
						: ["Sandbox tools are driving the visible stage."],
				tickerItems: advancedTickerItems,
				terminalEvent: null,
				publicIdentityById: buildPublicAgentIdentityMap([
					{
						agentId: "dev-a",
						agentName: "Alpha",
						publicPersona: "Sandbox-side agent under local test.",
						styleTag: "GENERAL",
					},
					{
						agentId: "dev-b",
						agentName: "Bravo",
						publicPersona: "Replay-side agent under local test.",
						styleTag: "GENERAL",
					},
				]),
			}),
		[advancedTickerItems, actionLog, boardState, mode, selectedMatch],
	);
	const advancedStage = useMemo(
		() => ({
			state: boardState,
			featuredDesk: advancedProjection.featuredDesk,
			agentCards: advancedProjection.agentCards,
			tickerItems: advancedProjection.tickerItems,
			resultSummary: advancedProjection.resultSummary,
		}),
		[advancedProjection, boardState],
	);

	const bindReplayState = useCallback((match: ReplayMatch): MatchState => {
		return bindEngineConfig(
			match.initialState,
			match.engineConfig ?? undefined,
		);
	}, []);

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
				if (first) {
					const initial = bindReplayState(first);
					replayStateRef.current = initial;
					setBoardState(initial);
				}
			} catch (err) {
				setReplayError((err as Error).message);
			}
		},
		[resetAnimator, bindReplayState],
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
			const initial = bindReplayState(match);
			replayStateRef.current = initial;
			setBoardState(initial);
		},
		[bundle, bindReplayState, resetAnimator],
	);

	const resetMatch = useCallback(() => {
		if (!selectedMatch) return;
		setReplayPly(0);
		setReplayPlaying(false);
		setActionLog([]);
		resetAnimator();
		const initial = bindReplayState(selectedMatch);
		replayStateRef.current = initial;
		setBoardState(initial);
	}, [selectedMatch, bindReplayState, resetAnimator]);

	const stepReplay = useCallback(() => {
		if (!selectedMatch) return;
		if (replayPly >= selectedMatch.steps.length) return;

		const step = selectedMatch.steps[replayPly];
		if (!step) return;
		const replayState =
			replayStateRef.current ?? bindReplayState(selectedMatch);
		const result = applyMove(replayState, step.move);
		if (!result.ok) {
			setActionLog((prev) =>
				[
					buildActionLogEntry(
						`[${replayPly}] ERR: ${result.error}`,
						deriveReplaySide(step.playerID),
						replayState.turn,
						"danger",
					),
					...prev,
				].slice(0, 200),
			);
			return;
		}
		replayStateRef.current = result.state;

		const envelope: EngineEventsEnvelope = {
			eventVersion: 2,
			eventId: replayPly + 1,
			ts: new Date().toISOString(),
			matchId: selectedMatch.id,
			stateVersion: replayPly + 1,
			event: "engine_events",
			payload: {
				agentId: step.playerID,
				moveId: `replay-${replayPly}`,
				move: step.move,
				engineEvents: result.engineEvents,
			},
		};
		enqueue(envelope, { postState: result.state });

		const moveText = `${step.move.action}${step.move.action === "move" || step.move.action === "attack" ? ` ${step.move.unitId}` : ""}`;
		setActionLog((prev) =>
			[
				buildActionLogEntry(
					`[${replayPly}] ${step.playerID}: ${moveText}`,
					deriveReplaySide(step.playerID),
					replayState.turn,
					"neutral",
				),
				...prev,
			].slice(0, 200),
		);
		setReplayPly((p) => p + 1);
	}, [selectedMatch, replayPly, bindReplayState, enqueue]);

	useEffect(() => {
		if (mode !== "replay" || !selectedMatch) {
			replayStateRef.current = null;
			return;
		}
		replayStateRef.current = bindReplayState(selectedMatch);
	}, [mode, selectedMatch, bindReplayState]);

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

	useEffect(() => {
		const root = stageFrameRef.current;
		if (!root || typeof ResizeObserver === "undefined") return;

		const measure = () => {
			const board = root.querySelector(".spectator-stage-board");
			const ticker = root.querySelector(".action-ticker");
			const resultBand = root.querySelector(".result-band");

			setMeasuredLayout({
				frameHeightPx: Math.round(root.getBoundingClientRect().height),
				boardHeightPx: Math.round(board?.getBoundingClientRect().height ?? 0),
				tickerHeightPx: Math.round(ticker?.getBoundingClientRect().height ?? 0),
				resultBandHeightPx: Math.round(
					resultBand?.getBoundingClientRect().height ?? 0,
				),
				viewportWidthPx: window.innerWidth,
				viewportHeightPx: window.innerHeight,
			});
		};

		measure();
		const observer = new ResizeObserver(() => {
			measure();
		});
		observer.observe(root);
		for (const selector of [
			".spectator-stage-board",
			".action-ticker",
			".result-band",
		]) {
			const element = root.querySelector(selector);
			if (element) observer.observe(element);
		}
		window.addEventListener("resize", measure);

		return () => {
			window.removeEventListener("resize", measure);
			observer.disconnect();
		};
	}, [
		mode,
		actionLog.length,
		advancedStage.resultSummary,
		advancedTickerItems.length,
		boardState.status,
		boardState.turn,
		labLayoutPreset,
		labScenarioId,
		labModel.resultSummary,
		labModel.tickerItems.length,
		labTickerCount,
		replayPly,
		selectedMatch?.id,
	]);

	// Switch mode resets
	const switchMode = useCallback(
		(m: DevMode) => {
			setMode(m);
			setReplayPlaying(false);
			resetAnimator();
			if (m === "lab") {
				replayStateRef.current = null;
				setActionLog([]);
			} else if (m === "sandbox") {
				replayStateRef.current = null;
				setActionLog([]);
				setBoardState(createPreviewState(seed));
				setMoveCount(0);
			} else if (m === "replay") {
				setReplayPly(0);
				setActionLog([]);
				if (selectedMatch) {
					const initial = bindReplayState(selectedMatch);
					replayStateRef.current = initial;
					setBoardState(initial);
				} else {
					replayStateRef.current = null;
					setBoardState(createPreviewState(seed));
				}
			}
		},
		[createPreviewState, bindReplayState, resetAnimator, seed, selectedMatch],
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

	const _topBarRight =
		mode === "lab" ? (
			<span className="muted">
				{labModel.layout.preset.label} · {labModel.scenario.label}
			</span>
		) : mode === "sandbox" ? (
			<span className="muted">seed:{seed}</span>
		) : selectedMatch ? (
			<span className="muted">
				{replayPly}/{selectedMatch.steps.length}
			</span>
		) : (
			<span className="muted">no replay</span>
		);

	const stageModel = mode === "lab" ? labModel : advancedStage;
	const stageTickerVisibleLimit =
		mode === "lab"
			? Math.max(8, stageModel.tickerItems.length)
			: Math.max(8, advancedTickerItems.length);
	const layoutHealth = useMemo(
		() =>
			evaluateDevLayoutHealth({
				...measuredLayout,
			}),
		[measuredLayout],
	);
	const activeDiagnostics =
		layoutHealth.frameHeightPx > 0
			? {
					boardShrinkRisk: layoutHealth.severity === "risk",
					overflowRisk:
						layoutHealth.severity !== "clear" ||
						layoutHealth.tickerShare > 0.24,
					resultBandVisible: stageModel.resultSummary !== null,
					tickerCount: stageModel.tickerItems.length,
				}
			: mode === "lab"
				? labModel.diagnostics
				: {
						boardShrinkRisk:
							advancedTickerItems.length > 8 || boardState.status === "ended",
						overflowRisk: advancedTickerItems.length > 8,
						resultBandVisible: stageModel.resultSummary !== null,
						tickerCount: advancedTickerItems.length,
					};
	const stageLabel =
		mode === "lab"
			? "Spectator lab"
			: mode === "sandbox"
				? "Sandbox tools"
				: "Replay tools";

	return (
		<div
			style={{
				padding: "12px",
				display: "grid",
				gap: "12px",
				minHeight: "100%",
				background: "var(--spectator-bg)",
			}}
		>
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "320px minmax(0, 1fr)",
					gap: "12px",
					alignItems: "start",
					minHeight: "100%",
				}}
			>
				<aside
					className="dev-panel"
					style={{ maxHeight: "calc(100vh - 96px)" }}
				>
					<div className="dev-panel-section" style={{ minWidth: 0 }}>
						<div className="dev-panel-label">Layout presets</div>
						<div className="dev-panel-row" style={{ flexWrap: "wrap" }}>
							{DEV_LAB_LAYOUT_PRESETS.map((preset) => (
								<button
									key={preset.id}
									type="button"
									className={`dev-panel-btn ${labLayoutPreset === preset.id ? "dev-panel-btn-primary" : ""}`}
									onClick={() => setLabLayoutPreset(preset.id)}
								>
									{preset.label}
								</button>
							))}
						</div>
					</div>

					<div className="dev-panel-divider" />

					<div className="dev-panel-section" style={{ minWidth: 0 }}>
						<div className="dev-panel-label">Scenario state</div>
						<div className="dev-panel-row" style={{ flexWrap: "wrap" }}>
							{DEV_LAB_SCENARIOS.map((scenario) => (
								<button
									key={scenario.id}
									type="button"
									className={`dev-panel-btn ${labScenarioId === scenario.id ? "dev-panel-btn-primary" : ""}`}
									onClick={() => {
										setLabScenarioId(scenario.id);
										setLabTickerCountOverride(null);
										setLabResultBandVisibleOverride(null);
									}}
								>
									{scenario.label}
								</button>
							))}
						</div>
					</div>

					<div className="dev-panel-divider" />

					<div className="dev-panel-section">
						<div className="dev-panel-label">Content stress</div>
						<div className="dev-panel-row">
							<span className="dev-panel-stat-label">Seed</span>
							<input
								type="number"
								className="dev-panel-input"
								style={{ width: 80 }}
								value={labSeed}
								onChange={(e) => setLabSeed(Number(e.target.value) || 0)}
							/>
						</div>
						<div className="dev-panel-row">
							<span className="dev-panel-stat-label">Ticker</span>
							<input
								type="number"
								className="dev-panel-input"
								style={{ width: 80 }}
								value={labTickerCount}
								onChange={(e) =>
									setLabTickerCountOverride(
										Math.max(0, Number(e.target.value) || 0),
									)
								}
							/>
						</div>
						<div className="dev-panel-row">
							<label className="dev-panel-row">
								<input
									type="checkbox"
									checked={labLongNames}
									onChange={(e) => setLabLongNames(e.target.checked)}
								/>
								<span className="dev-panel-stat-label">Long names</span>
							</label>
						</div>
						<div className="dev-panel-row">
							<label className="dev-panel-row">
								<input
									type="checkbox"
									checked={labLongPersona}
									onChange={(e) => setLabLongPersona(e.target.checked)}
								/>
								<span className="dev-panel-stat-label">Long persona</span>
							</label>
						</div>
						<div className="dev-panel-row">
							<label className="dev-panel-row">
								<input
									type="checkbox"
									checked={labLongCommentary}
									onChange={(e) => setLabLongCommentary(e.target.checked)}
								/>
								<span className="dev-panel-stat-label">Long commentary</span>
							</label>
						</div>
						<div className="dev-panel-row">
							<label className="dev-panel-row">
								<input
									type="checkbox"
									checked={labResultBandVisible}
									onChange={(e) =>
										setLabResultBandVisibleOverride(e.target.checked)
									}
								/>
								<span className="dev-panel-stat-label">Result band</span>
							</label>
						</div>
					</div>

					<div className="dev-panel-divider" />

					<div className="dev-panel-section">
						<div className="dev-panel-label">Diagnostics</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Board shrink</span>
							<span className="dev-panel-stat-accent">
								{activeDiagnostics.boardShrinkRisk ? "risk" : "clear"}
							</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Overflow</span>
							<span className="dev-panel-stat-accent">
								{activeDiagnostics.overflowRisk ? "risk" : "clear"}
							</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Ticker</span>
							<span className="dev-panel-stat-accent">
								{activeDiagnostics.tickerCount}
							</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Stage shell</span>
							<span className="dev-panel-stat-accent">
								{layoutHealth.frameHeightPx > 0
									? `${layoutHealth.frameHeightPx}px`
									: "measuring"}
							</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Board footprint</span>
							<span className="dev-panel-stat-accent">
								{layoutHealth.boardHeightPx > 0
									? `${layoutHealth.boardHeightPx}px (${Math.round(layoutHealth.boardShare * 100)}%)`
									: "measuring"}
							</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Ticker share</span>
							<span className="dev-panel-stat-accent">
								{layoutHealth.tickerHeightPx > 0
									? `${layoutHealth.tickerHeightPx}px (${Math.round(layoutHealth.tickerShare * 100)}%)`
									: "measuring"}
							</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Summary</span>
							<span className="dev-panel-stat-accent">
								{layoutHealth.summary}
							</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Result band</span>
							<span className="dev-panel-stat-accent">
								{activeDiagnostics.resultBandVisible ? "on" : "off"}
							</span>
						</div>
					</div>
				</aside>

				<div
					ref={stageFrameRef}
					className={`dev-lab-stage-frame dev-lab-stage-frame-${layoutHealth.severity}`}
					style={{
						minWidth: 0,
						height: `min(calc(100vh - 120px), ${labModel.layout.height}px)`,
						maxWidth: `${labModel.layout.width}px`,
						margin: "0 auto",
					}}
				>
					<div className="dev-lab-stage-overlay">
						<span className="dev-lab-stage-pill">
							{layoutHealth.severity.toUpperCase()}
						</span>
						<span className="dev-lab-stage-metric">
							Board {Math.round(layoutHealth.boardShare * 100)}%
						</span>
						<span className="dev-lab-stage-metric">
							Ticker {Math.round(layoutHealth.tickerShare * 100)}%
						</span>
						<span className="dev-lab-stage-metric">
							Result {Math.round(layoutHealth.resultBandShare * 100)}%
						</span>
					</div>
					<SpectatorArena
						statusBadge="DEV"
						state={stageModel.state}
						topBarCenterFallback={stageLabel}
						topBarRight={_topBarRight}
						featuredDesk={stageModel.featuredDesk}
						agentCards={stageModel.agentCards}
						tickerItems={stageModel.tickerItems}
						tickerVisibleLimit={stageTickerVisibleLimit}
						resultSummary={stageModel.resultSummary}
						effects={[]}
						unitAnimStates={new Map()}
						dyingUnitIds={new Set()}
						damageNumbers={[]}
						lungeTargets={new Map()}
					/>
				</div>
			</div>

			<details className="dev-panel" style={{ marginTop: "12px" }}>
				<summary className="dev-panel-label">Advanced tools</summary>
				<div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
					<div className="dev-panel-section" style={{ minWidth: 140 }}>
						<div className="dev-panel-label">Mode</div>
						<div className="dev-panel-row">
							<button
								type="button"
								className={`dev-panel-btn ${mode === "lab" ? "dev-panel-btn-primary" : ""}`}
								style={{ flex: 1 }}
								onClick={() => switchMode("lab")}
							>
								Lab
							</button>
							<button
								type="button"
								className={`dev-panel-btn ${mode === "sandbox" ? "dev-panel-btn-primary" : ""}`}
								style={{ flex: 1 }}
								onClick={() => switchMode("sandbox")}
							>
								Sandbox
							</button>
							<button
								type="button"
								className={`dev-panel-btn ${mode === "replay" ? "dev-panel-btn-primary" : ""}`}
								style={{ flex: 1 }}
								onClick={() => switchMode("replay")}
							>
								Replay
							</button>
						</div>
					</div>

					{mode === "lab" ? (
						<div className="dev-panel-section">
							<div className="dev-panel-stat-label">Lab stage</div>
							<div className="dev-panel-row">
								<span className="dev-panel-stat-label">
									Advanced controls are parked while the spectator lab presets
									drive the visible stage.
								</span>
							</div>
						</div>
					) : mode === "sandbox" ? (
						<>
							<div className="dev-panel-section">
								<div className="dev-panel-stat-label">Seed</div>
								<div className="dev-panel-row">
									<input
										type="number"
										className="dev-panel-input"
										style={{ width: 72 }}
										value={seed}
										onChange={(e) => setSeed(Number(e.target.value) || 0)}
									/>
									<button
										type="button"
										className="dev-panel-btn"
										onClick={() => resetSandbox(seed)}
									>
										Reset
									</button>
								</div>
							</div>

							<div className="dev-panel-section">
								<div className="dev-panel-stat-label">Actions</div>
								<div className="dev-panel-row">
									<button
										type="button"
										className="dev-panel-btn dev-panel-btn-primary"
										onClick={playRandomMove}
										disabled={boardState.status !== "active"}
									>
										Random
									</button>
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
								<div className="dev-panel-stat-label">Source</div>
								<div className="dev-panel-row">
									<input
										type="text"
										className="dev-panel-input"
										style={{ width: 180 }}
										value={replayUrl}
										onChange={(e) => setReplayUrl(e.target.value)}
									/>
									<button
										type="button"
										className="dev-panel-btn dev-panel-btn-primary"
										onClick={() => void loadBundle(replayUrl)}
									>
										Load
									</button>
									<button
										type="button"
										className="dev-panel-btn"
										onClick={() => void loadBundle("/dev-replay/latest.json")}
									>
										Latest
									</button>
								</div>
								{replayError ? (
									<div style={{ color: "#ff6b6b", fontSize: "0.6rem" }}>
										{replayError}
									</div>
								) : null}
							</div>

							{bundle ? (
								<>
									<div className="dev-panel-divider" />

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
											<div className="dev-panel-divider" />

											<div className="dev-panel-section">
												<div className="dev-panel-stat-label">Playback</div>
												<div className="dev-panel-row">
													<button
														type="button"
														className="dev-panel-btn"
														onClick={resetMatch}
													>
														Reset
													</button>
													<button
														type="button"
														className="dev-panel-btn"
														onClick={stepReplay}
														disabled={replayPly >= selectedMatch.steps.length}
													>
														Step
													</button>
													<button
														type="button"
														className={`dev-panel-btn ${replayPlaying ? "dev-panel-btn-primary" : ""}`}
														onClick={() => setReplayPlaying((p) => !p)}
														disabled={replayPly >= selectedMatch.steps.length}
													>
														{replayPlaying ? "Pause" : "Play"}
													</button>
													<span className="dev-panel-stat-label">ms</span>
													<input
														type="number"
														className="dev-panel-input"
														style={{ width: 56 }}
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
														{" "}
														{selectedMatch.result.winner ?? "draw"} (
														{selectedMatch.result.reason})
													</span>
												</div>
											</div>

											<div className="dev-panel-divider" />

											<div
												className="dev-panel-section"
												style={{ minWidth: 200 }}
											>
												<div
													className="dev-panel-stat-label"
													style={{
														display: "flex",
														justifyContent: "space-between",
														alignItems: "center",
													}}
												>
													<span>Log ({actionLog.length})</span>
													<button
														type="button"
														className="dev-panel-btn"
														style={{
															padding: "2px 6px",
															fontSize: "0.5rem",
															height: "auto",
														}}
														onClick={() => setLogExpanded((v) => !v)}
													>
														{logExpanded ? "▼" : "▶"}
													</button>
												</div>
												<div
													className={`dev-panel-log ${logExpanded ? "" : "dev-panel-log-collapsed"}`}
												>
													{logExpanded ? (
														actionLog.map((entry, i) => (
															<div key={`log-${actionLog.length - i}`}>
																{entry.label}
															</div>
														))
													) : actionLog.length > 0 ? (
														<div style={{ opacity: 0.6 }}>
															Last: {actionLog[0]?.label}
														</div>
													) : null}
												</div>
											</div>
										</>
									) : null}
								</>
							) : null}
						</>
					)}

					<div className="dev-panel-divider" />

					<div className="dev-panel-section">
						<div className="dev-panel-label">State</div>
						<div className="dev-panel-row">
							<span className="dev-panel-stat-label">
								{boardState.status === "active" ? (
									<span className="dev-panel-stat-accent">active</span>
								) : (
									boardState.status
								)}
							</span>
							<span className="dev-panel-stat-label">T{boardState.turn}</span>
							<span className="dev-panel-stat-label">
								<span
									className={
										boardState.activePlayer === "A"
											? "player-a-color"
											: "player-b-color"
									}
								>
									{boardState.activePlayer}
								</span>
							</span>
							<span className="dev-panel-stat-label">
								AP {boardState.actionsRemaining}
							</span>
							<span className="player-a-color">{unitCountA}u</span>
							<span className="player-b-color">{unitCountB}u</span>
						</div>
					</div>
				</div>
			</details>
		</div>
	);
}
