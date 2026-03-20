import type {
	EngineEvent,
	MatchState,
	Move,
	PlayerSide,
	PlayerState,
} from "@fightclaw/engine";
import { MoveSchema } from "@fightclaw/engine";
import type {
	EngineEventsEvent,
	FeaturedSnapshot,
	GameEndedEvent,
	MatchEndedEvent,
	MatchEventEnvelope,
} from "@fightclaw/protocol";

import {
	type PublicAgentIdentityMap,
	resolveBroadcastIdentity,
} from "./public-agent-identity";

export type BroadcastTone = "neutral" | "positive" | "warning" | "danger";

export type BroadcastTickerItem = {
	eventId: number;
	ts: string;
	turn: number | null;
	player: PlayerSide | null;
	text: string;
	tone: BroadcastTone;
};

export type BroadcastAgentCard = {
	side: PlayerSide;
	name: string;
	publicPersona: string | null;
	styleTag: string;
	gold: number;
	wood: number;
	vp: number;
	unitCount: number;
	publicCommentary: string;
};

export type BroadcastFeaturedDesk = {
	matchId: string | null;
	label: string;
	status: "idle" | "live" | "replay" | "ended" | "connecting" | "error";
	playersLabel: string;
};

export type BroadcastResultSummary = {
	headline: string;
	subtitle: string;
	winningSide: PlayerSide | "draw" | null;
	reasonLabel: string;
};

export type SpectatorDeskProjection = {
	featuredDesk: BroadcastFeaturedDesk;
	agentCards: {
		A: BroadcastAgentCard;
		B: BroadcastAgentCard;
	};
	tickerItems: BroadcastTickerItem[];
	resultSummary: BroadcastResultSummary | null;
	topBarRightLabel: string;
};

export type BroadcastDeskInput = {
	connectionStatus: "idle" | "connecting" | "live" | "replay" | "error";
	featured:
		| FeaturedSnapshot
		| {
				matchId: string | null;
				status: "replay";
				players: string[] | null;
		  }
		| null;
	state: MatchState | null;
	thoughtsA: string[];
	thoughtsB: string[];
	tickerItems: BroadcastTickerItem[];
	terminalEvent: MatchEndedEvent | GameEndedEvent | null;
	publicIdentityById: PublicAgentIdentityMap;
};

const MAX_COMMENTARY_LENGTH = 140;
const MAX_TICKER_ITEMS = 8;

export function buildSpectatorDeskProjection(
	input: BroadcastDeskInput,
): SpectatorDeskProjection {
	const featuredDesk = buildFeaturedDesk(
		input.featured,
		input.connectionStatus,
		!!input.terminalEvent,
	);
	const agentCards = {
		A: buildAgentCard(
			"A",
			input.state,
			input.thoughtsA,
			input.publicIdentityById,
		),
		B: buildAgentCard(
			"B",
			input.state,
			input.thoughtsB,
			input.publicIdentityById,
		),
	};
	const tickerItems = input.tickerItems.slice(-MAX_TICKER_ITEMS);
	const resultSummary = buildResultSummary(input.state, input.terminalEvent);

	return {
		featuredDesk,
		agentCards,
		tickerItems,
		resultSummary,
		topBarRightLabel:
			resultSummary?.headline ??
			(featuredDesk.matchId ? featuredDesk.label : "no featured match"),
	};
}

export function appendBroadcastTickerItem(
	items: BroadcastTickerItem[],
	item: BroadcastTickerItem,
): BroadcastTickerItem[] {
	if (items.some((current) => current.eventId === item.eventId)) {
		return items;
	}
	return [...items, item].slice(-MAX_TICKER_ITEMS);
}

export function projectBroadcastTickerItem(
	event: EngineEventsEvent,
): BroadcastTickerItem | null {
	const parsedMove = MoveSchema.safeParse(event.payload.move);
	if (!parsedMove.success) return null;
	const move = parsedMove.data;
	const player = inferPlayerFromEngineEvents(event.payload.engineEvents);
	const text = describeMove(move, player);
	const tone = inferTickerTone(move);

	return {
		eventId: event.eventId,
		ts: event.ts,
		turn: inferTurnFromEngineEvents(event.payload.engineEvents),
		player,
		text,
		tone,
	};
}

export function isTerminalDeskEvent(
	event: MatchEventEnvelope,
): event is MatchEndedEvent | GameEndedEvent {
	return event.event === "match_ended" || event.event === "game_ended";
}

export function projectPublicCommentary(thoughts: string[]): string {
	const latest = thoughts.at(-1)?.trim();
	if (!latest) return "No public commentary yet.";
	return truncate(latest, MAX_COMMENTARY_LENGTH);
}

function buildFeaturedDesk(
	featured: BroadcastDeskInput["featured"],
	connectionStatus: BroadcastDeskInput["connectionStatus"],
	hasTerminalResult: boolean,
): BroadcastFeaturedDesk {
	if (!featured) {
		return {
			matchId: null,
			label:
				connectionStatus === "connecting"
					? "Syncing featured board"
					: "No featured match",
			status: connectionStatus === "connecting" ? "connecting" : "idle",
			playersLabel: "Waiting for a live board",
		};
	}

	if (featured.status === "replay") {
		return {
			matchId: featured.matchId,
			label: "Replay featured",
			status: "replay",
			playersLabel: formatPlayers(featured.players),
		};
	}

	return {
		matchId: featured.matchId,
		label: hasTerminalResult
			? "Featured final"
			: connectionStatus === "connecting"
				? "Featured syncing"
				: connectionStatus === "error"
					? "Featured stalled"
					: "Featured live",
		status: hasTerminalResult ? "ended" : connectionStatus,
		playersLabel: formatPlayers(featured.players),
	};
}

function buildAgentCard(
	side: PlayerSide,
	state: MatchState | null,
	thoughts: string[],
	publicIdentityById: PublicAgentIdentityMap,
): BroadcastAgentCard {
	const player = state?.players[side];
	const opponent = state?.players[side === "A" ? "B" : "A"];
	const unitCount = player?.units.length ?? 0;
	const publicCommentary = projectPublicCommentary(thoughts);
	const fallbackStyleTag = buildStyleTag(side, player, opponent, state);
	const identity = resolveBroadcastIdentity({
		agentId: player?.id,
		fallbackName: player?.id ?? `Player ${side}`,
		fallbackStyleTag,
		publicIdentityById,
	});

	return {
		side,
		name: identity.name,
		publicPersona: identity.publicPersona,
		styleTag: identity.styleTag,
		gold: player?.gold ?? 0,
		wood: player?.wood ?? 0,
		vp: player?.vp ?? 0,
		unitCount,
		publicCommentary,
	};
}

function buildStyleTag(
	side: PlayerSide,
	player: PlayerState | undefined,
	opponent: PlayerState | undefined,
	state: MatchState | null,
): string {
	if (!state || !player || !opponent) return "Awaiting board";

	const unitLead = player.units.length - opponent.units.length;
	const resourceLead =
		player.gold + player.wood - (opponent.gold + opponent.wood);
	const vpLead = player.vp - opponent.vp;
	const isActive = state.activePlayer === side;

	if (vpLead >= 3 || unitLead >= 3) return isActive ? "Pressing" : "Dominant";
	if (vpLead <= -3 || unitLead <= -3)
		return isActive ? "Clawing Back" : "Pinned";
	if (resourceLead >= 10) return "Scaling";
	if (resourceLead <= -10) return "Resource Tight";
	if (player.units.length <= 2) return "Scrappy";
	return isActive ? "On Turn" : "Balanced";
}

function buildResultSummary(
	state: MatchState | null,
	terminalEvent: MatchEndedEvent | GameEndedEvent | null,
): BroadcastResultSummary | null {
	if (!terminalEvent && state?.status !== "ended") return null;

	const winnerAgentId = terminalEvent?.payload.winnerAgentId ?? null;
	const loserAgentId = terminalEvent?.payload.loserAgentId ?? null;
	const reason =
		terminalEvent?.payload.reasonCode ?? terminalEvent?.payload.reason;
	const reasonLabel = formatReason(reason);

	let winningSide: PlayerSide | "draw" | null = null;
	let headline = "Match ended";
	let subtitle = reasonLabel;

	if (state) {
		const aId = state.players.A.id;
		const bId = state.players.B.id;
		if (winnerAgentId && winnerAgentId === aId) {
			winningSide = "A";
			headline = "A wins";
			subtitle =
				loserAgentId === bId ? `${reasonLabel} · B falls` : reasonLabel;
		} else if (winnerAgentId && winnerAgentId === bId) {
			winningSide = "B";
			headline = "B wins";
			subtitle =
				loserAgentId === aId ? `${reasonLabel} · A falls` : reasonLabel;
		} else {
			winningSide = "draw";
			headline = "Draw";
			subtitle = reasonLabel;
		}
	}

	return {
		headline,
		subtitle,
		winningSide,
		reasonLabel,
	};
}

function describeMove(move: Move, player: PlayerSide | null): string {
	const actor = player ? `${player}` : "player";
	switch (move.action) {
		case "move":
			return `${actor} advanced ${move.unitId} to ${move.to}`;
		case "attack":
			return `${actor} attacked ${move.target} with ${move.unitId}`;
		case "recruit":
			return `${actor} recruited ${move.unitType} at ${move.at}`;
		case "fortify":
			return `${actor} fortified ${move.unitId}`;
		case "upgrade":
			return `${actor} upgraded ${move.unitId}`;
		case "end_turn":
			return `${actor} ended turn`;
		case "pass":
			return `${actor} passed`;
		default:
			return `${actor} made a move`;
	}
}

function inferTickerTone(move: Move): BroadcastTone {
	switch (move.action) {
		case "attack":
		case "upgrade":
			return "positive";
		case "pass":
		case "end_turn":
			return "neutral";
		case "fortify":
			return "warning";
		default:
			return "neutral";
	}
}

function inferPlayerFromEngineEvents(
	engineEvents: EngineEventsEvent["payload"]["engineEvents"],
): PlayerSide | null {
	for (const event of engineEvents as EngineEvent[]) {
		if ("player" in event && (event.player === "A" || event.player === "B")) {
			return event.player;
		}
	}
	return null;
}

function inferTurnFromEngineEvents(
	engineEvents: EngineEventsEvent["payload"]["engineEvents"],
): number | null {
	for (const event of engineEvents as EngineEvent[]) {
		if ("turn" in event && typeof event.turn === "number") {
			return event.turn;
		}
	}
	return null;
}

function formatPlayers(players: string[] | null): string {
	if (!players || players.length === 0) return "No player names";
	return players.join(" vs ");
}

function formatReason(reason: string | undefined | null): string {
	if (!reason) return "Terminal state";
	return reason
		.split(/[_-]/g)
		.map((part) =>
			part ? (part[0]?.toUpperCase() ?? "") + part.slice(1) : part,
		)
		.join(" ");
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
