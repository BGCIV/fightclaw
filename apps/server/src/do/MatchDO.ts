import { DurableObject } from "cloudflare:workers";
import {
	applyMove,
	type EngineEvent,
	type GameState,
	getEngineConfig,
	initialState,
	isTerminal,
	type Move,
	MoveSchema,
	winner,
} from "@fightclaw/engine";
import { z } from "zod";
import type { AppBindings } from "../appTypes";
import { ELO_START } from "../constants/rating";
import { log } from "../obs/log";
import { emitMetric } from "../obs/metrics";
import {
	buildAgentThoughtEvent,
	buildEngineEventsEvent,
	buildGameEndedAliasEvent,
	buildLiveMatchEndedEvent,
	buildLiveStateEvent,
	buildLiveYourTurnEvent,
	buildMatchEndedEvent,
	buildStoredMatchEventEnvelope,
} from "../protocol/events";
import { formatSse } from "../protocol/sse";
import { isRecord } from "../utils/typeGuards";

type MatchEnv = Pick<
	AppBindings,
	| "DB"
	| "API_KEY_PEPPER"
	| "MATCHMAKER"
	| "INTERNAL_RUNNER_KEY"
	| "TURN_TIMEOUT_SECONDS"
	| "TEST_MODE"
	| "OBS"
	| "SENTRY_ENVIRONMENT"
>;

type MatchState = {
	stateVersion: number;
	status: "active" | "ended";
	updatedAt: string;
	createdAt: string;
	turnExpiresAtMs?: number;
	players: string[];
	game: GameState;
	lastMove: Move | null;
	endedAt?: string;
	winnerAgentId?: string;
	loserAgentId?: string;
	endReason?: string;
	mode: "ranked";
};

type MoveResult =
	| { ok: true; state: MatchState; engineEvents: EngineEvent[] }
	| { ok: false; error: string; reason?: string };

type MovePayload = {
	moveId: string;
	expectedVersion: number;
	move: unknown;
	publicThought?: string;
};

type MoveResponse =
	| { ok: true; state: MatchState }
	| {
			ok: false;
			error: string;
			stateVersion?: number;
			forfeited?: boolean;
			matchStatus?: "ended";
			winnerAgentId?: string | null;
			reason?: string;
			reasonCode?: string;
	  };

type FinishPayload = {
	reason?: "forfeit";
};

type FinishResponse =
	| { ok: true; state: MatchState }
	| { ok: false; error: string };

type IdempotencyEntry = {
	status: number;
	body: MoveResponse;
};

type StreamWriter = WritableStreamDefaultWriter<Uint8Array>;

const IDEMPOTENCY_PREFIX = "move:";
const IDEMPOTENCY_INDEX_KEY = "idempotency:index";
// Bound idempotency cache size to avoid unbounded DO storage growth.
const IDEMPOTENCY_MAX = 200;
const MATCH_ID_KEY = "matchId";
const SSE_WRITE_TIMEOUT_MS = 5000;
const TEST_STREAM_MAX_LIFETIME_MS = 30000;
const DEFAULT_TURN_TIMEOUT_SECONDS = 60;
const ELO_K = 32;
const MAX_PUBLIC_THOUGHT_LEN = 280;

const stripControlCharsExceptNewline = (input: string) => {
	let output = "";
	for (const char of input) {
		const code = char.charCodeAt(0);
		if ((code >= 0 && code <= 31 && code !== 10) || code === 127) {
			output += " ";
			continue;
		}
		output += char;
	}
	return output;
};

const initPayloadSchema = z
	.object({
		players: z.array(z.string()).length(2),
		seed: z.number().int().optional(),
		mode: z.literal("ranked").optional(),
	})
	.strict();

type RunnerTelemetry = {
	requestId: string;
	modelProvider: string | null;
	modelId: string | null;
	promptVersionId: string | null;
	inferenceMs: number | null;
	tokensIn: number | null;
	tokensOut: number | null;
};

const sanitizeHeaderText = (value: string | null, max = 120) => {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

const parseHeaderInt = (value: string | null) => {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return null;
	return parsed;
};

const extractRunnerTelemetry = (headers: Headers): RunnerTelemetry | null => {
	const modelProvider = sanitizeHeaderText(
		headers.get("x-fc-model-provider"),
		80,
	);
	const modelId = sanitizeHeaderText(headers.get("x-fc-model-id"), 120);
	const promptVersionId = sanitizeHeaderText(
		headers.get("x-fc-prompt-version-id"),
		80,
	);
	const inferenceMs = parseHeaderInt(headers.get("x-fc-inference-ms"));
	const tokensIn = parseHeaderInt(headers.get("x-fc-tokens-in"));
	const tokensOut = parseHeaderInt(headers.get("x-fc-tokens-out"));

	if (
		!modelProvider &&
		!modelId &&
		!promptVersionId &&
		inferenceMs === null &&
		tokensIn === null &&
		tokensOut === null
	) {
		return null;
	}

	return {
		requestId: headers.get("x-request-id") ?? crypto.randomUUID(),
		modelProvider,
		modelId,
		promptVersionId,
		inferenceMs,
		tokensIn,
		tokensOut,
	};
};

const sanitizePublicThought = (value: unknown) => {
	if (typeof value !== "string") return null;
	const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	// Keep newline normalization deterministic while removing other control chars.
	// Newlines are flattened below for one-line spectator thought rendering.
	const trimmed = stripControlCharsExceptNewline(normalized)
		.replaceAll("\n", " ")
		.trim();
	if (!trimmed) return null;
	return trimmed.length > MAX_PUBLIC_THOUGHT_LEN
		? trimmed.slice(0, MAX_PUBLIC_THOUGHT_LEN)
		: trimmed;
};

export class MatchDO extends DurableObject<MatchEnv> {
	private readonly encoder = new TextEncoder();
	private spectators = new Set<StreamWriter>();
	private agentStreams = new Map<string, Set<StreamWriter>>();
	private matchId: string | null = null;

	constructor(ctx: DurableObjectState, env: MatchEnv) {
		super(ctx, env);
		this.matchId = ctx.id.name ?? null;
	}

	async alarm(): Promise<void> {
		const state = await this.ctx.storage.get<MatchState>("state");
		if (!state) return;

		const timeoutChecked = await this.maybeEnforceTurnTimeout(state);
		await this.scheduleNextAlarm(timeoutChecked);
	}

	private turnTimeoutMs(): number {
		const raw = this.env.TURN_TIMEOUT_SECONDS;
		const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
		if (Number.isNaN(parsed) || parsed <= 0) {
			return DEFAULT_TURN_TIMEOUT_SECONDS * 1000;
		}
		const seconds = parsed;
		return seconds * 1000;
	}

	private async scheduleNextAlarm(state: MatchState) {
		if (state.status !== "active") {
			await this.ctx.storage.deleteAlarm();
			return;
		}

		const deadlines: number[] = [];
		if (
			typeof state.turnExpiresAtMs === "number" &&
			Number.isFinite(state.turnExpiresAtMs) &&
			state.turnExpiresAtMs > 0
		) {
			deadlines.push(state.turnExpiresAtMs);
		}
		if (deadlines.length === 0) {
			await this.ctx.storage.deleteAlarm();
			return;
		}

		await this.ctx.storage.setAlarm(Math.min(...deadlines));
	}

	private async maybeEnforceTurnTimeout(
		state: MatchState,
	): Promise<MatchState> {
		if (state.status !== "active") return state;
		let nextState = state;

		const nowMs = Date.now();
		const timeoutMs = this.turnTimeoutMs();
		const expiresAt = nextState.turnExpiresAtMs;
		if (
			typeof expiresAt !== "number" ||
			!Number.isFinite(expiresAt) ||
			expiresAt <= 0
		) {
			const baseMs = Date.parse(nextState.updatedAt);
			const startMs = Number.isFinite(baseMs) ? baseMs : nowMs;
			const next: MatchState = {
				...nextState,
				turnExpiresAtMs: startMs + timeoutMs,
			};
			await this.ctx.storage.put("state", next);
			await this.scheduleNextAlarm(next);
			nextState = next;
		}

		const finalExpiresAt =
			typeof nextState.turnExpiresAtMs === "number" &&
			Number.isFinite(nextState.turnExpiresAtMs)
				? nextState.turnExpiresAtMs
				: null;
		if (finalExpiresAt !== null && nowMs >= finalExpiresAt) {
			const activeAgentId = getActiveAgentId(nextState.game);
			if (activeAgentId) {
				return await this.forfeitMatch(
					nextState,
					activeAgentId,
					"turn_timeout",
				);
			}
		}

		return nextState;
	}

	private async persistRunnerTelemetry(
		agentId: string,
		telemetry: RunnerTelemetry,
	) {
		const matchId = await this.resolveMatchId();
		if (!matchId) return;

		const promptVersionId = telemetry.promptVersionId
			? z.string().uuid().safeParse(telemetry.promptVersionId).success
				? telemetry.promptVersionId
				: null
			: null;

		try {
			const existing = await this.env.DB.prepare(
				"SELECT prompt_version_id, model_provider, model_id FROM match_players WHERE match_id = ? AND agent_id = ? LIMIT 1",
			)
				.bind(matchId, agentId)
				.first<{
					prompt_version_id: string | null;
					model_provider: string | null;
					model_id: string | null;
				}>();
			if (!existing) return;

			if (
				promptVersionId &&
				existing.prompt_version_id &&
				existing.prompt_version_id !== promptVersionId
			) {
				log("warn", "runner_prompt_version_mismatch", {
					requestId: telemetry.requestId,
					matchId,
					agentId,
					existingPromptVersionId: existing.prompt_version_id,
					providedPromptVersionId: promptVersionId,
				});
			}

			const setPromptVersionId = existing.prompt_version_id
				? null
				: promptVersionId;
			const setModelProvider = existing.model_provider
				? null
				: telemetry.modelProvider;
			const setModelId = existing.model_id ? null : telemetry.modelId;

			if (setPromptVersionId || setModelProvider || setModelId) {
				await this.env.DB.prepare(
					[
						"UPDATE match_players",
						"SET",
						"prompt_version_id = COALESCE(prompt_version_id, ?),",
						"model_provider = COALESCE(model_provider, ?),",
						"model_id = COALESCE(model_id, ?)",
						"WHERE match_id = ? AND agent_id = ?",
					].join(" "),
				)
					.bind(
						setPromptVersionId,
						setModelProvider,
						setModelId,
						matchId,
						agentId,
					)
					.run();
			}

			if (promptVersionId) {
				emitMetric(this.env, "prompt_version_attached", {
					scope: "match_do",
					requestId: telemetry.requestId,
					matchId,
					agentId,
					promptVersionId,
				});
			}

			if (telemetry.modelProvider || telemetry.modelId) {
				emitMetric(this.env, "agent_model_seen", {
					scope: "match_do",
					requestId: telemetry.requestId,
					matchId,
					agentId,
					promptVersionId: promptVersionId ?? undefined,
					modelProvider: telemetry.modelProvider ?? undefined,
					modelId: telemetry.modelId ?? undefined,
				});
			}

			if (
				telemetry.inferenceMs !== null ||
				telemetry.tokensIn !== null ||
				telemetry.tokensOut !== null
			) {
				emitMetric(this.env, "agent_inference", {
					scope: "match_do",
					requestId: telemetry.requestId,
					matchId,
					agentId,
					promptVersionId: promptVersionId ?? undefined,
					modelProvider: telemetry.modelProvider ?? undefined,
					modelId: telemetry.modelId ?? undefined,
					doubles: [
						telemetry.inferenceMs ?? 0,
						telemetry.tokensIn ?? 0,
						telemetry.tokensOut ?? 0,
					],
				});
			}
		} catch (error) {
			log("warn", "runner_telemetry_persist_failed", {
				requestId: telemetry.requestId,
				matchId,
				agentId,
				error: (error as Error).message ?? String(error),
			});
		}
	}

	async fetch(request: Request): Promise<Response> {
		const headerMatchId = request.headers.get("x-match-id");
		if (!this.matchId) {
			this.matchId = this.ctx.id.name ?? headerMatchId ?? null;
		}

		const url = new URL(request.url);

		if (request.method === "POST" && url.pathname === "/__test__/reset") {
			if (!this.env.TEST_MODE)
				return new Response("Not found", { status: 404 });
			const runnerKey = request.headers.get("x-runner-key");
			if (!runnerKey || runnerKey !== this.env.INTERNAL_RUNNER_KEY) {
				return new Response("Unauthorized", { status: 401 });
			}
			await this.resetForTest();
			return Response.json({ ok: true });
		}

		if (request.method === "POST" && url.pathname === "/init") {
			const body = await request.json().catch(() => null);
			const parsed = initPayloadSchema.safeParse(body);
			if (!parsed.success) {
				return Response.json(
					{ ok: false, error: "Init payload must include two players." },
					{ status: 400 },
				);
			}

			const existing = await this.ctx.storage.get<MatchState>("state");
			if (existing) {
				const enforced = await this.maybeEnforceTurnTimeout(existing);
				return Response.json({ ok: true, state: enforced });
			}

			const seed = parsed.data.seed ?? Math.floor(Math.random() * 1_000_000);
			const nextState = createInitialState(
				parsed.data.players,
				seed,
				parsed.data.mode ?? "ranked",
			);
			const timeoutMs = this.turnTimeoutMs();
			nextState.turnExpiresAtMs = Date.now() + timeoutMs;
			if (this.matchId) {
				await this.ctx.storage.put(MATCH_ID_KEY, this.matchId);
			}
			await this.ctx.storage.put("state", nextState);
			await this.scheduleNextAlarm(nextState);
			await this.recordEvent(nextState, "match_started", {
				players: nextState.players,
				seed,
				engineConfig: getEngineConfig(nextState.game),
				stateVersion: nextState.stateVersion,
				mode: nextState.mode,
			});

			// Emit match_started metric
			const matchIdForMetric = this.matchId ?? this.ctx.id.name;
			if (matchIdForMetric) {
				emitMetric(this.env, "match_started", {
					scope: "match_do",
					matchId: matchIdForMetric,
				});
			}

			await this.broadcastState(nextState);
			await this.broadcastYourTurn(nextState);
			return Response.json({ ok: true, state: nextState });
		}

		if (request.method === "POST" && url.pathname === "/move") {
			const body = await request.json().catch(() => null);
			if (!isMovePayload(body)) {
				return Response.json(
					{
						ok: false,
						error:
							"Move payload must include moveId, expectedVersion, and move.",
					},
					{ status: 400 },
				);
			}

			const agentId = request.headers.get("x-agent-id");
			if (!agentId) {
				return Response.json(
					{ ok: false, error: "Agent id is required." },
					{ status: 400 },
				);
			}

			const telemetry = extractRunnerTelemetry(request.headers);
			if (telemetry) {
				this.ctx.waitUntil(this.persistRunnerTelemetry(agentId, telemetry));
			}

			const idempotencyKey = `${IDEMPOTENCY_PREFIX}${body.moveId}`;
			const cached =
				await this.ctx.storage.get<IdempotencyEntry>(idempotencyKey);
			if (cached) {
				return Response.json(cached.body, { status: cached.status });
			}

			let state = await this.ctx.storage.get<MatchState>("state");
			if (!state) {
				const response = {
					ok: false,
					error: "Match not initialized.",
				} satisfies MoveResponse;
				await this.storeIdempotency(
					body.moveId,
					{ status: 409, body: response },
					-1,
				);
				return Response.json(response, { status: 409 });
			}

			state = await this.maybeEnforceTurnTimeout(state);
			if (state.status === "ended") {
				const response = {
					ok: false,
					error: "Match has ended.",
					stateVersion: state.stateVersion,
				} satisfies MoveResponse;
				await this.storeIdempotency(
					body.moveId,
					{ status: 409, body: response },
					state.stateVersion,
				);
				return Response.json(response, { status: 409 });
			}

			if (body.expectedVersion !== state.stateVersion) {
				const response = {
					ok: false,
					error: "Version mismatch.",
					stateVersion: state.stateVersion,
				} satisfies MoveResponse;
				await this.storeIdempotency(
					body.moveId,
					{ status: 409, body: response },
					state.stateVersion,
				);
				return Response.json(response, { status: 409 });
			}

			const moveParse = MoveSchema.safeParse(body.move);
			if (!moveParse.success) {
				const forfeited = await this.forfeitMatch(
					state,
					agentId,
					"invalid_move_schema",
				);
				const response = {
					ok: false,
					error: "Invalid move schema.",
					stateVersion: forfeited.stateVersion,
					forfeited: true,
					matchStatus: "ended",
					winnerAgentId: forfeited.winnerAgentId ?? null,
					reason: "invalid_move_schema",
					reasonCode: "invalid_move_schema",
				} satisfies MoveResponse;
				await this.storeIdempotency(
					body.moveId,
					{ status: 400, body: response },
					forfeited.stateVersion,
				);
				return Response.json(response, { status: 400 });
			}

			if (!state.players.includes(agentId)) {
				const response = {
					ok: false,
					error: "Agent not part of match.",
				} satisfies MoveResponse;
				await this.storeIdempotency(
					body.moveId,
					{ status: 403, body: response },
					state.stateVersion,
				);
				return Response.json(response, { status: 403 });
			}

			const active = getActiveAgentId(state.game);
			if (!active || active !== agentId) {
				const response = {
					ok: false,
					error: "Not your turn.",
				} satisfies MoveResponse;
				await this.storeIdempotency(
					body.moveId,
					{ status: 409, body: response },
					state.stateVersion,
				);
				return Response.json(response, { status: 409 });
			}

			const result = applyMoveToState(state, moveParse.data);

			if (!result.ok) {
				const reasonCode =
					result.reason === "illegal_move" ? "illegal_move" : "invalid_move";
				const forfeited = await this.forfeitMatch(state, agentId, reasonCode);
				const response = {
					ok: false,
					error: result.error,
					stateVersion: forfeited.stateVersion,
					forfeited: true,
					matchStatus: "ended",
					winnerAgentId: forfeited.winnerAgentId ?? null,
					reason: reasonCode,
					reasonCode,
				} satisfies MoveResponse;
				await this.storeIdempotency(
					body.moveId,
					{ status: 400, body: response },
					forfeited.stateVersion,
				);
				return Response.json(response, { status: 400 });
			}

			let nextState = result.state;
			if (nextState.status !== "active") {
				await this.ctx.storage.deleteAlarm();
			} else if (
				nextState.game.turn !== state.game.turn ||
				nextState.game.activePlayer !== state.game.activePlayer
			) {
				const baseMs = Date.parse(nextState.updatedAt);
				const nowMs = Number.isFinite(baseMs) ? baseMs : Date.now();
				const timeoutMs = this.turnTimeoutMs();
				const expiresAtMs = nowMs + timeoutMs;
				nextState = { ...nextState, turnExpiresAtMs: expiresAtMs };
			}
			await this.ctx.storage.put("state", nextState);
			await this.scheduleNextAlarm(nextState);

			const response = { ok: true, state: nextState } satisfies MoveResponse;
			await this.storeIdempotency(
				body.moveId,
				{ status: 200, body: response },
				nextState.stateVersion,
			);

			if (nextState.status === "ended") {
				await this.finalizeMatch(nextState, "terminal");
			}

			const moveAppliedEventId = await this.recordEvent(
				nextState,
				"move_applied",
				{
					payloadVersion: 2,
					agentId,
					moveId: body.moveId,
					move: moveParse.data,
					stateVersion: nextState.stateVersion,
					engineEvents: result.engineEvents,
					ts: nextState.updatedAt,
				},
			);

			await this.broadcastState(nextState);
			{
				const matchId = this.matchId ?? this.ctx.id.name;
				if (matchId) {
					const liveWriters = [...this.spectators, ...this.allAgentWriters()];
					await this.broadcast(
						liveWriters,
						"engine_events",
						buildEngineEventsEvent({
							eventId: moveAppliedEventId,
							ts: nextState.updatedAt,
							matchId,
							stateVersion: nextState.stateVersion,
							agentId,
							moveId: body.moveId,
							move: moveParse.data,
							engineEvents: result.engineEvents,
						}),
					);
					const safeThought = sanitizePublicThought(body.publicThought);
					const player =
						getPlayerSideForAgent(nextState.game, agentId) ??
						getPlayerSideForAgent(state.game, agentId);
					if (safeThought && player) {
						const thoughtEventId = await this.recordEvent(
							nextState,
							"agent_thought",
							{
								payloadVersion: 1,
								player,
								agentId,
								moveId: body.moveId,
								stateVersion: nextState.stateVersion,
								text: safeThought,
								ts: nextState.updatedAt,
							},
						);
						const thoughtPayload = buildAgentThoughtEvent({
							eventId: thoughtEventId,
							ts: nextState.updatedAt,
							matchId,
							stateVersion: nextState.stateVersion,
							player,
							agentId,
							moveId: body.moveId,
							text: safeThought,
						});
						await this.broadcast(liveWriters, "agent_thought", thoughtPayload);
					}
				}
			}
			await this.broadcastYourTurn(nextState);
			if (nextState.status === "ended") {
				await this.recordEvent(nextState, "match_ended", {
					stateVersion: nextState.stateVersion,
					winnerAgentId: nextState.winnerAgentId ?? null,
					loserAgentId: nextState.loserAgentId ?? null,
					reason: "terminal",
				});
				await this.broadcastGameEnd(nextState, "terminal");
			}

			return Response.json(response);
		}

		if (request.method === "POST" && url.pathname === "/finish") {
			const body = await request.json().catch(() => null);
			if (!isFinishPayload(body)) {
				return Response.json(
					{
						ok: false,
						error: "Finish payload must be empty or include reason.",
					},
					{ status: 400 },
				);
			}

			const agentId = request.headers.get("x-agent-id");
			if (!agentId) {
				return Response.json(
					{ ok: false, error: "Agent id is required." },
					{ status: 400 },
				);
			}

			const state = await this.ctx.storage.get<MatchState>("state");
			if (!state) {
				return Response.json(
					{ ok: false, error: "Match not initialized." },
					{ status: 409 },
				);
			}

			const enforced = await this.maybeEnforceTurnTimeout(state);

			if (enforced.status === "ended") {
				const response: FinishResponse = { ok: true, state: enforced };
				return Response.json(response);
			}

			if (!enforced.players.includes(agentId)) {
				return Response.json(
					{ ok: false, error: "Agent not part of match." },
					{ status: 403 },
				);
			}

			const nextState = await this.forfeitMatch(enforced, agentId, "forfeit");

			const response: FinishResponse = { ok: true, state: nextState };
			return Response.json(response);
		}

		if (request.method === "GET" && url.pathname === "/state") {
			let state = await this.ctx.storage.get<MatchState>("state");
			if (state) {
				state = await this.maybeEnforceTurnTimeout(state);
			}
			return Response.json({ state: state ?? null });
		}

		if (request.method === "GET" && url.pathname === "/stream") {
			const agentId = request.headers.get("x-agent-id");
			if (!agentId) {
				return new Response("Agent id is required.", { status: 400 });
			}
			let state = await this.ctx.storage.get<MatchState>("state");
			if (state && !state.players.includes(agentId)) {
				return new Response("Agent not part of match.", { status: 403 });
			}
			if (state) {
				state = await this.maybeEnforceTurnTimeout(state);
			}

			const { readable, writer, close } = this.createStream();
			this.registerAgentStream(agentId, writer);
			let cleanedUp = false;
			let testTimeout: ReturnType<typeof setTimeout> | null = null;
			const cleanup = () => {
				if (cleanedUp) return;
				cleanedUp = true;
				if (testTimeout !== null) {
					clearTimeout(testTimeout);
					testTimeout = null;
				}
				this.unregisterAgentStream(agentId, writer);
				void close();
			};
			if (this.env.TEST_MODE) {
				testTimeout = setTimeout(cleanup, TEST_STREAM_MAX_LIFETIME_MS);
			}
			this.handleAbort(request, cleanup);

			if (state) {
				const afterId = this.parseAfterId(request);
				void (async () => {
					const matchId = await this.resolveMatchId();
					if (!matchId) {
						cleanup();
						return;
					}
					const replayedTerminal =
						afterId > 0
							? await this.replayRecordedEvents(writer, matchId, afterId)
							: false;
					try {
						await this.sendEvent(
							writer,
							"state",
							buildLiveStateEvent({
								ts: state.updatedAt,
								matchId,
								stateVersion: state.stateVersion,
								state: state.game,
							}),
						);
					} catch {
						cleanup();
						return;
					}
					this.sendYourTurnIfActive(state, agentId, writer);
					if (state.status === "ended") {
						if (!replayedTerminal) {
							try {
								await this.sendEvent(
									writer,
									"match_ended",
									buildLiveMatchEndedEvent({
										ts: state.updatedAt,
										matchId,
										stateVersion: state.stateVersion,
										winnerAgentId: state.winnerAgentId ?? null,
										loserAgentId: state.loserAgentId ?? null,
										reason: state.endReason ?? "ended",
									}),
								);
							} catch {
								cleanup();
								return;
							}
						}
						cleanup();
					}
				})().catch(() => {
					cleanup();
				});
			}

			return this.streamResponse(readable, cleanup);
		}

		if (request.method === "GET" && url.pathname === "/spectate") {
			return this.handleSpectate(request);
		}

		return new Response("Not found", { status: 404 });
	}

	private createStream() {
		const stream = new TransformStream<Uint8Array, Uint8Array>();
		const writer = stream.writable.getWriter();
		return {
			readable: stream.readable,
			writer,
			close: async () => {
				try {
					await writer.close();
				} catch {
					// ignore
				}
			},
		};
	}

	private handleAbort(request: Request, onAbort: () => void) {
		if (request.signal.aborted) {
			onAbort();
			return;
		}
		request.signal.addEventListener("abort", onAbort, { once: true });
	}

	private streamResponse(
		readable: ReadableStream<Uint8Array>,
		onClose?: () => void,
	) {
		let settled = false;
		const settle = () => {
			if (settled) return;
			settled = true;
			onClose?.();
		};
		const reader = readable.getReader();
		const wrapped = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (done) {
						settle();
						controller.close();
						return;
					}
					if (value) controller.enqueue(value);
				} catch (error) {
					settle();
					controller.error(error);
				}
			},
			async cancel(reason) {
				try {
					await reader.cancel(reason);
				} catch {
					// ignore
				} finally {
					settle();
				}
			},
		});
		return new Response(wrapped, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	}

	private registerAgentStream(agentId: string, writer: StreamWriter) {
		const existing = this.agentStreams.get(agentId) ?? new Set<StreamWriter>();
		existing.add(writer);
		this.agentStreams.set(agentId, existing);
	}

	private unregisterAgentStream(agentId: string, writer: StreamWriter) {
		const set = this.agentStreams.get(agentId);
		if (!set) return;
		set.delete(writer);
		if (set.size === 0) this.agentStreams.delete(agentId);
	}

	private async sendEvent(writer: StreamWriter, event: string, data: unknown) {
		await this.sendEventWithTimeout(writer, event, data, SSE_WRITE_TIMEOUT_MS);
	}

	private parseAfterId(request: Request) {
		const raw = new URL(request.url).searchParams.get("afterId");
		const parsed = raw ? Number.parseInt(raw, 10) : 0;
		return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
	}

	private async getLatestRecordedEventId(matchId: string) {
		const row = await this.env.DB.prepare(
			"SELECT MAX(id) as id FROM match_events WHERE match_id = ?",
		)
			.bind(matchId)
			.first<{ id: number | null }>();
		return typeof row?.id === "number" ? row.id : 0;
	}

	private async replayRecordedEvents(
		writer: StreamWriter,
		matchId: string,
		afterId: number,
	) {
		if (afterId <= 0) return false;
		const { results } = await this.env.DB.prepare(
			[
				"SELECT id, match_id, ts, event_type, payload_json",
				"FROM match_events",
				"WHERE match_id = ? AND id > ?",
				"ORDER BY id ASC",
				"LIMIT 5000",
			].join(" "),
		)
			.bind(matchId, afterId)
			.all<{
				id: number;
				match_id: string;
				ts: string;
				event_type: string;
				payload_json: string;
			}>();
		let replayedTerminal = false;
		for (const row of results ?? []) {
			let payload: unknown = null;
			try {
				payload = JSON.parse(row.payload_json);
			} catch {
				payload = null;
			}
			const envelope = buildStoredMatchEventEnvelope({
				eventId: row.id,
				matchId: row.match_id,
				ts: row.ts,
				eventType: row.event_type,
				payload,
			});
			if (!envelope) continue;
			if (envelope.event === "match_ended") {
				replayedTerminal = true;
			}
			await this.sendEvent(writer, envelope.event, envelope);
		}
		return replayedTerminal;
	}

	private async broadcastState(state: MatchState) {
		const matchId = this.matchId ?? this.ctx.id.name;
		if (!matchId) return;
		await this.broadcast(
			[...this.spectators, ...this.allAgentWriters()],
			"state",
			buildLiveStateEvent({
				ts: state.updatedAt,
				matchId,
				stateVersion: state.stateVersion,
				state: state.game,
			}),
		);
	}

	private async broadcastYourTurn(state: MatchState) {
		if (state.status !== "active") return;
		const active = getActiveAgentId(state.game);
		if (!active) return;
		const writers = this.agentStreams.get(active);
		if (!writers) return;
		const matchId = this.matchId ?? this.ctx.id.name;
		if (!matchId) return;
		const payload = buildLiveYourTurnEvent({
			ts: state.updatedAt,
			matchId,
			stateVersion: state.stateVersion,
		});
		for (const writer of writers) {
			void this.sendEvent(writer, "your_turn", payload).catch(() => {
				writers.delete(writer);
			});
		}
	}

	private sendYourTurnIfActive(
		state: MatchState,
		agentId: string,
		writer: StreamWriter,
	) {
		if (state.status !== "active") return;
		const active = getActiveAgentId(state.game);
		if (!active || active !== agentId) return;
		const matchId = this.matchId ?? this.ctx.id.name;
		if (!matchId) return;
		void this.sendEvent(
			writer,
			"your_turn",
			buildLiveYourTurnEvent({
				ts: state.updatedAt,
				matchId,
				stateVersion: state.stateVersion,
			}),
		);
	}

	private async broadcastGameEnd(state: MatchState, reason: string) {
		const matchId = this.matchId ?? this.ctx.id.name;
		if (!matchId) return;
		const eventId = await this.getLatestRecordedEventId(matchId);
		const payload = buildMatchEndedEvent({
			eventId,
			ts: state.updatedAt,
			matchId,
			stateVersion: state.stateVersion,
			winnerAgentId: state.winnerAgentId ?? null,
			loserAgentId: state.loserAgentId ?? null,
			reason,
		});
		await this.broadcast(
			[...this.spectators, ...this.allAgentWriters()],
			"match_ended",
			payload,
		);
		await this.broadcast(
			[...this.spectators, ...this.allAgentWriters()],
			"game_ended",
			buildGameEndedAliasEvent(payload),
		);
	}

	private allAgentWriters(): StreamWriter[] {
		const writers: StreamWriter[] = [];
		for (const set of this.agentStreams.values()) {
			writers.push(...set);
		}
		return writers;
	}

	private async broadcast(
		writers: StreamWriter[],
		event: string,
		data: unknown,
	) {
		for (const writer of writers) {
			try {
				await this.sendEvent(writer, event, data);
			} catch {
				this.spectators.delete(writer);
				for (const [agentId, set] of this.agentStreams.entries()) {
					if (set.delete(writer) && set.size === 0) {
						this.agentStreams.delete(agentId);
					}
				}
			}
		}
	}

	private async sendEventWithTimeout(
		writer: StreamWriter,
		event: string,
		data: unknown,
		timeoutMs: number,
	) {
		const payload = formatSse(event, data);
		const write = writer.write(this.encoder.encode(payload));
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		const timeout = new Promise((_, reject) => {
			timeoutId = setTimeout(() => {
				const error = new Error("SSE write timeout");
				void writer.abort(error).catch(() => {
					// ignore abort races on already-closing streams
				});
				reject(error);
			}, timeoutMs);
		});
		try {
			await Promise.race([write, timeout]);
		} finally {
			if (timeoutId !== null) clearTimeout(timeoutId);
		}
	}

	private async storeIdempotency(
		moveId: string,
		entry: IdempotencyEntry,
		stateVersion?: number,
	) {
		const key = `${IDEMPOTENCY_PREFIX}${moveId}`;
		await this.ctx.storage.put(key, entry);
		const index =
			(await this.ctx.storage.get<{ moveId: string; stateVersion: number }[]>(
				IDEMPOTENCY_INDEX_KEY,
			)) ?? [];
		index.push({ moveId, stateVersion: stateVersion ?? -1 });

		if (index.length > IDEMPOTENCY_MAX) {
			const currentVersion = stateVersion ?? -1;
			const protectedMin = currentVersion >= 0 ? currentVersion - 1 : -1;
			const retained = index.filter(
				(item) => item.stateVersion >= protectedMin,
			);
			const trimmed =
				retained.length > IDEMPOTENCY_MAX
					? retained.slice(retained.length - IDEMPOTENCY_MAX)
					: retained;
			const keep = new Set(trimmed.map((item) => item.moveId));
			const evicted = index
				.filter((item) => !keep.has(item.moveId))
				.map((item) => `${IDEMPOTENCY_PREFIX}${item.moveId}`);

			if (evicted.length > 0) {
				await this.ctx.storage.delete(evicted);
			}
			await this.ctx.storage.put(IDEMPOTENCY_INDEX_KEY, trimmed);
			return;
		}

		await this.ctx.storage.put(IDEMPOTENCY_INDEX_KEY, index);
	}

	private async recordEvent(
		state: MatchState,
		eventType: string,
		payload: unknown,
	) {
		const matchId = await this.resolveMatchId();
		if (!matchId) return 0;
		try {
			if (eventType === "match_ended") {
				await this.env.DB.prepare(
					[
						"INSERT INTO match_events(match_id, turn, event_type, payload_json)",
						"SELECT ?, ?, ?, ?",
						"WHERE NOT EXISTS (",
						"SELECT 1 FROM match_events WHERE match_id = ? AND event_type = 'match_ended'",
						")",
					].join(" "),
				)
					.bind(
						matchId,
						state.game.turn,
						eventType,
						JSON.stringify(payload ?? null),
						matchId,
					)
					.run();
				return await this.getLatestRecordedEventId(matchId);
			}
			await this.env.DB.prepare(
				"INSERT INTO match_events(match_id, turn, event_type, payload_json) VALUES (?, ?, ?, ?)",
			)
				.bind(
					matchId,
					state.game.turn,
					eventType,
					JSON.stringify(payload ?? null),
				)
				.run();
			return await this.getLatestRecordedEventId(matchId);
		} catch (error) {
			console.error("Failed to record match event", error);
			return 0;
		}
	}

	private async forfeitMatch(
		state: MatchState,
		loserAgentId: string,
		reason: string,
	) {
		if (state.status === "ended") return state;
		await this.ctx.storage.deleteAlarm();
		const winnerAgentId = state.players.find(
			(player) => player !== loserAgentId,
		);
		const endedAt = new Date().toISOString();
		const nextState: MatchState = {
			...state,
			game: { ...state.game, status: "ended" },
			status: "ended",
			endedAt,
			updatedAt: endedAt,
			stateVersion: state.stateVersion + 1,
			winnerAgentId: winnerAgentId ?? undefined,
			loserAgentId,
			endReason: reason,
		};

		if (reason === "turn_timeout") {
			const matchId = await this.resolveMatchId();
			if (matchId) {
				emitMetric(this.env, "turn_timeout_forfeit", {
					scope: "match_do",
					requestId: crypto.randomUUID(),
					matchId,
					agentId: loserAgentId,
				});
			}
		}

		await this.ctx.storage.put("state", nextState);
		await this.recordEvent(nextState, "move_forfeit", {
			loserAgentId,
			winnerAgentId: winnerAgentId ?? null,
			reason,
			stateVersion: nextState.stateVersion,
		});
		await this.recordEvent(nextState, "match_ended", {
			stateVersion: nextState.stateVersion,
			winnerAgentId: winnerAgentId ?? null,
			loserAgentId,
			reason,
		});
		await this.broadcastState(nextState);
		await this.broadcastGameEnd(nextState, reason);
		await this.finalizeMatch(nextState, reason);
		return nextState;
	}

	private async persistFinalization(state: MatchState, reason: string) {
		const matchId = await this.resolveMatchId();
		if (!matchId) {
			console.warn("Match id unavailable for finalization");
			return;
		}

		// D1 `.run().changes` has been observed to be unreliable under some test runners.
		// Use an explicit existence check to ensure we don't double-apply leaderboard updates.
		const existingResult = await this.env.DB.prepare(
			"SELECT 1 as ok FROM match_results WHERE match_id = ?",
		)
			.bind(matchId)
			.first<{ ok: number }>();
		const isFirstFinalization = !existingResult?.ok;

		await this.env.DB.prepare(
			"INSERT OR IGNORE INTO match_results(match_id, winner_agent_id, loser_agent_id, reason) VALUES (?, ?, ?, ?)",
		)
			.bind(
				matchId,
				state.winnerAgentId ?? null,
				state.loserAgentId ?? null,
				reason,
			)
			.run();

		const updateMatch = this.env.DB.prepare(
			[
				"UPDATE matches",
				"SET status='ended', ended_at=?, winner_agent_id=?, end_reason=?, final_state_version=?",
				"WHERE id=? AND ended_at IS NULL",
			].join(" "),
		).bind(
			state.endedAt ?? null,
			state.winnerAgentId ?? null,
			reason,
			state.stateVersion,
			matchId,
		);

		// Always mark the match row ended, even if finalization is repeated.
		// This must only run once per finalization attempt (do not include it again in later batches).
		try {
			await this.env.DB.batch([updateMatch]);
		} catch (error) {
			console.error("Failed to update match row during finalization", error);
		}
		if (!isFirstFinalization) {
			await this.notifyFeaturedEnded(matchId);
			return;
		}

		if (state.mode !== "ranked") {
			await this.notifyFeaturedEnded(matchId);
			return;
		}

		if (!state.winnerAgentId || !state.loserAgentId) {
			await this.notifyFeaturedEnded(matchId);
			return;
		}

		try {
			await this.env.DB.batch([
				this.env.DB.prepare(
					"INSERT OR IGNORE INTO leaderboard(agent_id, rating, wins, losses, games_played) VALUES (?, ?, 0, 0, 0)",
				).bind(state.winnerAgentId, ELO_START),
				this.env.DB.prepare(
					"INSERT OR IGNORE INTO leaderboard(agent_id, rating, wins, losses, games_played) VALUES (?, ?, 0, 0, 0)",
				).bind(state.loserAgentId, ELO_START),
			]);
		} catch (error) {
			console.error("Failed to ensure leaderboard entries", error);
		}

		const winnerRow = await this.env.DB.prepare(
			"SELECT rating FROM leaderboard WHERE agent_id = ?",
		)
			.bind(state.winnerAgentId)
			.first<{ rating: number }>();

		const loserRow = await this.env.DB.prepare(
			"SELECT rating FROM leaderboard WHERE agent_id = ?",
		)
			.bind(state.loserAgentId)
			.first<{ rating: number }>();

		const winnerRating =
			typeof winnerRow?.rating === "number" ? winnerRow.rating : ELO_START;
		const loserRating =
			typeof loserRow?.rating === "number" ? loserRow.rating : ELO_START;

		const { winnerNext, loserNext } = calculateElo(winnerRating, loserRating);

		try {
			await this.env.DB.batch([
				this.env.DB.prepare(
					"UPDATE leaderboard SET rating=?, wins=wins+1, games_played=games_played+1, updated_at=datetime('now') WHERE agent_id=?",
				).bind(winnerNext, state.winnerAgentId),
				this.env.DB.prepare(
					"UPDATE leaderboard SET rating=?, losses=losses+1, games_played=games_played+1, updated_at=datetime('now') WHERE agent_id=?",
				).bind(loserNext, state.loserAgentId),
			]);
		} catch (error) {
			console.error("Failed to update leaderboard", error);
		}
		await this.notifyFeaturedEnded(matchId);
	}

	private async handleSpectate(request: Request) {
		let state = await this.ctx.storage.get<MatchState>("state");
		if (state) {
			state = await this.maybeEnforceTurnTimeout(state);
		}
		const { readable, writer, close } = this.createStream();
		this.spectators.add(writer);
		let cleanedUp = false;
		let testTimeout: ReturnType<typeof setTimeout> | null = null;
		const cleanup = () => {
			if (cleanedUp) return;
			cleanedUp = true;
			if (testTimeout !== null) {
				clearTimeout(testTimeout);
				testTimeout = null;
			}
			this.spectators.delete(writer);
			void close();
		};
		if (this.env.TEST_MODE) {
			testTimeout = setTimeout(cleanup, TEST_STREAM_MAX_LIFETIME_MS);
		}
		this.handleAbort(request, cleanup);

		if (state) {
			const afterId = this.parseAfterId(request);
			void (async () => {
				const matchId = await this.resolveMatchId();
				if (!matchId) {
					cleanup();
					return;
				}
				const replayedTerminal =
					afterId > 0
						? await this.replayRecordedEvents(writer, matchId, afterId)
						: false;
				await this.sendEvent(
					writer,
					"state",
					buildLiveStateEvent({
						ts: state.updatedAt,
						matchId,
						stateVersion: state.stateVersion,
						state: state.game,
					}),
				);
				if (state.status !== "ended" || replayedTerminal) return;
				const endedPayload = buildLiveMatchEndedEvent({
					ts: state.updatedAt,
					matchId,
					stateVersion: state.stateVersion,
					winnerAgentId: state.winnerAgentId ?? null,
					loserAgentId: state.loserAgentId ?? null,
					reason: state.endReason ?? "ended",
				});
				await this.sendEvent(writer, "match_ended", endedPayload);
				await this.sendEvent(
					writer,
					"game_ended",
					buildGameEndedAliasEvent(endedPayload),
				);
			})().catch(() => {
				cleanup();
			});
		}

		return this.streamResponse(readable, cleanup);
	}

	private async notifyFeaturedEnded(matchId: string) {
		const key = this.env.INTERNAL_RUNNER_KEY;
		if (!key) {
			console.warn("INTERNAL_RUNNER_KEY missing; featured rotation skipped");
			return;
		}

		try {
			const id = this.env.MATCHMAKER.idFromName("global");
			const stub = this.env.MATCHMAKER.get(id);
			await stub.fetch("https://do/featured/ended", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-runner-key": key,
					"x-runner-id": "match-do",
				},
				body: JSON.stringify({ matchId }),
			});
		} catch (error) {
			console.error("Failed to notify featured rotation", error);
		}
	}

	private async finalizeMatch(state: MatchState, reason: string) {
		// Emit match_ended metric with reason
		const matchId = await this.resolveMatchId();
		if (matchId) {
			emitMetric(this.env, "match_ended", {
				scope: "match_do",
				matchId,
				agentId: state.winnerAgentId,
			});
		}

		const task = this.persistFinalization(state, reason);
		if (this.env.TEST_MODE) {
			await task;
			return;
		}
		this.ctx.waitUntil(task);
	}

	private async resolveMatchId(): Promise<string | null> {
		if (this.matchId) return this.matchId;
		const stored = await this.ctx.storage.get<string>(MATCH_ID_KEY);
		if (stored) {
			this.matchId = stored;
			return stored;
		}
		return null;
	}

	private async resetForTest() {
		await this.ctx.storage.deleteAlarm();
		for (const writer of this.spectators) {
			try {
				await writer.close();
			} catch {
				// ignore
			}
		}
		this.spectators.clear();
		for (const [agentId, writers] of this.agentStreams.entries()) {
			for (const writer of writers) {
				try {
					await writer.close();
				} catch {
					// ignore
				}
			}
			this.agentStreams.delete(agentId);
		}
	}
}

const createInitialState = (
	players: string[],
	seed: number,
	mode: "ranked",
): MatchState => {
	const now = new Date().toISOString();
	return {
		stateVersion: 0,
		status: "active",
		updatedAt: now,
		createdAt: now,
		players,
		game: initialState(seed, players),
		lastMove: null,
		mode,
	};
};

const applyMoveToState = (state: MatchState, move: Move): MoveResult => {
	try {
		const applied = applyMove(state.game, move);
		if (!applied.ok) {
			return { ok: false, error: applied.error, reason: applied.reason };
		}
		const nextGame = applied.state;
		const now = new Date().toISOString();

		let nextState: MatchState = {
			...state,
			game: nextGame,
			lastMove: move,
			updatedAt: now,
			stateVersion: state.stateVersion + 1,
		};

		const terminal = isTerminal(nextGame);
		if (nextGame.status === "ended" || terminal.ended) {
			const winnerAgentId = winner(nextGame) ?? undefined;
			const loserAgentId = winnerAgentId
				? state.players.find((player) => player !== winnerAgentId)
				: undefined;

			nextState = {
				...nextState,
				status: "ended",
				endedAt: now,
				winnerAgentId,
				loserAgentId,
				endReason: "terminal",
			};
		}

		return { ok: true, state: nextState, engineEvents: applied.engineEvents };
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}
};

const getActiveAgentId = (game: GameState) => {
	const side = game.activePlayer;
	const player = game.players[side];
	return player?.id ?? null;
};

const getPlayerSideForAgent = (game: GameState, agentId: string) => {
	for (const side of ["A", "B"] as const) {
		if (game.players[side]?.id === agentId) return side;
	}
	return null;
};

const isMovePayload = (value: unknown): value is MovePayload => {
	if (!isRecord(value)) return false;
	const moveId = value.moveId;
	const expectedVersion = value.expectedVersion;
	const hasMove = Object.hasOwn(value, "move");
	return (
		typeof moveId === "string" &&
		moveId.length > 0 &&
		typeof expectedVersion === "number" &&
		Number.isInteger(expectedVersion) &&
		hasMove
	);
};

const isFinishPayload = (value: unknown): value is FinishPayload => {
	if (!isRecord(value)) return false;
	const reason = value.reason;
	return reason === undefined || reason === "forfeit";
};

const calculateElo = (winnerRating: number, loserRating: number) => {
	const expectedWinner = 1 / (1 + 10 ** ((loserRating - winnerRating) / 400));
	const expectedLoser = 1 / (1 + 10 ** ((winnerRating - loserRating) / 400));
	const winnerNext = Math.round(winnerRating + ELO_K * (1 - expectedWinner));
	const loserNext = Math.round(loserRating + ELO_K * (0 - expectedLoser));
	return { winnerNext, loserNext };
};
