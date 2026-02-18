import OpenAI from "openai";
import { getDiagnosticsCollector } from "../diagnostics/collector";
import { Engine } from "../engineAdapter";
import {
	createOpenRouterClient,
	isOpenRouterBaseUrl,
	OPENROUTER_DEFAULT_BASE_URL,
} from "../llm/openrouter";
import type { Bot, MatchState, Move } from "../types";
import {
	matchCommand,
	type ParsedCommand,
	parseCommandsWithReasoning,
} from "./commandParser";
import { encodeLegalMoves, encodeState } from "./stateEncoder";

const DEFAULT_LLM_TIMEOUT_MS = 35_000;
const DEFAULT_LLM_MAX_RETRIES = 3;
const DEFAULT_LLM_RETRY_BASE_MS = 1_000;
const DEFAULT_LLM_MAX_TOKENS = 320;
const LATE_MATCH_TURN = 60;
const VERY_LATE_MATCH_TURN = 90;
const MIN_SAFE_FORCED_ATTACK_SCORE = -8;

export type LoopState = {
	noAttackStreak: number;
	noProgressStreak: number;
	noRecruitStreak: number;
};

export interface LlmBotConfig {
	// e.g. "anthropic/claude-3.5-haiku", "openai/gpt-4o-mini"
	model: string;
	// Provider API key (OpenRouter, Anthropic, OpenAI, etc.)
	apiKey: string;
	// Defaults to OpenRouter.
	baseUrl?: string;
	// Optional OpenRouter metadata headers (recommended).
	openRouterReferer?: string;
	openRouterTitle?: string;
	// Strategy prompt from the human.
	systemPrompt?: string;
	// Default 0.3
	temperature?: number;
	// Number of concurrent requests per turn (first success wins).
	parallelCalls?: number;
	// Per-call timeout in ms.
	timeoutMs?: number;
	// Retry configuration.
	maxRetries?: number;
	retryBaseMs?: number;
	// Token budget for response.
	maxTokens?: number;
}

/**
 * Create a Bot backed by the configured LLM client that selects moves and manages per-match loop state.
 *
 * The returned Bot uses an OpenRouter or OpenAI client (based on config.baseUrl) to call into the LLM for turn selection,
 * maintains turn counters and streaks (no-attack, no-progress, no-recruit), and exposes:
 * - chooseMove: picks a random legal move using the provided RNG.
 * - chooseTurn / chooseTurnWithMeta: invoke the LLM to produce moves, update internal streaks and turn count, and track the previous seen state.
 *
 * @param id - Unique identifier for the bot instance
 * @param config - LLM configuration and runtime options; may include `delayMs` to pause before making a turn
 * @returns A Bot that implements chooseMove, chooseTurn, and chooseTurnWithMeta using the configured LLM client and internal loop-state tracking
 */
export function makeLlmBot(
	id: string,
	config: LlmBotConfig & { delayMs?: number },
): Bot {
	let client: OpenAI;

	if (isOpenRouterBaseUrl(config.baseUrl)) {
		client = createOpenRouterClient({
			apiKey: config.apiKey,
			baseUrl: config.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL,
			referer:
				config.openRouterReferer ??
				process.env.OPENROUTER_REFERRER ??
				undefined,
			title:
				config.openRouterTitle ?? process.env.OPENROUTER_TITLE ?? undefined,
		});
	} else {
		client = new OpenAI({
			apiKey: config.apiKey,
			baseURL: config.baseUrl,
		});
	}

	let turnCount = 0;
	let previousSeenState: MatchState | undefined;
	let noAttackStreak = 0;
	let noProgressStreak = 0;
	let noRecruitStreak = 0;

	return {
		id,
		name: `LlmBot_${config.model}`,
		chooseMove: ({ legalMoves, rng }) => {
			return legalMoves[Math.floor(rng() * legalMoves.length)] as Move;
		},
		chooseTurn: async (ctx) => {
			const result = await chooseTurnDetailed(
				client,
				id,
				config,
				ctx,
				turnCount,
				previousSeenState,
				{
					noAttackStreak,
					noProgressStreak,
					noRecruitStreak,
				},
			);
			noAttackStreak = result.hadAttack ? 0 : noAttackStreak + 1;
			noRecruitStreak = result.hadRecruit ? 0 : noRecruitStreak + 1;
			noProgressStreak = result.progressObserved ? 0 : noProgressStreak + 1;
			turnCount++;
			previousSeenState = structuredClone(ctx.state);
			return result.moves;
		},
		chooseTurnWithMeta: async (ctx) => {
			const result = await chooseTurnDetailed(
				client,
				id,
				config,
				ctx,
				turnCount,
				previousSeenState,
				{
					noAttackStreak,
					noProgressStreak,
					noRecruitStreak,
				},
			);
			noAttackStreak = result.hadAttack ? 0 : noAttackStreak + 1;
			noRecruitStreak = result.hadRecruit ? 0 : noRecruitStreak + 1;
			noProgressStreak = result.progressObserved ? 0 : noProgressStreak + 1;
			turnCount++;
			previousSeenState = structuredClone(ctx.state);
			return {
				moves: result.moves,
				prompt: result.prompt,
				rawOutput: result.rawOutput,
				model: config.model,
			};
		},
	};
}

/**
 * Generate a single turn for an LLM-driven bot by querying the model, parsing its output into commands, validating those commands against a simulated game state, and applying anti-loop and fallback policies.
 *
 * Builds a system + user prompt (full or short depending on turn cadence), issues one or more LLM calls with timeout and retry semantics, parses the response into up to five candidate commands, simulates and filters those commands for legality and terminal/turn boundaries, applies loop-pressure adjustments, and falls back to a safe move if no valid commands are produced. Records detailed diagnostics for the call.
 *
 * @param client - OpenAI-compatible client used to perform the chat completion request.
 * @param botId - The bot's player identifier present in `state`.
 * @param config - Bot configuration and LLM tuning options (e.g., systemPrompt, timeoutMs, parallelCalls, maxRetries, retryBaseMs, maxTokens, and optional delayMs).
 * @param ctx.state - Current match state to base decisions on.
 * @param ctx.legalMoves - Legal moves available at the start of this turn.
 * @param ctx.turn - Current turn number (for diagnostics and prompt selection).
 * @param ctx.rng - Random number generator used for fallback selection when needed.
 * @param turnCount - Number of turns the bot has taken so far (used to decide full vs. short system prompt cadence).
 * @param previousSeenState - Optional previously observed state used to compute deltas for tactical summaries and progress detection.
 * @param loopState - Optional loop-state counters that influence anti-loop policy hints and move adjustments.
 * @returns An object containing:
 *  - `moves`: The validated, possibly policy-adjusted sequence of moves to perform this turn.
 *  - `prompt`: The full system + user prompt sent to the LLM.
 *  - `rawOutput`: The raw text response returned by the LLM (empty string on API failure).
 *  - `hadAttack`: `true` if any returned move is an `attack` action, `false` otherwise.
 *  - `hadRecruit`: `true` if any returned move is a `recruit` action, `false` otherwise.
 *  - `progressObserved`: `true` if a measurable delta (units, HP, or VP) was observed relative to `previousSeenState`, `false` otherwise.
 */
async function chooseTurnDetailed(
	client: OpenAI,
	botId: string,
	config: LlmBotConfig & { delayMs?: number },
	ctx: {
		state: MatchState;
		legalMoves: Move[];
		turn: number;
		rng: () => number;
	},
	turnCount: number,
	previousSeenState?: MatchState,
	loopState?: LoopState,
): Promise<{
	moves: Move[];
	prompt: string;
	rawOutput: string;
	hadAttack: boolean;
	hadRecruit: boolean;
	progressObserved: boolean;
}> {
	const { state, legalMoves, turn } = ctx;

	if (config.delayMs && config.delayMs > 0) await sleep(config.delayMs);

	const side = inferSide(state, botId);

	// Build compact prompt
	const delta = previousSeenState
		? buildTurnDelta(previousSeenState, state, side)
		: undefined;
	const tacticalSummary = buildTacticalSummary(state, side, legalMoves);
	const policyHints = buildLoopPolicyHints(loopState, turn);
	const system =
		turnCount % 3 === 0
			? buildFullSystemPrompt(side, state, config.systemPrompt, policyHints)
			: buildShortSystemPrompt(side, config.systemPrompt, policyHints);
	const user = buildCompactUserMessage(
		state,
		side,
		legalMoves,
		tacticalSummary,
		delta,
	);
	const fullPrompt = `${system}\n\n${user}`;

	const startTime = Date.now();
	let apiError: string | undefined;
	let content = "";

	try {
		const timeoutMs = Math.max(
			1,
			config.timeoutMs ??
				parseEnvInt(process.env.SIM_LLM_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS),
		);
		const retryConfig = {
			maxRetries:
				config.maxRetries ??
				parseEnvInt(process.env.SIM_LLM_MAX_RETRIES, DEFAULT_LLM_MAX_RETRIES),
			baseDelayMs:
				config.retryBaseMs ??
				parseEnvInt(
					process.env.SIM_LLM_RETRY_BASE_MS,
					DEFAULT_LLM_RETRY_BASE_MS,
				),
		};
		const parallelCalls = Math.max(
			1,
			config.parallelCalls ??
				parseEnvInt(process.env.SIM_LLM_PARALLEL_CALLS, 1),
		);

		const requestOnce = () =>
			requestWithTimeout(client, config, system, user, timeoutMs);

		const completion =
			parallelCalls === 1
				? await withRetry(requestOnce, retryConfig)
				: await Promise.any(
						Array.from({ length: parallelCalls }, () =>
							withRetry(requestOnce, retryConfig),
						),
					);
		content = completion.choices?.[0]?.message?.content ?? "";
	} catch (e) {
		apiError = e instanceof Error ? e.message : String(e);
		getDiagnosticsCollector().logLlmCall({
			timestamp: new Date().toISOString(),
			botId,
			model: config.model,
			turn,
			apiLatencyMs: Date.now() - startTime,
			apiSuccess: false,
			parsingSuccess: false,
			usedRandomFallback: true,
			commandsReturned: 0,
			commandsMatched: 0,
			commandsSkipped: 0,
			responsePreview: "",
			apiError,
		});
		const fallback = pickFallbackMove(legalMoves, state, side);
		return {
			moves: [fallback],
			prompt: fullPrompt,
			rawOutput: "",
			hadAttack: false,
			hadRecruit: false,
			progressObserved: false,
		};
	}

	// Parse response
	const parsed = parseLlmResponse(content);

	// Match commands against a simulated evolving legal state so later
	// commands are checked after earlier actions are applied.
	const moves: Move[] = [];
	let simulatedState = state;
	let currentLegalMoves = legalMoves;

	for (const cmd of parsed.commands.slice(0, 5)) {
		const matched = matchCommand(cmd, currentLegalMoves);
		if (!matched) continue;

		const candidate =
			moves.length === 0 && parsed.reasoning
				? ({ ...matched, reasoning: parsed.reasoning } as Move)
				: matched;
		const applied = Engine.applyMove(simulatedState, candidate);
		if (!applied.ok) {
			continue;
		}
		moves.push(candidate);
		simulatedState = applied.state;

		if (Engine.isTerminal(simulatedState).ended) {
			break;
		}
		if (String(Engine.currentPlayer(simulatedState)) !== String(botId)) {
			break;
		}
		currentLegalMoves = Engine.listLegalMoves(simulatedState);
	}

	const antiLoopMoves = applyLoopPressurePolicy(moves, {
		state,
		side,
		legalMoves,
		turn,
		loopState,
	});
	moves.splice(0, moves.length, ...antiLoopMoves);

	// If no valid commands parsed, fall back to end_turn
	if (moves.length === 0) {
		moves.push(pickFallbackMove(legalMoves, state, side));
	}

	const deltaForProgress =
		previousSeenState != null
			? buildTurnDelta(previousSeenState, state, side)
			: undefined;
	const progressObserved =
		deltaForProgress != null
			? deltaForProgress.ownUnitDelta !== 0 ||
				deltaForProgress.enemyUnitDelta !== 0 ||
				deltaForProgress.ownHpDelta !== 0 ||
				deltaForProgress.enemyHpDelta !== 0 ||
				deltaForProgress.ownVpDelta !== 0 ||
				deltaForProgress.enemyVpDelta !== 0
			: false;

	const commandsMatched = moves.length;
	const commandsSkipped = parsed.commands.length - commandsMatched;
	const usedRandomFallback =
		moves.length === 1 &&
		moves[0]?.action === "end_turn" &&
		!parsed.commands.some((c) => c.action === "end_turn");

	getDiagnosticsCollector().logLlmCall({
		timestamp: new Date().toISOString(),
		botId,
		model: config.model,
		turn,
		apiLatencyMs: Date.now() - startTime,
		apiSuccess: true,
		parsingSuccess: parsed.commands.length > 0,
		usedRandomFallback,
		commandsReturned: parsed.commands.length,
		commandsMatched,
		commandsSkipped: commandsSkipped > 0 ? commandsSkipped : 0,
		responsePreview: content.slice(0, 200),
		reasoning: parsed.reasoning,
	});

	return {
		moves,
		prompt: fullPrompt,
		rawOutput: content,
		hadAttack: moves.some((move) => move.action === "attack"),
		hadRecruit: moves.some((move) => move.action === "recruit"),
		progressObserved,
	};
}

/**
 * Sends a chat completion request to the specified LLM and aborts the request if it exceeds the given timeout.
 *
 * @param timeoutMs - Maximum time in milliseconds to wait before aborting the request
 * @returns The chat completion response from the model
 * @throws Error when the request is aborted due to exceeding `timeoutMs` (error message: `API timeout after ${timeoutMs}ms`); other client errors are rethrown
 */
function requestWithTimeout(
	client: OpenAI,
	config: LlmBotConfig,
	system: string,
	user: string,
	timeoutMs: number,
) {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort();
	}, timeoutMs);

	return client.chat.completions
		.create(
			{
				model: config.model,
				temperature: config.temperature ?? 0.3,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				max_tokens: config.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
			},
			{ signal: controller.signal },
		)
		.catch((error) => {
			if (controller.signal.aborted) {
				throw new Error(`API timeout after ${timeoutMs}ms`);
			}
			throw error;
		})
		.finally(() => {
			clearTimeout(timeout);
		});
}

// ---------------------------------------------------------------------------
// System prompt builders
/**
 * Builds a comprehensive system prompt instructing the LLM how to play as the given player.
 *
 * The prompt defines the exact command syntax and execution rules, unit types and upgrades, combat mechanics, win conditions, the locations of both strongholds, the provided strategy guidance (or a default aggressive strategy), optional anti-loop policy hints, and strict output constraints including a maximum of five commands and requirement that output be commands-only with `end_turn` when actions remain.
 *
 * @param side - The bot's player side ("A" or "B")
 * @param state - Current match state (used to locate strongholds)
 * @param userStrategy - Optional one-line strategy to include in the prompt; if omitted a default aggressive strategy is used
 * @param policyHints - Optional lines of anti-loop guidance to append under "ANTI_LOOP_RULES"
 * @returns The assembled system prompt string to send as the system message to the LLM
 */

function buildFullSystemPrompt(
	side: "A" | "B",
	state: MatchState,
	userStrategy?: string,
	policyHints: string[] = [],
): string {
	const ownStrongholdHex = findStrongholdHex(state, side);
	const enemySide = side === "A" ? "B" : "A";
	const enemyStrongholdHex = findStrongholdHex(state, enemySide);

	const strategy =
		userStrategy?.trim() ||
		"Be aggressive. Prioritize attacks, then advance toward the enemy stronghold.";

	return [
		`You are Player ${side} in Fightclaw, a hex strategy game.`,
		"",
		"COMMAND FORMAT (one per line):",
		"  move <unitId> <hexId>       - Move unit/stack to hex",
		"  attack <unitId> <hexId>     - Attack target hex",
		"  recruit <unitType> <hexId>  - Recruit at your stronghold (infantry/cavalry/archer)",
		"  fortify <unitId>            - Fortify unit in place",
		"  upgrade <unitId>            - Upgrade a base unit (infantry->swordsman, cavalry->knight, archer->crossbow)",
		"  end_turn                    - End your turn",
		"IMPORTANT: commands execute in order and legality changes after each command.",
		"",
		"UNITS T1: infantry, cavalry, archer. T2 upgrades: infantry->swordsman, cavalry->knight, archer->crossbow.",
		"COMBAT: damage = max(1, ATK+1+stackBonus - DEF). Cavalry charge: +2 ATK if moved 2+ hexes.",
		"WIN: capture ANY enemy stronghold, eliminate all enemies, or highest VP at turn limit.",
		`Your stronghold: ${ownStrongholdHex}. Enemy stronghold: ${enemyStrongholdHex}.`,
		"",
		strategy,
		"",
		...(policyHints.length > 0
			? ["ANTI_LOOP_RULES:", ...policyHints.map((line) => `  - ${line}`), ""]
			: []),
		"Return at most 5 commands. Always include end_turn as the final command if actions remain.",
		"STRICT OUTPUT: commands only, one per line. No prose, no bullets, no numbering, no explanations, no separator.",
	].join("\n");
}

/**
 * Builds a concise system prompt that instructs the model to output only legal game commands for the specified player.
 *
 * @param side - The player side ("A" or "B") that the prompt should address
 * @param userStrategy - Optional one-line strategy to include; if omitted a default aggressive strategy is used
 * @param policyHints - Optional anti-loop guidance lines to include in the prompt
 * @returns A single-line short system prompt that enforces command-only output, sequential command execution, a strategy line, optional anti-loop hints, and a limit of up to five commands ending with `end_turn`
 */
function buildShortSystemPrompt(
	side: "A" | "B",
	userStrategy?: string,
	policyHints: string[] = [],
): string {
	const strategy =
		userStrategy?.trim() ||
		"Be aggressive. Prioritize attacks, then advance toward enemy stronghold.";
	return [
		`Player ${side} in Fightclaw.`,
		"Use only valid CLI commands from LEGAL_MOVES.",
		"Commands execute sequentially; legality changes after each command.",
		`Strategy: ${strategy}`,
		...(policyHints.length > 0 ? [`Anti-loop: ${policyHints.join(" ")}`] : []),
		"Return at most 5 commands and end with end_turn.",
		"STRICT OUTPUT: commands only, one per line. No prose, no bullets, no numbering, no explanations, no separator.",
	].join(" ");
}

/**
 * Produce guidance lines that discourage repetitive low-impact behavior and encourage attacks or objective advances.
 *
 * Provides hints derived from recent streak counters (`noAttackStreak`, `noProgressStreak`, `noRecruitStreak`) and the current turn to steer the agent away from stall/loop patterns and toward combat or advancing the objective.
 *
 * @param loopState - Optional counters tracking recent behavior: `noAttackStreak`, `noProgressStreak`, and `noRecruitStreak`.
 * @param turn - The current turn number; used to add stronger late-game guidance when appropriate.
 * @returns An array of short policy hint strings intended to be injected into system prompts to reduce looped or low-impact turns.
function buildLoopPolicyHints(loopState?: LoopState, turn = 0): string[] {
	const hints: string[] = [];
	const noAttack = loopState?.noAttackStreak ?? 0;
	const noProgress = loopState?.noProgressStreak ?? 0;
	const noRecruit = loopState?.noRecruitStreak ?? 0;

	hints.push(
		"If ATTACKS are listed in LEGAL_MOVES, include at least one attack before end_turn.",
	);
	hints.push(
		"Do not output recruit-only turns repeatedly; recruit only when it changes immediate tactical pressure.",
	);
	if (noAttack >= 2 || noProgress >= 2) {
		hints.push(
			"Stall risk is high: prioritize direct combat over repositioning this turn.",
		);
	}
	if (noProgress >= 3) {
		hints.push(
			"If no favorable attack exists, make at least one move that reduces distance to the enemy stronghold.",
		);
	}
	if (noRecruit >= 2) {
		hints.push(
			"Do not recruit again this turn unless there are no legal attacks and no advancing moves.",
		);
	}
	if (
		turn >= LATE_MATCH_TURN &&
		(noAttack >= 1 || noProgress >= 1 || noRecruit >= 1)
	) {
		hints.push(
			"Late game: avoid low-impact recruit/fortify cycles; choose attack or objective advance.",
		);
	}
	return hints;
}

// ---------------------------------------------------------------------------
// User message builder
/**
 * Builds a compact, machine-readable user message summarizing the current turn for the LLM.
 *
 * The message contains an encoded view of `state` from `side`'s perspective, an optional encoded
 * turn `delta`, a bulleted tactical summary (if any), and an encoded list of `legalMoves`, in that order.
 *
 * @param tacticalSummary - Short human-readable strategy hints or observations to include as bullet points.
 * @param delta - Optional turn delta describing recent state changes to include before the tactical summary.
 * @returns A single string ready to append to the system prompt and send to the LLM.

function buildCompactUserMessage(
	state: MatchState,
	side: "A" | "B",
	legalMoves: Move[],
	tacticalSummary: string[],
	delta?: TurnDelta,
): string {
	const stateBlock = encodeState(state, side);
	const movesBlock = encodeLegalMoves(legalMoves, state);
	const deltaBlock = delta ? encodeTurnDelta(delta) : "";
	const tacticalBlock =
		tacticalSummary.length > 0
			? `TACTICAL_SUMMARY:\n${tacticalSummary.map((line) => `  - ${line}`).join("\n")}\n`
			: "";
	return `${stateBlock}\n${deltaBlock}${tacticalBlock}${movesBlock}`;
}

type TurnDelta = {
	ownUnitDelta: number;
	enemyUnitDelta: number;
	ownHpDelta: number;
	enemyHpDelta: number;
	ownVpDelta: number;
	enemyVpDelta: number;
	ownResDelta: { gold: number; wood: number };
	enemyResDelta: { gold: number; wood: number };
};

/**
 * Computes the change in units, hit points, victory points, and resources between two match states for a given side.
 *
 * @param prev - The previous match state to compare from
 * @param current - The current match state to compare to
 * @param side - The side to compute deltas for ("A" or "B"); deltas for the opposing side are included as `enemy*` fields
 * @returns An object with the following deltas:
 *  - `ownUnitDelta`: change in number of units for `side`
 *  - `enemyUnitDelta`: change in number of units for the opposing side
 *  - `ownHpDelta`: change in total HP across all units for `side`
 *  - `enemyHpDelta`: change in total HP across all enemy units
 *  - `ownVpDelta`: change in victory points for `side`
 *  - `enemyVpDelta`: change in victory points for the opposing side
 *  - `ownResDelta`: object with `gold` and `wood` changes for `side`
 *  - `enemyResDelta`: object with `gold` and `wood` changes for the opposing side
 */
function buildTurnDelta(
	prev: MatchState,
	current: MatchState,
	side: "A" | "B",
): TurnDelta {
	const enemySide = side === "A" ? "B" : "A";
	const prevOwn = prev.players[side];
	const prevEnemy = prev.players[enemySide];
	const curOwn = current.players[side];
	const curEnemy = current.players[enemySide];
	const sumHp = (units: { hp: number }[]) =>
		units.reduce((s, u) => s + u.hp, 0);
	return {
		ownUnitDelta: curOwn.units.length - prevOwn.units.length,
		enemyUnitDelta: curEnemy.units.length - prevEnemy.units.length,
		ownHpDelta: sumHp(curOwn.units) - sumHp(prevOwn.units),
		enemyHpDelta: sumHp(curEnemy.units) - sumHp(prevEnemy.units),
		ownVpDelta: curOwn.vp - prevOwn.vp,
		enemyVpDelta: curEnemy.vp - prevEnemy.vp,
		ownResDelta: {
			gold: curOwn.gold - prevOwn.gold,
			wood: curOwn.wood - prevOwn.wood,
		},
		enemyResDelta: {
			gold: curEnemy.gold - prevEnemy.gold,
			wood: curEnemy.wood - prevEnemy.wood,
		},
	};
}

/**
 * Create a compact multi-line summary of changes in units, HP, victory points, and resources since the bot's last turn.
 *
 * @param delta - Object describing numeric deltas for own and enemy units, HP, victory points, and resources
 * @returns A formatted `TURN_DELTA_SINCE_YOUR_LAST_TURN` block with `+` prefixed positive values and plain numbers for zero or negative values
 */
function encodeTurnDelta(delta: TurnDelta): string {
	const line = (n: number) => (n > 0 ? `+${n}` : `${n}`);
	return [
		"TURN_DELTA_SINCE_YOUR_LAST_TURN:",
		`  own_units=${line(delta.ownUnitDelta)} own_hp=${line(delta.ownHpDelta)} own_vp=${line(delta.ownVpDelta)} own_gold=${line(delta.ownResDelta.gold)} own_wood=${line(delta.ownResDelta.wood)}`,
		`  enemy_units=${line(delta.enemyUnitDelta)} enemy_hp=${line(delta.enemyHpDelta)} enemy_vp=${line(delta.enemyVpDelta)} enemy_gold=${line(delta.enemyResDelta.gold)} enemy_wood=${line(delta.enemyResDelta.wood)}`,
		"",
	].join("\n");
}

/**
 * Builds a concise tactical summary highlighting high-value attack opportunities and fragile units.
 *
 * Produces up to three prioritized "high-value attack" lines (scored by target HP and finisher potential),
 * and optionally adds lines for enemy units in kill range and friendly units with low HP.
 *
 * @param state - The current match state
 * @param side - The focal player side (`"A"` or `"B"`)
 * @param legalMoves - The set of legal moves available to the focal side
 * @returns An array of human-readable summary lines (e.g., recommended attacks, enemies in kill range, fragile allies)
 */
function buildTacticalSummary(
	state: MatchState,
	side: "A" | "B",
	legalMoves: Move[],
): string[] {
	const enemySide = side === "A" ? "B" : "A";
	const enemies = state.players[enemySide].units;
	const byPos = new Map(enemies.map((u) => [u.position, u]));
	const attacks = legalMoves.filter(
		(m): m is Extract<Move, { action: "attack" }> => m.action === "attack",
	);
	const ranked = attacks
		.map((m) => {
			const target = byPos.get(m.target);
			const finisher = target ? (target.hp <= 1 ? 30 : 0) : 0;
			const score = (target ? 10 - target.hp : 0) + finisher;
			const targetLabel = target
				? `${target.id}(${target.type} hp=${target.hp}/${target.maxHp})`
				: m.target;
			return {
				score,
				text: `high-value attack: attack ${m.unitId} ${m.target} -> ${targetLabel}`,
			};
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, 3)
		.map((r) => r.text);

	const lowHpThreats = enemies
		.filter((u) => u.hp <= 1)
		.slice(0, 3)
		.map((u) => `${u.id}@${u.position} hp=${u.hp}/${u.maxHp}`);
	if (lowHpThreats.length > 0) {
		ranked.push(`enemy units in kill range: ${lowHpThreats.join(", ")}`);
	}
	const ownLowHp = state.players[side].units
		.filter((u) => u.hp <= 1)
		.slice(0, 3)
		.map((u) => `${u.id}@${u.position} hp=${u.hp}/${u.maxHp}`);
	if (ownLowHp.length > 0) {
		ranked.push(`protect fragile units: ${ownLowHp.join(", ")}`);
	}
	return ranked;
}

/**
 * Selects a sensible fallback move from the available legal moves when no higher-priority decision is provided.
 *
 * Prefers actions in this order (when applicable): a scored best attack, any attack, an objective-advancing move, a plain move, recruiting infantry, recruiting any unit, fortify, upgrade, end_turn. If no legal move matches, returns an `end_turn` action.
 *
 * @param legalMoves - The list of legal moves to choose from.
 * @param state - Optional current match state used to score attacks and objective-advancing moves.
 * @param side - Optional side (`"A"` or `"B"`) of the bot used for scoring decisions.
 * @returns The selected fallback `Move`, or an `end_turn` move when no other option is applicable.
 */
function pickFallbackMove(
	legalMoves: Move[],
	state?: MatchState,
	side?: "A" | "B",
): Move {
	const attacks = legalMoves.filter(
		(move): move is Extract<Move, { action: "attack" }> =>
			move.action === "attack",
	);
	if (attacks.length > 0 && state && side) {
		const scored = pickBestAttackWithScore(attacks, state, side);
		if (scored) return scored.move;
	}
	if (attacks.length > 0) return attacks[0] as Move;

	if (state && side) {
		const bestAdvance = pickBestObjectiveAdvanceMove(legalMoves, state, side);
		if (bestAdvance) return bestAdvance;
	}
	const firstMove = legalMoves.find((move) => move.action === "move");
	if (firstMove) return firstMove;

	const recruitInfantry = legalMoves.find(
		(move): move is Extract<Move, { action: "recruit" }> =>
			move.action === "recruit" && move.unitType === "infantry",
	);
	if (recruitInfantry) return recruitInfantry;
	const recruitAny = legalMoves.find((move) => move.action === "recruit");
	if (recruitAny) return recruitAny;

	const fortify = legalMoves.find((move) => move.action === "fortify");
	if (fortify) return fortify;
	const upgrade = legalMoves.find((move) => move.action === "upgrade");
	if (upgrade) return upgrade;
	const endTurn = legalMoves.find((move) => move.action === "end_turn");
	if (endTurn) return endTurn;
	return { action: "end_turn" };
}

/**
 * Adjusts a proposed move sequence to break looping behaviour by preferring combat or objective advances when loop metrics indicate stagnation.
 *
 * Evaluates loop-related counters, turn stage, and available legal actions; may replace the original `moves` with a single forced attack followed by `end_turn`, or an objective-advancing move followed by `end_turn`, when doing so is judged beneficial for progress. If no policy-driven replacement is warranted, returns the original `moves`.
 *
 * @param moves - The bot's proposed sequence of moves for the turn.
 * @param opts.state - Current match state used to evaluate move impact.
 * @param opts.side - The bot's side, either `"A"` or `"B"`.
 * @param opts.legalMoves - All legal moves available this turn.
 * @param opts.turn - Current turn number.
 * @param opts.loopState - Optional loop metrics (no-attack, no-progress, no-recruit streaks) used to compute loop pressure.
 * @returns A move sequence to execute: either the original `moves`, or a policy-enforced sequence (attack or objective advance followed by `end_turn`) intended to break loops and encourage progress.
 */
export function applyLoopPressurePolicy(
	moves: Move[],
	opts: {
		state: MatchState;
		side: "A" | "B";
		legalMoves: Move[];
		turn: number;
		loopState?: LoopState;
	},
): Move[] {
	const { state, side, legalMoves, turn, loopState } = opts;
	const legalAttacks = legalMoves.filter(
		(move): move is Extract<Move, { action: "attack" }> =>
			move.action === "attack",
	);

	if (moves.some((move) => move.action === "attack")) {
		return moves;
	}

	const noAttack = loopState?.noAttackStreak ?? 0;
	const noProgress = loopState?.noProgressStreak ?? 0;
	const noRecruit = loopState?.noRecruitStreak ?? 0;
	const lateGame = turn >= LATE_MATCH_TURN;
	const pressure = computeLoopPressure(loopState, turn);
	const hasRecruit = moves.some((move) => move.action === "recruit");
	const lowImpactLoopTurn = isLowImpactLoopTurn(moves, state, side);
	const shouldPreferCombat =
		noAttack >= 2 ||
		noProgress >= 2 ||
		(lateGame && (noAttack >= 1 || noProgress >= 1));
	const shouldBlockRecruitLoop =
		noRecruit >= 2 ||
		noProgress >= 3 ||
		(lateGame && noRecruit >= 1 && noAttack >= 1);
	const desperateMode =
		pressure >= 6 || noProgress >= 5 || turn >= VERY_LATE_MATCH_TURN + 20;

	const bestAttack =
		legalAttacks.length > 0
			? pickBestAttackWithScore(legalAttacks, state, side)
			: undefined;
	const canForceAttack =
		bestAttack != null &&
		(bestAttack.score >= MIN_SAFE_FORCED_ATTACK_SCORE || desperateMode);

	if (
		canForceAttack &&
		(shouldPreferCombat ||
			(shouldBlockRecruitLoop && hasRecruit) ||
			(lowImpactLoopTurn && pressure >= 2))
	) {
		return [bestAttack.move, { action: "end_turn" }];
	}

	const bestAdvance = pickBestObjectiveAdvanceMove(legalMoves, state, side);
	if (
		bestAdvance &&
		(shouldBlockRecruitLoop || (lowImpactLoopTurn && pressure >= 2))
	) {
		return [bestAdvance, { action: "end_turn" }];
	}

	return moves;
}

/**
 * Compute a numeric "loop pressure" score that increases when the bot has recently
 * avoided attacking, making progress, or recruiting, and as the game enters late turns.
 *
 * @param loopState - Optional streak counters tracking recent behavior (`noAttackStreak`, `noProgressStreak`, `noRecruitStreak`)
 * @param turn - Current turn number
 * @returns A non-negative integer pressure score; higher values indicate stronger pressure to choose attack/progress/recruiting moves.
 *          Pressure is increased by:
 *          - `noAttackStreak` (>=2 and >=4 thresholds)
 *          - `noProgressStreak` (>=2 and >=4 thresholds)
 *          - `noRecruitStreak` (>=3 threshold)
 *          - late-game turn thresholds (`LATE_MATCH_TURN`, `VERY_LATE_MATCH_TURN`)
 *          - an additional increment when in late game and there has been at least one recent no-attack or no-progress streak
 */
function computeLoopPressure(
	loopState: LoopState | undefined,
	turn: number,
): number {
	const noAttack = loopState?.noAttackStreak ?? 0;
	const noProgress = loopState?.noProgressStreak ?? 0;
	const noRecruit = loopState?.noRecruitStreak ?? 0;
	let pressure = 0;

	if (noAttack >= 2) pressure += 2;
	if (noAttack >= 4) pressure += 1;
	if (noProgress >= 2) pressure += 2;
	if (noProgress >= 4) pressure += 2;
	if (noRecruit >= 3) pressure += 1;
	if (turn >= LATE_MATCH_TURN) pressure += 1;
	if (turn >= VERY_LATE_MATCH_TURN) pressure += 1;
	if (turn >= LATE_MATCH_TURN && (noAttack >= 1 || noProgress >= 1)) {
		pressure += 1;
	}

	return pressure;
}

/**
 * Determine whether a sequence of moves is "low-impact" for loop-detection purposes.
 *
 * A low-impact turn contains at least one non-end_turn action but no attacks and no moves that
 * advance toward the enemy stronghold. Recruit and fortify actions count as low-impact.
 *
 * @param moves - Proposed moves for the turn
 * @param state - Current match state used to evaluate objective-advancing moves
 * @param side - The acting side ("A" or "B")
 * @returns `true` if the sequence has at least one non-end_turn action and contains no attacks or objective-advancing moves, `false` otherwise.
 */
function isLowImpactLoopTurn(
	moves: Move[],
	state: MatchState,
	side: "A" | "B",
): boolean {
	let sawNonEndTurn = false;
	for (const move of moves) {
		if (move.action === "end_turn") continue;
		sawNonEndTurn = true;
		if (move.action === "attack") return false;
		if (move.action === "move") {
			if (scoreObjectiveAdvanceMove(move, state, side) > 0) {
				return false;
			}
			continue;
		}
		if (move.action === "recruit" || move.action === "fortify") {
			continue;
		}
		return false;
	}
	return sawNonEndTurn;
}

/**
 * Selects the legal move that best advances toward the enemy stronghold.
 *
 * @param legalMoves - The list of legal moves to evaluate.
 * @param state - The current match state used to score moves.
 * @param side - The bot's side, either `"A"` or `"B"`.
 * @returns The highest-scoring `move` action that advances the objective, or `undefined` if no move actions are available.
 */
function pickBestObjectiveAdvanceMove(
	legalMoves: Move[],
	state: MatchState,
	side: "A" | "B",
): Extract<Move, { action: "move" }> | undefined {
	let bestMove: Extract<Move, { action: "move" }> | undefined;
	let bestScore = 0;

	for (const move of legalMoves) {
		if (move.action !== "move") continue;
		const score = scoreObjectiveAdvanceMove(move, state, side);
		if (score > bestScore) {
			bestMove = move;
			bestScore = score;
		}
	}

	return bestMove;
}

/**
 * Scores how much a unit move advances objective progress toward the enemy stronghold.
 *
 * The score combines distance reduction toward the enemy stronghold, enemy control pressure
 * on the destination, terrain/objective bonuses (crowns, gold mines, lumber camps), and a
 * large bonus for capturing the enemy stronghold.
 *
 * @param move - A move action for a unit (destination hex id in `move.to`)
 * @param state - The current match state
 * @param side - The acting side, either `"A"` or `"B"`
 * @returns A numeric desirability score for the move; larger is better. Returns `Number.NEGATIVE_INFINITY` for invalid moves (missing unit or unreachable hexs). 
 */
function scoreObjectiveAdvanceMove(
	move: Extract<Move, { action: "move" }>,
	state: MatchState,
	side: "A" | "B",
): number {
	const enemySide = side === "A" ? "B" : "A";
	const enemyStrongholdHex = findStrongholdHex(state, enemySide);
	const ownById = new Map(
		state.players[side].units.map((unit) => [unit.id, unit]),
	);
	const attacker = ownById.get(move.unitId);
	if (!attacker) return Number.NEGATIVE_INFINITY;

	const startDist = hexDistance(attacker.position, enemyStrongholdHex);
	const endDist = hexDistance(move.to, enemyStrongholdHex);
	if (!Number.isFinite(startDist) || !Number.isFinite(endDist)) {
		return Number.NEGATIVE_INFINITY;
	}

	const byHex = new Map(state.board.map((hex) => [hex.id, hex]));
	const destination = byHex.get(move.to);
	const towardStronghold = (startDist - endDist) * 6;
	const enemyControlPressure = destination?.controlledBy === enemySide ? 4 : 0;
	const objectiveTerrainBonus =
		destination?.type === "crown"
			? 6
			: destination?.type === "gold_mine" || destination?.type === "lumber_camp"
				? 2
				: 0;
	const strongholdCaptureBonus = move.to === enemyStrongholdHex ? 45 : 0;

	return (
		towardStronghold +
		enemyControlPressure +
		objectiveTerrainBonus +
		strongholdCaptureBonus
	);
}

/**
 * Selects the highest-scoring attack move from a list.
 *
 * @param attacks - Candidate attack moves to evaluate
 * @param state - Current match state used to score each attack
 * @param side - The evaluating player's side ("A" or "B")
 * @returns The attack move with the highest score and that score, or `undefined` if `attacks` is empty
 */
function pickBestAttackWithScore(
	attacks: Extract<Move, { action: "attack" }>[],
	state: MatchState,
	side: "A" | "B",
): { move: Extract<Move, { action: "attack" }>; score: number } | undefined {
	let best:
		| { move: Extract<Move, { action: "attack" }>; score: number }
		| undefined;

	for (const attack of attacks) {
		const score = scoreAttackMove(attack, state, side);
		if (!best || score > best.score) {
			best = { move: attack, score };
		}
	}

	return best;
}

/**
 * Scores a candidate attack move for the given side in the current match state.
 *
 * The score is a heuristic where higher values indicate more desirable attacks. Factors include:
 * finishers (kills), damage inflicted to already-damaged units, number of targets hit (stacking),
 * objective capture bonus for hitting the enemy stronghold, control bonus for attacking a hex controlled
 * by the enemy, and penalties for fortified targets, low attacker HP, risky stacked exchanges, and
 * attacking only fresh (full‑HP) targets.
 *
 * @param attack - The attack move to evaluate (must have `action: "attack"` and a `target` hex)
 * @param state - The current match state used to evaluate targets, hex types, and control
 * @param side - The side performing the attack, either `"A"` or `"B"`
 * @returns A numeric heuristic score; higher scores indicate better attack choices
 */
function scoreAttackMove(
	attack: Extract<Move, { action: "attack" }>,
	state: MatchState,
	side: "A" | "B",
): number {
	const enemySide = side === "A" ? "B" : "A";
	const ownById = new Map(
		state.players[side].units.map((unit) => [unit.id, unit]),
	);
	const enemies = state.players[enemySide].units;
	const targets = enemies.filter((enemy) => enemy.position === attack.target);
	const attacker = ownById.get(attack.unitId);
	const targetHex = state.board.find((hex) => hex.id === attack.target);
	const enemyStrongholdType = side === "A" ? "stronghold_b" : "stronghold_a";

	const finishers = targets.filter((target) => target.hp <= 1).length;
	const damaged = targets.filter((target) => target.hp < target.maxHp).length;
	const fortifiedCount = targets.filter((target) => target.isFortified).length;
	const attackerLowHpPenalty = attacker
		? attacker.hp <= 1
			? 14
			: attacker.hp === 2
				? 6
				: 0
		: 0;
	const stackRiskPenalty =
		targets.length >= 2 && (attacker?.hp ?? 3) <= 2 ? 12 : 0;
	const freshTargetPenalty =
		targets.length > 0 && targets.every((target) => target.hp === target.maxHp)
			? 4
			: 0;
	const objectiveBonus = targetHex?.type === enemyStrongholdType ? 28 : 0;
	const controlBonus = targetHex?.controlledBy === enemySide ? 4 : 0;

	return (
		finishers * 36 +
		damaged * 12 +
		targets.length * 6 +
		objectiveBonus +
		controlBonus -
		fortifiedCount * 8 -
		attackerLowHpPenalty -
		stackRiskPenalty -
		freshTargetPenalty
	);
}

/**
 * Parse a hex identifier (e.g., "A12") into zero-based row and column indices.
 *
 * @param hexId - Hex identifier consisting of a single letter followed by one or more digits (example: "A1", "c10")
 * @returns An object with zero-based `row` and `col` when `hexId` is valid, or `undefined` if the input is malformed or out of range
 */
function parseHexId(hexId: string): { row: number; col: number } | undefined {
	const match = /^([A-Za-z])(\d+)$/.exec(hexId);
	if (!match) return undefined;
	const row = match[1]!.toUpperCase().charCodeAt(0) - 65;
	const col = Number.parseInt(match[2] ?? "", 10) - 1;
	if (!Number.isFinite(col) || col < 0 || row < 0) return undefined;
	return { row, col };
}

/**
 * Compute the minimum number of steps between two hex cells on the game grid.
 *
 * @param fromHex - Source hex identifier (e.g., "A12")
 * @param toHex - Destination hex identifier (e.g., "B7")
 * @returns The hex distance (minimum number of moves) between the two hexes, or `Number.POSITIVE_INFINITY` if either identifier is invalid.
 */
function hexDistance(fromHex: string, toHex: string): number {
	const from = parseHexId(fromHex);
	const to = parseHexId(toHex);
	if (!from || !to) return Number.POSITIVE_INFINITY;

	const fromQ = from.col - Math.floor((from.row - (from.row & 1)) / 2);
	const fromR = from.row;
	const fromS = -fromQ - fromR;
	const toQ = to.col - Math.floor((to.row - (to.row & 1)) / 2);
	const toR = to.row;
	const toS = -toQ - toR;

	return Math.max(
		Math.abs(fromQ - toQ),
		Math.abs(fromR - toR),
		Math.abs(fromS - toS),
	);
}

// ---------------------------------------------------------------------------
// Response parsing (exported for testing)
/**
 * Parses raw LLM output into structured commands and optional reasoning.
 *
 * @param text - The raw text returned by the language model
 * @returns An object with `commands`, an array of parsed commands, and `reasoning`, the optional textual justification or rationale extracted from the output
 */

export function parseLlmResponse(text: string): {
	commands: ParsedCommand[];
	reasoning: string | undefined;
} {
	return parseCommandsWithReasoning(text);
}

// ---------------------------------------------------------------------------
// Utilities
/**
 * Determine which player side corresponds to the given bot identifier.
 *
 * @param state - The current match state containing player information
 * @param botId - The bot identifier to look up
 * @returns `'A'` if `botId` matches player A, `'B'` otherwise
 */

function inferSide(state: MatchState, botId: string): "A" | "B" {
	return state.players.A.id === botId ? "A" : "B";
}

/**
 * Locate the hex ID of the specified player's stronghold on the board.
 *
 * @param state - Current match state containing the board hexes
 * @param side - Player side, either `"A"` or `"B"`
 * @returns The hex `id` where the side's stronghold is located, or `"unknown"` if not present
 */
function findStrongholdHex(state: MatchState, side: "A" | "B"): string {
	const target = side === "A" ? "stronghold_a" : "stronghold_b";
	const hex = state.board.find((h) => h.type === target);
	return hex?.id ?? "unknown";
}

/**
 * Pauses execution for the specified duration.
 *
 * @param ms - Delay duration in milliseconds
 * @returns Nothing.
 */
function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retries an asynchronous operation with exponential backoff and jitter until it succeeds, a non-retryable error occurs, or the retry limit is reached.
 *
 * @param fn - The operation to execute; invoked repeatedly until it resolves or fails permanently.
 * @param opts.maxRetries - Maximum number of retry attempts after the initial call (0 means no retries).
 * @param opts.baseDelayMs - Base delay in milliseconds used to compute exponential backoff with jitter between attempts.
 * @returns The resolved value from `fn`.
 * @throws The last error thrown by `fn` when a non-retryable error is encountered or when the retry limit is exhausted.
 */
async function withRetry<T>(
	fn: () => Promise<T>,
	opts: { maxRetries: number; baseDelayMs: number },
): Promise<T> {
	let attempt = 0;
	let lastErr: unknown;
	while (attempt <= opts.maxRetries) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (!isRetryableError(err) || attempt === opts.maxRetries) {
				throw err;
			}
			const delayMs = computeBackoffWithJitter(opts.baseDelayMs, attempt);
			await sleep(delayMs);
			attempt++;
		}
	}
	throw lastErr;
}

/**
 * Determine whether an error should be treated as retryable based on HTTP status codes or common network/timeout messages.
 *
 * @returns `true` if the error has a retryable HTTP status (429, 500, 502, 503) or its message contains indicators like "timeout", "timed out", "econnreset", "fetch failed", or "network", `false` otherwise.
 */
function isRetryableError(err: unknown): boolean {
	const status =
		(err as { status?: number; statusCode?: number } | null)?.status ??
		(err as { status?: number; statusCode?: number } | null)?.statusCode;
	if (status === 429 || status === 500 || status === 502 || status === 503) {
		return true;
	}
	const msg = String(
		(err as { message?: string } | null)?.message ?? err,
	).toLowerCase();
	return (
		msg.includes("timeout") ||
		msg.includes("timed out") ||
		msg.includes("econnreset") ||
		msg.includes("fetch failed") ||
		msg.includes("network")
	);
}

/**
 * Calculate an exponential backoff delay in milliseconds and add randomized jitter.
 *
 * @param baseDelayMs - Base delay in milliseconds used as the backoff unit
 * @param attempt - Retry attempt index (zero-based) used to determine the exponential multiplier
 * @returns The computed delay in milliseconds: baseDelayMs multiplied by 2^exp plus a random jitter
 */
function computeBackoffWithJitter(
	baseDelayMs: number,
	attempt: number,
): number {
	const exp = Math.min(attempt, 6);
	const jitter = Math.floor(Math.random() * Math.max(100, baseDelayMs));
	return baseDelayMs * 2 ** exp + jitter;
}

/**
 * Parse an environment-provided string into a positive integer, using a default when invalid.
 *
 * @param value - The string to parse (typically from an environment variable)
 * @param fallback - The value to return if `value` is undefined, not an integer, or not greater than zero
 * @returns The parsed integer when greater than zero, otherwise `fallback`
 */
function parseEnvInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}