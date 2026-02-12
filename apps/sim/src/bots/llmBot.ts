import { renderAscii } from "@fightclaw/engine";
import OpenAI from "openai";
import {
	createOpenRouterClient,
	isOpenRouterBaseUrl,
	OPENROUTER_DEFAULT_BASE_URL,
} from "../llm/openrouter";
import { pickOne } from "../rng";
import type { Bot, MatchState, Move } from "../types";

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
}

export function makeLlmBot(
	id: string,
	config: LlmBotConfig & { delayMs?: number },
): Bot {
	const client = isOpenRouterBaseUrl(config.baseUrl)
		? createOpenRouterClient({
				apiKey: config.apiKey,
				baseUrl: config.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL,
				referer:
					config.openRouterReferer ??
					process.env.OPENROUTER_REFERRER ??
					undefined,
				title:
					config.openRouterTitle ?? process.env.OPENROUTER_TITLE ?? undefined,
			})
		: new OpenAI({
				apiKey: config.apiKey,
				baseURL: config.baseUrl,
			});

	// Serialize calls even if the runner ever calls chooseMove concurrently.
	let chain: Promise<Move> = Promise.resolve({ action: "pass" });

	return {
		id,
		name: `LlmBot_${config.model}`,
		chooseMove: (ctx) => {
			chain = chain
				.catch(() => ({ action: "pass" }) as Move)
				.then(async () => chooseMove(client, id, config, ctx));
			return chain;
		},
	};
}

async function chooseMove(
	client: OpenAI,
	botId: string,
	config: LlmBotConfig & { delayMs?: number },
	ctx: {
		state: MatchState;
		legalMoves: Move[];
		turn: number;
		rng: () => number;
	},
): Promise<Move> {
	const { state, legalMoves, turn, rng } = ctx;

	if (config.delayMs && config.delayMs > 0) {
		await sleep(config.delayMs);
	}

	const side = inferSide(state, botId);
	const stronghold = findStrongholdHex(state, side);

	const system = buildSystemPrompt({
		side,
		stronghold,
		systemPrompt: config.systemPrompt,
	});
	const user = buildUserMessage({ state, legalMoves, turn });

	let content = "";
	try {
		const completion = await withRetryOnce(async () => {
			return client.chat.completions.create({
				model: config.model,
				temperature: config.temperature ?? 0.3,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				// Keep responses short to reduce cost and minimize formatting drift.
				max_tokens: 300,
			});
		});

		content = completion.choices?.[0]?.message?.content ?? "";
	} catch (e) {
		// If the provider is down, still make progress.
		return pickOne(legalMoves, rng);
	}

	const parsed = parseLlmJsonish(content);
	const moveIndex =
		typeof parsed.moveIndex === "number" ? parsed.moveIndex : undefined;
	const reasoning =
		typeof parsed.reasoning === "string" ? parsed.reasoning : undefined;

	const chosen =
		typeof moveIndex === "number" &&
		Number.isInteger(moveIndex) &&
		moveIndex >= 0 &&
		moveIndex < legalMoves.length
			? legalMoves[moveIndex]
			: undefined;

	const move = chosen ?? pickOne(legalMoves, rng);

	// Attach reasoning if present; engine accepts optional reasoning on all moves.
	return reasoning ? ({ ...move, reasoning } as Move) : move;
}

function buildSystemPrompt(opts: {
	side: "A" | "B";
	stronghold: string;
	systemPrompt?: string;
}): string {
	const strategy = opts.systemPrompt?.trim()
		? opts.systemPrompt.trim()
		: "Try to win.";

	return [
		"You are an AI agent playing Fightclaw, a hex-based strategy game.",
		"",
		"RULES:",
		`- 21x9 hex grid. You are Player ${opts.side} (stronghold at ${opts.stronghold}).`,
		"- Units: infantry (ATK 2, DEF 4, HP 3, range 1, move 2), cavalry (ATK 4, DEF 2, HP 2, range 1, move 4), archer (ATK 3, DEF 1, HP 2, range 2, move 3).",
		"- 5 actions per turn. Actions: move, attack, recruit, fortify, end_turn.",
		"- Same-type units can stack on one hex (max 5). Stacks move together.",
		"- Combat: ATK = base + 1 (attacker bonus) + stack bonus. Damage = max(1, ATK - DEF).",
		"- Win by: capturing ANY enemy stronghold, eliminating all enemy units, or having more VP at turn 20.",
		"",
		"YOUR STRATEGY:",
		strategy,
		"",
		"RESPOND with JSON only:",
		'{ "moveIndex": <number from legal moves list>, "reasoning": "brief explanation" }',
	].join("\n");
}

function buildUserMessage(opts: {
	state: MatchState;
	legalMoves: Move[];
	turn: number;
}): string {
	const { state, legalMoves, turn } = opts;

	const pA = state.players.A;
	const pB = state.players.B;

	const unitsA = pA.units.map((u) => ({
		id: u.id,
		type: u.type,
		pos: u.position,
		hp: u.hp,
		fortified: u.isFortified,
	}));
	const unitsB = pB.units.map((u) => ({
		id: u.id,
		type: u.type,
		pos: u.position,
		hp: u.hp,
		fortified: u.isFortified,
	}));

	return [
		`TURN: ${turn}`,
		`ACTIVE_PLAYER: ${state.activePlayer}`,
		`ACTIONS_REMAINING: ${state.actionsRemaining}`,
		"",
		"BOARD (ASCII):",
		renderAscii(state),
		"",
		"PLAYER_RESOURCES:",
		JSON.stringify(
			{
				A: { id: pA.id, gold: pA.gold, wood: pA.wood, vp: pA.vp },
				B: { id: pB.id, gold: pB.gold, wood: pB.wood, vp: pB.vp },
			},
			null,
			2,
		),
		"",
		"UNITS:",
		JSON.stringify({ A: unitsA, B: unitsB }, null, 2),
		"",
		"LEGAL_MOVES (JSON array, index is moveIndex):",
		JSON.stringify(legalMoves, null, 2),
	].join("\n");
}

function inferSide(state: MatchState, botId: string): "A" | "B" {
	return state.players.A.id === botId ? "A" : "B";
}

function findStrongholdHex(state: MatchState, side: "A" | "B"): string {
	const target = side === "A" ? "stronghold_a" : "stronghold_b";
	const hex = state.board.find((h) => h.type === target);
	return hex?.id ?? "unknown";
}

async function withRetryOnce<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		const status =
			(err as { status?: number; statusCode?: number } | null)?.status ??
			(err as { status?: number; statusCode?: number } | null)?.statusCode;
		if (status === 429 || status === 500 || status === 503) {
			await sleep(2000);
			return fn();
		}
		throw err;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export function parseLlmJsonish(text: string): {
	moveIndex?: number;
	reasoning?: string;
} {
	// 1) Regex extract moveIndex number (preferred per plan)
	let moveIndexFromRegex: number | undefined;
	const moveIndexMatch =
		text.match(/"moveIndex"\s*:\s*(-?\d+)/) ??
		text.match(/\bmoveIndex\b[^0-9-]*(-?\d+)/i);
	if (moveIndexMatch?.[1]) {
		const n = Number(moveIndexMatch[1]);
		if (Number.isFinite(n)) moveIndexFromRegex = n;
	}

	// 2) First valid JSON object in the response
	const obj = extractFirstJsonObject(text);
	if (obj) {
		try {
			const parsed = JSON.parse(obj) as unknown;
			if (parsed && typeof parsed === "object") {
				const moveIndex = (parsed as { moveIndex?: unknown }).moveIndex;
				const reasoning = (parsed as { reasoning?: unknown }).reasoning;
				return {
					moveIndex:
						moveIndexFromRegex ??
						(typeof moveIndex === "number"
							? moveIndex
							: typeof moveIndex === "string"
								? Number(moveIndex)
								: undefined),
					reasoning: typeof reasoning === "string" ? reasoning : undefined,
				};
			}
		} catch {
			// ignore
		}
	}

	// 3) Give up; caller will random-pick.
	return moveIndexFromRegex !== undefined
		? { moveIndex: moveIndexFromRegex }
		: {};
}

function extractFirstJsonObject(text: string): string | null {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}
