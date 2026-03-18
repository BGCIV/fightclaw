import {
	applyMove,
	createInitialState,
	DEFAULT_CONFIG,
	type EngineConfigInput,
	type EngineEvent,
	type MatchState,
	type Move,
} from "@fightclaw/engine";
import { env } from "@fightclaw/env/web";
import {
	type AgentThoughtEvent,
	type EngineEventsEvent,
	type MatchEventEnvelope,
	MatchEventEnvelopeSchema,
	type MatchStartedEvent,
} from "@fightclaw/protocol";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { SpectatorArena } from "@/components/arena/spectator-arena";
import {
	type EngineEventsEnvelope,
	useArenaAnimator,
} from "@/lib/arena-animator";

export const Route = createFileRoute("/")({
	component: SpectatorLanding,
	validateSearch: (search: Record<string, unknown>) => ({
		replayMatchId:
			typeof search.replayMatchId === "string"
				? search.replayMatchId
				: undefined,
	}),
});

type FeaturedResponse = {
	matchId: string | null;
	status: string | null;
	players: string[] | null;
};

type MatchLogResponse = {
	matchId: string;
	events: MatchEventEnvelope[];
	hasMore?: boolean;
	nextAfterId?: number | null;
};

const MAX_THOUGHTS = 80;
const STREAM_RECONNECT_DELAY_MS = 1000;

function SpectatorLanding() {
	const search = Route.useSearch();
	const replayMatchId = search.replayMatchId ?? null;

	const [featured, setFeatured] = useState<FeaturedResponse | null>(null);
	const [latestState, setLatestState] = useState<MatchState | null>(null);
	const [connectionStatus, setConnectionStatus] = useState<
		"idle" | "connecting" | "live" | "replay" | "error"
	>("idle");
	const replayFollowStarted = useRef(false);
	const replayAfterIdRef = useRef(0);
	const [replayShouldFollowLive, setReplayShouldFollowLive] = useState(false);
	const [thoughtsA, setThoughtsA] = useState<string[]>([]);
	const [thoughtsB, setThoughtsB] = useState<string[]>([]);
	const [isThinkingA, setIsThinkingA] = useState(false);
	const [isThinkingB, setIsThinkingB] = useState(false);
	const thoughtEventIdsRef = useRef(new Set<string>());

	const matchId = replayMatchId ?? featured?.matchId ?? null;

	const {
		effects,
		unitAnimStates,
		dyingUnitIds,
		hudFx,
		damageNumbers,
		lungeTargets,
		isAnimating,
		enqueue: enqueueEngineEvents,
		reset: resetAnimator,
	} = useArenaAnimator({
		onApplyBaseState: (state) => setLatestState(state),
	});

	const resetThoughts = useEffectEvent(() => {
		setThoughtsA([]);
		setThoughtsB([]);
		setIsThinkingA(false);
		setIsThinkingB(false);
		thoughtEventIdsRef.current.clear();
	});

	const applyThoughtEvent = useEffectEvent((event: AgentThoughtEvent) => {
		const player = event.payload.player;
		if (player !== "A" && player !== "B") return;
		const id = `${event.stateVersion}:${event.payload.moveId}:${player}`;
		if (thoughtEventIdsRef.current.has(id)) return;
		thoughtEventIdsRef.current.add(id);
		const setter = player === "A" ? setThoughtsA : setThoughtsB;
		setter((prev) => [...prev, event.payload.text].slice(-MAX_THOUGHTS));
	});

	const applyLiveEnvelope = useEffectEvent((event: MatchEventEnvelope) => {
		replayAfterIdRef.current = Math.max(
			replayAfterIdRef.current,
			event.eventId,
		);
		switch (event.event) {
			case "state": {
				const state = parseStateFromEnvelope(event);
				if (!state) return;
				setLatestState(state);
				setConnectionStatus("live");
				return;
			}
			case "engine_events":
				enqueueEngineEvents(event as EngineEventsEnvelope);
				setConnectionStatus("live");
				return;
			case "agent_thought":
				applyThoughtEvent(event);
				setConnectionStatus("live");
				return;
			case "match_ended":
			case "game_ended":
				setConnectionStatus("live");
				return;
			default:
				return;
		}
	});

	useEffect(() => {
		if (replayMatchId) return;
		let active = true;
		let source: EventSource | null = null;

		const fetchFeatured = async () => {
			try {
				const res = await fetch(`${env.VITE_SERVER_URL}/v1/featured`);
				if (!res.ok) {
					throw new Error(`Featured request failed (${res.status})`);
				}
				const json = (await res.json()) as FeaturedResponse;
				if (!active) return;
				setFeatured(json);
			} catch {
				if (!active) return;
				setFeatured({ matchId: null, status: null, players: null });
			}
		};

		void fetchFeatured();

		source = new EventSource(`${env.VITE_SERVER_URL}/v1/featured/stream`);
		source.addEventListener(
			"featured_changed",
			(message: MessageEvent<string>) => {
				if (!active) return;
				try {
					const payload = JSON.parse(message.data) as { matchId?: unknown };
					const nextMatchId =
						typeof payload.matchId === "string" || payload.matchId === null
							? payload.matchId
							: null;
					setFeatured((prev) => ({
						matchId: nextMatchId,
						status: prev?.status ?? null,
						players: prev?.players ?? null,
					}));
					void fetchFeatured();
				} catch {
					// Ignore malformed featured stream frames and rely on the next update.
				}
			},
		);
		source.addEventListener("error", () => {
			if (!active) return;
			void fetchFeatured();
		});

		return () => {
			active = false;
			source?.close();
		};
	}, [replayMatchId]);

	useEffect(() => {
		if (replayMatchId) return;

		if (!matchId) {
			resetAnimator();
			setLatestState(null);
			setConnectionStatus("idle");
			resetThoughts();
			replayAfterIdRef.current = 0;
			return;
		}

		let active = true;
		let source: EventSource | null = null;
		let reconnectTimer: number | null = null;

		resetAnimator();
		setLatestState(null);
		setConnectionStatus("connecting");
		resetThoughts();
		replayAfterIdRef.current = 0;

		const connect = (afterId: number) => {
			if (!active) return;
			source?.close();
			source = new EventSource(buildSpectateUrl(matchId, afterId));

			const onEnvelope = (message: MessageEvent<string>) => {
				if (!active) return;
				const envelope = parseMatchEvent(message.data);
				if (!envelope) return;
				applyLiveEnvelope(envelope);
			};

			source.addEventListener("state", onEnvelope as EventListener);
			source.addEventListener("engine_events", onEnvelope as EventListener);
			source.addEventListener("agent_thought", onEnvelope as EventListener);
			source.addEventListener("match_ended", onEnvelope as EventListener);
			source.addEventListener("game_ended", onEnvelope as EventListener);
			source.addEventListener("error", () => {
				if (!active) return;
				source?.close();
				setConnectionStatus("connecting");
				reconnectTimer = window.setTimeout(() => {
					connect(replayAfterIdRef.current);
				}, STREAM_RECONNECT_DELAY_MS);
			});
		};

		connect(0);

		return () => {
			active = false;
			source?.close();
			if (reconnectTimer !== null) {
				window.clearTimeout(reconnectTimer);
			}
		};
	}, [matchId, replayMatchId, resetAnimator]);

	useEffect(() => {
		if (!replayMatchId) {
			replayFollowStarted.current = false;
			setReplayShouldFollowLive(false);
			return;
		}

		let active = true;
		replayFollowStarted.current = false;
		setReplayShouldFollowLive(false);
		replayAfterIdRef.current = 0;
		resetAnimator();
		setFeatured({ matchId: replayMatchId, status: "replay", players: null });
		setLatestState(null);
		setConnectionStatus("connecting");
		resetThoughts();

		const runReplay = async () => {
			try {
				const pageLimit = 1000;
				let afterId = 0;
				let pageMatchId: string | null = null;
				const allEvents: MatchEventEnvelope[] = [];

				for (let page = 0; page < 100; page += 1) {
					const res = await fetch(
						`${env.VITE_SERVER_URL}/v1/matches/${replayMatchId}/log?limit=${pageLimit}&afterId=${afterId}`,
					);
					if (!res.ok) {
						throw new Error(`Log request failed (${res.status})`);
					}
					const pageJson = (await res.json()) as MatchLogResponse;
					pageMatchId = pageJson.matchId;
					if (pageJson.events.length === 0) {
						const nextAfterId =
							typeof pageJson.nextAfterId === "number"
								? pageJson.nextAfterId
								: null;
						if (
							nextAfterId === null ||
							nextAfterId <= afterId ||
							pageJson.hasMore !== true
						) {
							break;
						}
						afterId = nextAfterId;
						continue;
					}
					allEvents.push(...pageJson.events);
					const nextAfterId =
						typeof pageJson.nextAfterId === "number"
							? pageJson.nextAfterId
							: (pageJson.events[pageJson.events.length - 1]?.eventId ?? null);
					if (nextAfterId === null || nextAfterId <= afterId) break;
					afterId = nextAfterId;
					if (pageJson.hasMore !== true) break;
				}

				if (!active) return;

				const started = allEvents.find(
					(event): event is MatchStartedEvent =>
						event.event === "match_started",
				);
				if (!started) {
					throw new Error("Replay missing match_started metadata.");
				}

				const seed =
					typeof started.payload.seed === "number" &&
					Number.isFinite(started.payload.seed)
						? started.payload.seed
						: null;
				const players = Array.isArray(started.payload.players)
					? started.payload.players.filter(
							(value): value is string => typeof value === "string",
						)
					: null;
				const replayEngineConfig = parseReplayEngineConfig(
					started.payload.engineConfig,
				);

				if (seed === null || !players || players.length !== 2) {
					throw new Error("Replay missing match_started metadata.");
				}

				setFeatured({
					matchId: pageMatchId ?? replayMatchId,
					status: "replay",
					players,
				});

				let state = createInitialState(seed, replayEngineConfig, players);
				setLatestState(state);
				setConnectionStatus("replay");

				const thoughtByMoveId = new Map<string, AgentThoughtEvent[]>();
				for (const event of allEvents) {
					if (event.event !== "agent_thought") continue;
					const existing = thoughtByMoveId.get(event.payload.moveId) ?? [];
					existing.push(event);
					thoughtByMoveId.set(event.payload.moveId, existing);
				}

				const moveEvents = allEvents
					.filter(
						(event): event is EngineEventsEvent =>
							event.event === "engine_events",
					)
					.sort((a, b) => a.eventId - b.eventId);

				for (const event of moveEvents) {
					if (!active) return;
					const move = event.payload.move;
					if (!move || typeof move !== "object") continue;

					const result = applyMove(state, move as Move);
					if (!result.ok) {
						throw new Error(
							`Replay engine rejected move at event ${event.eventId}: ${result.error}`,
						);
					}
					state = result.state;

					const engineEvents = Array.isArray(event.payload.engineEvents)
						? (event.payload.engineEvents as EngineEvent[])
						: result.engineEvents;

					const envelope: EngineEventsEnvelope = {
						...event,
						payload: {
							agentId: event.payload.agentId,
							moveId: event.payload.moveId,
							move,
							engineEvents,
						},
					};

					enqueueEngineEvents(envelope, { postState: state });
					const thoughts = thoughtByMoveId.get(event.payload.moveId) ?? [];
					for (const thought of thoughts) {
						applyThoughtEvent(thought);
					}
				}

				replayAfterIdRef.current = allEvents.reduce(
					(maxEventId, event) => Math.max(maxEventId, event.eventId),
					0,
				);

				if (state.status === "active") {
					setReplayShouldFollowLive(true);
				}
			} catch {
				if (!active) return;
				setConnectionStatus("error");
			}
		};

		void runReplay();

		return () => {
			active = false;
		};
	}, [enqueueEngineEvents, replayMatchId, resetAnimator]);

	useEffect(() => {
		if (!replayMatchId) return;
		if (!replayShouldFollowLive) return;
		if (isAnimating) return;
		if (replayFollowStarted.current) return;

		replayFollowStarted.current = true;
		let active = true;
		let source: EventSource | null = null;
		let reconnectTimer: number | null = null;

		const connect = (afterId: number) => {
			if (!active) return;
			source?.close();
			source = new EventSource(buildSpectateUrl(replayMatchId, afterId));

			const onEnvelope = (message: MessageEvent<string>) => {
				if (!active) return;
				const envelope = parseMatchEvent(message.data);
				if (!envelope) return;
				applyLiveEnvelope(envelope);
			};

			source.addEventListener("state", onEnvelope as EventListener);
			source.addEventListener("engine_events", onEnvelope as EventListener);
			source.addEventListener("agent_thought", onEnvelope as EventListener);
			source.addEventListener("match_ended", onEnvelope as EventListener);
			source.addEventListener("game_ended", onEnvelope as EventListener);
			source.addEventListener("error", () => {
				if (!active) return;
				source?.close();
				setConnectionStatus("connecting");
				reconnectTimer = window.setTimeout(() => {
					connect(replayAfterIdRef.current);
				}, STREAM_RECONNECT_DELAY_MS);
			});
		};

		connect(replayAfterIdRef.current);

		return () => {
			active = false;
			source?.close();
			if (reconnectTimer !== null) {
				window.clearTimeout(reconnectTimer);
			}
		};
	}, [isAnimating, replayMatchId, replayShouldFollowLive]);

	const statusBadge = useMemo(() => {
		switch (connectionStatus) {
			case "live":
				return "LIVE";
			case "replay":
				return "REPLAY";
			case "connecting":
				return "SYNC";
			case "error":
				return "ERR";
			default:
				return "IDLE";
		}
	}, [connectionStatus]);

	return (
		<SpectatorArena
			statusBadge={statusBadge}
			state={latestState}
			thoughtsA={thoughtsA}
			thoughtsB={thoughtsB}
			isThinkingA={isThinkingA}
			isThinkingB={isThinkingB}
			hudPassPulse={hudFx.passPulse}
			effects={effects}
			unitAnimStates={unitAnimStates}
			dyingUnitIds={dyingUnitIds}
			damageNumbers={damageNumbers}
			lungeTargets={lungeTargets}
		/>
	);
}

function buildSpectateUrl(matchId: string, afterId: number) {
	const url = new URL(
		`${env.VITE_SERVER_URL}/v1/matches/${encodeURIComponent(matchId)}/spectate`,
	);
	if (afterId > 0) {
		url.searchParams.set("afterId", String(afterId));
	}
	return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMatchEvent(input: string | unknown): MatchEventEnvelope | null {
	const raw =
		typeof input === "string"
			? (() => {
					try {
						return JSON.parse(input) as unknown;
					} catch {
						return null;
					}
				})()
			: input;
	const parsed = MatchEventEnvelopeSchema.safeParse(raw);
	return parsed.success ? (parsed.data as MatchEventEnvelope) : null;
}

function parseStateFromEnvelope(input: unknown): MatchState | null {
	if (!input || typeof input !== "object") {
		return null;
	}

	const container =
		"payload" in input &&
		isRecord((input as { payload?: unknown }).payload) &&
		"state" in (input as { payload: Record<string, unknown> }).payload
			? ((input as { payload: { state?: unknown } }).payload.state ?? null)
			: "state" in input
				? ((input as { state?: unknown }).state ?? null)
				: null;
	if (!container || typeof container !== "object") {
		return null;
	}

	const candidate =
		(container as { game?: unknown }).game ??
		(container as { state?: unknown }).state ??
		container;
	if (candidate && typeof candidate === "object" && "players" in candidate) {
		return candidate as MatchState;
	}

	return null;
}

function parseReplayEngineConfig(
	input: unknown,
): EngineConfigInput | undefined {
	if (!isRecord(input)) return undefined;
	const sanitized = sanitizeEngineConfigInput(input, DEFAULT_CONFIG);
	return sanitized as EngineConfigInput | undefined;
}

function sanitizeEngineConfigInput(
	input: unknown,
	template: unknown,
	path = "",
): unknown | undefined {
	if (typeof template === "number") {
		if (typeof input !== "number" || !Number.isFinite(input)) {
			return undefined;
		}
		if (path === "boardColumns" && input !== 17 && input !== 21) {
			return undefined;
		}
		return input;
	}
	if (!isRecord(template) || Array.isArray(template)) {
		return undefined;
	}
	if (!isRecord(input)) {
		return undefined;
	}
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(template)) {
		if (!(key in input)) continue;
		const nextPath = path ? `${path}.${key}` : key;
		const sanitized = sanitizeEngineConfigInput(
			input[key],
			(template as Record<string, unknown>)[key],
			nextPath,
		);
		if (sanitized === undefined) {
			return undefined;
		}
		out[key] = sanitized;
	}
	return out;
}
