import { createInitialState, type MatchState } from "@fightclaw/engine";

import { buildPublicAgentIdentityMap } from "./public-agent-identity";
import {
	type BroadcastAgentCard,
	type BroadcastFeaturedDesk,
	type BroadcastResultSummary,
	type BroadcastTickerItem,
	buildSpectatorDeskProjection,
} from "./spectator-desk";

export type DevLabLayoutPresetId =
	| "desktop"
	| "laptop"
	| "portrait"
	| "ultrawide";

export type DevLabScenarioId =
	| "live-board"
	| "action-burst"
	| "ticker-stress"
	| "replay-snapshot"
	| "terminal-board";

export type DevLabLayoutPreset = {
	id: DevLabLayoutPresetId;
	label: string;
	width: number;
	height: number;
	description: string;
};

export type DevLabScenario = {
	id: DevLabScenarioId;
	label: string;
	description: string;
	boardFrozen: boolean;
	resultBandVisible: boolean;
	defaultTickerCount: number;
};

export type DevLabDiagnostics = {
	boardShrinkRisk: boolean;
	overflowRisk: boolean;
	resultBandVisible: boolean;
	tickerCount: number;
};

export type DevLabModel = {
	layout: {
		preset: DevLabLayoutPreset;
		width: number;
		height: number;
	};
	scenario: DevLabScenario;
	state: MatchState;
	board: {
		columns: 17;
		isFrozen: boolean;
	};
	featuredDesk: BroadcastFeaturedDesk;
	agentCards: {
		A: BroadcastAgentCard;
		B: BroadcastAgentCard;
	};
	tickerItems: BroadcastTickerItem[];
	resultSummary: BroadcastResultSummary | null;
	diagnostics: DevLabDiagnostics;
};

export type DevSpectatorLabInput = {
	layoutPreset?: DevLabLayoutPresetId;
	scenarioId?: DevLabScenarioId;
	tickerCount?: number;
	longNames?: boolean;
	longPersona?: boolean;
	longCommentary?: boolean;
	resultBandVisible?: boolean;
	seed?: number;
};

export const DEV_LAB_LAYOUT_PRESETS: DevLabLayoutPreset[] = [
	{
		id: "desktop",
		label: "Desktop",
		width: 1440,
		height: 900,
		description: "Balanced production-sized viewport for broad UI checks.",
	},
	{
		id: "laptop",
		label: "Laptop",
		width: 1280,
		height: 800,
		description: "Common working viewport with moderate layout pressure.",
	},
	{
		id: "portrait",
		label: "Portrait",
		width: 900,
		height: 1280,
		description:
			"Tall viewport to reproduce shrinking-board and overflow bugs.",
	},
	{
		id: "ultrawide",
		label: "Ultrawide",
		width: 1920,
		height: 1080,
		description:
			"Wide viewport for stretched broadcast layouts and ticker growth.",
	},
];

export const DEV_LAB_SCENARIOS: DevLabScenario[] = [
	{
		id: "live-board",
		label: "Live board",
		description: "Default live spectator state with light ticker pressure.",
		boardFrozen: false,
		resultBandVisible: false,
		defaultTickerCount: 4,
	},
	{
		id: "action-burst",
		label: "Action burst",
		description:
			"Simulates a dense recent-action spike without forcing a final result.",
		boardFrozen: false,
		resultBandVisible: false,
		defaultTickerCount: 10,
	},
	{
		id: "ticker-stress",
		label: "Ticker stress",
		description: "Pushes the action feed hard to expose board shrink issues.",
		boardFrozen: false,
		resultBandVisible: true,
		defaultTickerCount: 14,
	},
	{
		id: "replay-snapshot",
		label: "Replay snapshot",
		description: "Frozen board for replay and layout verification.",
		boardFrozen: true,
		resultBandVisible: true,
		defaultTickerCount: 4,
	},
	{
		id: "terminal-board",
		label: "Terminal board",
		description: "Ended match state with result band visible.",
		boardFrozen: true,
		resultBandVisible: true,
		defaultTickerCount: 6,
	},
];

const DEFAULT_TICKER_COUNT = 8;

export function buildDevSpectatorLabModel(
	input: DevSpectatorLabInput = {},
): DevLabModel {
	const layoutPreset =
		findLayoutPreset(input.layoutPreset) ?? DEV_LAB_LAYOUT_PRESETS[0];
	const scenario = findScenario(input.scenarioId) ?? DEV_LAB_SCENARIOS[0];
	const seed = input.seed ?? 42;
	const tickerCount = Math.max(
		0,
		input.tickerCount ?? scenario.defaultTickerCount ?? DEFAULT_TICKER_COUNT,
	);
	const longNames = input.longNames ?? false;
	const longPersona = input.longPersona ?? false;
	const longCommentary = input.longCommentary ?? false;
	const resultBandVisible =
		input.resultBandVisible ?? scenario.resultBandVisible;
	const state = buildScenarioState(seed, scenario.id);
	const featured = buildFeaturedSnapshot(scenario.id);
	const terminalEvent = buildTerminalEvent(scenario.id);
	const thoughtsA = buildThoughts("A", longCommentary);
	const thoughtsB = buildThoughts("B", longCommentary);
	const publicIdentityById = buildPublicAgentIdentityMap([
		buildIdentity("A", longNames, longPersona, longCommentary),
		buildIdentity("B", longNames, longPersona, longCommentary),
	]);

	const tickerItems = buildTickerItems(tickerCount, seed);
	const projection = buildSpectatorDeskProjection({
		connectionStatus: scenario.id === "replay-snapshot" ? "replay" : "live",
		featured,
		state,
		thoughtsA,
		thoughtsB,
		tickerItems,
		terminalEvent,
		publicIdentityById,
	});
	const boardShrinkRisk =
		layoutPreset.id === "portrait" ||
		tickerCount > 8 ||
		longPersona ||
		longCommentary;
	const overflowRisk =
		layoutPreset.id !== "desktop" &&
		(tickerCount > 8 || longPersona || longCommentary || longNames);

	return {
		layout: {
			preset: layoutPreset,
			width: layoutPreset.width,
			height: layoutPreset.height,
		},
		scenario,
		state,
		board: {
			columns: 17,
			isFrozen: scenario.boardFrozen,
		},
		featuredDesk: projection.featuredDesk,
		agentCards: projection.agentCards,
		tickerItems,
		resultSummary: resultBandVisible
			? (projection.resultSummary ?? buildMockResultSummary())
			: null,
		diagnostics: {
			boardShrinkRisk,
			overflowRisk,
			resultBandVisible,
			tickerCount,
		},
	};
}

function findLayoutPreset(
	id: DevLabLayoutPresetId | undefined,
): DevLabLayoutPreset | undefined {
	if (!id) return undefined;
	return DEV_LAB_LAYOUT_PRESETS.find((preset) => preset.id === id);
}

function findScenario(
	id: DevLabScenarioId | undefined,
): DevLabScenario | undefined {
	if (!id) return undefined;
	return DEV_LAB_SCENARIOS.find((scenario) => scenario.id === id);
}

function buildIdentity(
	side: "A" | "B",
	longNames: boolean,
	longPersona: boolean,
	longCommentary: boolean,
): {
	agentId: string;
	agentName: string;
	publicPersona: string | null;
	styleTag: string | null;
} {
	const label = side === "A" ? "Alpha" : "Bravo";
	const name = longNames ? `DEV-LAB-${label.toUpperCase()}-OVERLAY` : label;
	const publicPersona = longPersona
		? [
				"Terrain-first opportunist who keeps pressure on the center lane,",
				"favors durable tempo over bursty tricks, and uses long-form",
				"commentary to stress the spectator layout until the board footprint",
				"starts revealing clipping or shrinkage.",
			].join(" ")
		: `Terrain-first ${label.toLowerCase()} with a compact public persona.`;

	return {
		agentId: `dev-${side.toLowerCase()}`,
		agentName: name,
		publicPersona,
		styleTag: longCommentary ? "PRESSURE" : "GENERAL",
	};
}

function buildTickerItems(count: number, seed: number): BroadcastTickerItem[] {
	const items: BroadcastTickerItem[] = [];
	for (let index = 0; index < count; index += 1) {
		const turn = Math.floor(index / 2) + 1;
		const player = index % 2 === 0 ? "A" : "B";
		items.push({
			eventId: seed * 100 + index + 1,
			ts: new Date(Date.UTC(2026, 2, 20, 12, 0, index)).toISOString(),
			turn,
			player,
			text: `Action ${index + 1}: ${player} advances the lab feed.`,
			tone: index % 5 === 0 ? "warning" : "neutral",
		});
	}
	return items;
}

function buildScenarioState(
	seed: number,
	scenarioId: DevLabScenarioId,
): MatchState {
	const state = createInitialState(seed, { boardColumns: 17 }, [
		"dev-a",
		"dev-b",
	]);
	if (scenarioId === "terminal-board") {
		return {
			...state,
			status: "ended",
		};
	}
	return state;
}

function buildFeaturedSnapshot(scenarioId: DevLabScenarioId):
	| {
			matchId: string | null;
			status: "replay";
			players: string[] | null;
	  }
	| {
			matchId: string | null;
			status: "active" | null;
			players: string[] | null;
	  } {
	if (scenarioId === "replay-snapshot") {
		return {
			matchId: "dev-replay-match",
			status: "replay",
			players: ["Alpha", "Bravo"],
		};
	}

	return {
		matchId: "dev-featured-match",
		status: "active",
		players: ["Alpha", "Bravo"],
	};
}

function buildTerminalEvent(scenarioId: DevLabScenarioId) {
	if (scenarioId !== "terminal-board") return null;
	return {
		eventVersion: 2 as const,
		eventId: 999,
		ts: new Date(Date.UTC(2026, 2, 20, 12, 30, 0)).toISOString(),
		matchId: "dev-featured-match",
		stateVersion: 999,
		event: "match_ended" as const,
		payload: {
			winnerAgentId: "dev-a",
			loserAgentId: "dev-b",
			reasonCode: "elimination" as const,
		},
	};
}

function buildThoughts(side: "A" | "B", longCommentary: boolean): string[] {
	const label = side === "A" ? "Alpha" : "Bravo";
	if (!longCommentary) {
		return [`Stable commentary pulse for ${label.toLowerCase()}.`];
	}
	return [
		"Action ticker pressure is climbing and the board should stay stable.",
		"Watch for layout collapse when the feed grows past the normal cap.",
		`Use this ${label.toLowerCase()} lane to confirm the spectator stage keeps its footprint while long commentary, tall feeds, and dense chrome all compete for space at once.`,
	];
}

function buildMockResultSummary(): BroadcastResultSummary {
	return {
		headline: "A wins",
		subtitle: "Elimination · B falls",
		winningSide: "A",
		reasonLabel: "Elimination",
	};
}
