import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
	listLegalMoves,
	type MatchState,
	type Move,
	MoveSchema,
} from "@fightclaw/engine";

type GatewayInput = {
	agentId?: string;
	agentName?: string;
	matchId?: string;
	stateVersion?: number;
	state?: unknown;
	turnActionIndex?: number;
	remainingActionBudget?: number;
	previousActionsThisTurn?: unknown;
	finishOverlay?: boolean;
	strategyDirective?: unknown;
	strategyPrompt?: unknown;
	turnContext?: unknown;
};

type GatewaySuccessOutput = {
	move: Move;
	publicThought?: string;
};

type GatewayFailureOutput = {
	error: string;
	publicThought?: string;
};

type TurnContextSummary = {
	turnInfo: string | null;
	enemyRecentMoves: string[];
	enemyRecentThoughts: string[];
	ownRecentMoves: string[];
	ownRecentThoughts: string[];
};

const EMPTY_TURN_CONTEXT: TurnContextSummary = {
	turnInfo: null,
	enemyRecentMoves: [],
	enemyRecentThoughts: [],
	ownRecentMoves: [],
	ownRecentThoughts: [],
};

const BOOTSTRAP_CACHE_PATH = join(
	process.env.OPENCLAW_BOOTSTRAP_CACHE_DIR?.trim() || tmpdir(),
	"fightclaw-openclaw-bootstrap.json",
);

export const resolveOpenClawBin = (env: NodeJS.ProcessEnv = process.env) => {
	const raw = env.OPENCLAW_LOCAL_BIN?.trim() || env.OPENCLAW_BIN?.trim();
	return raw && raw.length > 0 ? raw : "openclaw";
};

const readStdin = async () => {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	return Buffer.concat(chunks).toString("utf8").trim();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const safeJsonParse = (raw: string): unknown => {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
};

const isMove = (value: unknown): value is Move =>
	MoveSchema.safeParse(value).success;

const extractState = (value: unknown): MatchState | null => {
	if (!isRecord(value)) return null;
	if (Array.isArray(value.board) && isRecord(value.players)) {
		return value as MatchState;
	}
	const nested = value.state;
	if (
		isRecord(nested) &&
		Array.isArray(nested.board) &&
		isRecord(nested.players)
	) {
		return nested as MatchState;
	}
	if (isRecord(nested) && isRecord(nested.game)) {
		const game = nested.game;
		if (Array.isArray(game.board) && isRecord(game.players)) {
			return game as MatchState;
		}
	}
	return null;
};

const shorten = (value: string, maxChars = 160) => {
	const cleaned = value.replace(/\s+/g, " ").trim();
	if (cleaned.length <= maxChars) return cleaned;
	return `${cleaned.slice(0, maxChars - 1)}…`;
};

const debugEnabled = process.env.OPENCLAW_DEBUG === "1";

const summarizeState = (state: MatchState) => {
	const units = Object.values(state.units ?? {});
	const counts = units.reduce(
		(acc, unit) => {
			const side = unit.side === "A" ? "A" : "B";
			acc[side] += 1;
			return acc;
		},
		{ A: 0, B: 0 },
	);

	const playerA = state.players?.A;
	const playerB = state.players?.B;

	return {
		turn: state.turn,
		activePlayer: state.activePlayer,
		version: state.stateVersion,
		status: state.status,
		unitCounts: counts,
		playerA: playerA
			? {
					id: playerA.id,
					gold: playerA.gold,
					wood: playerA.wood,
					vp: playerA.vp,
				}
			: null,
		playerB: playerB
			? {
					id: playerB.id,
					gold: playerB.gold,
					wood: playerB.wood,
					vp: playerB.vp,
				}
			: null,
	};
};

const shortenJson = (value: unknown, maxChars = 260) => {
	const serialized =
		typeof value === "string" ? value : JSON.stringify(value ?? null);
	return shorten(serialized, maxChars);
};

const asStringArray = (value: unknown): string[] => {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => {
			if (typeof entry === "string") return shorten(entry, 200);
			if (isRecord(entry)) return shortenJson(entry, 220);
			return null;
		})
		.filter((entry): entry is string => Boolean(entry?.trim()));
};

const toMoveSummary = (entry: unknown): string | null => {
	if (typeof entry === "string") return shorten(entry, 200);
	if (!isRecord(entry)) return null;
	const move = isRecord(entry.move) ? entry.move : entry;
	const action =
		typeof move.action === "string"
			? move.action
			: typeof move.type === "string"
				? move.type
				: "move";
	const details = shortenJson(move, 200);
	return `${action}: ${details}`;
};

const toThoughtSummary = (entry: unknown): string | null => {
	if (typeof entry === "string") return shorten(entry, 200);
	if (!isRecord(entry)) return null;
	const thought =
		typeof entry.publicThought === "string"
			? entry.publicThought
			: typeof entry.reasoning === "string"
				? entry.reasoning
				: typeof entry.thought === "string"
					? entry.thought
					: typeof entry.text === "string"
						? entry.text
						: null;
	return thought ? shorten(thought, 200) : shortenJson(entry, 200);
};

const normalizeSummaries = (
	value: unknown,
	project: (entry: unknown) => string | null,
): string[] => {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => project(entry))
		.filter((entry): entry is string => Boolean(entry?.trim()));
};

const pickSummaryList = (args: {
	source: Record<string, unknown>;
	primaryKeys: string[];
	fallbackKeys: string[];
	project: (entry: unknown) => string | null;
}): string[] => {
	for (const key of args.primaryKeys) {
		const values = normalizeSummaries(args.source[key], args.project);
		if (values.length > 0) return values;
	}
	for (const key of args.fallbackKeys) {
		const values = asStringArray(args.source[key]);
		if (values.length > 0) return values;
	}
	return [];
};

const normalizePartyContext = (
	raw: unknown,
): { moves: string[]; thoughts: string[] } => {
	if (!isRecord(raw)) return { moves: [], thoughts: [] };

	return {
		moves: pickSummaryList({
			source: raw,
			primaryKeys: ["recentMoves", "moves", "recent_actions", "actions"],
			fallbackKeys: [],
			project: toMoveSummary,
		}),
		thoughts: pickSummaryList({
			source: raw,
			primaryKeys: [
				"recentPublicThoughts",
				"recentThoughts",
				"publicThoughts",
				"thoughts",
			],
			fallbackKeys: [],
			project: toThoughtSummary,
		}),
	};
};

const summarizeTurnContext = (raw: unknown): TurnContextSummary => {
	if (!isRecord(raw)) {
		return EMPTY_TURN_CONTEXT;
	}

	const ownFromNested = normalizePartyContext(raw.own);
	const enemyFromNested = normalizePartyContext(raw.enemy);

	const ownRecentMoves =
		ownFromNested.moves.length > 0
			? ownFromNested.moves
			: pickSummaryList({
					source: raw,
					primaryKeys: [
						"ownRecentMoves",
						"recentOwnMoves",
						"ownMoves",
						"myRecentMoves",
					],
					fallbackKeys: [],
					project: toMoveSummary,
				});
	const enemyRecentMoves =
		enemyFromNested.moves.length > 0
			? enemyFromNested.moves
			: pickSummaryList({
					source: raw,
					primaryKeys: [
						"enemyRecentMoves",
						"recentEnemyMoves",
						"enemyMoves",
						"opponentRecentMoves",
					],
					fallbackKeys: [],
					project: toMoveSummary,
				});
	const ownRecentThoughts =
		ownFromNested.thoughts.length > 0
			? ownFromNested.thoughts
			: pickSummaryList({
					source: raw,
					primaryKeys: [
						"ownRecentPublicThoughts",
						"recentOwnPublicThoughts",
						"ownPublicThoughts",
						"ownRecentThoughts",
						"myRecentThoughts",
					],
					fallbackKeys: [],
					project: toThoughtSummary,
				});
	const enemyRecentThoughts =
		enemyFromNested.thoughts.length > 0
			? enemyFromNested.thoughts
			: pickSummaryList({
					source: raw,
					primaryKeys: [
						"enemyRecentPublicThoughts",
						"recentEnemyPublicThoughts",
						"enemyPublicThoughts",
						"enemyRecentThoughts",
						"opponentRecentThoughts",
					],
					fallbackKeys: [],
					project: toThoughtSummary,
				});

	const current = isRecord(raw.current) ? raw.current : null;
	const turnInfoValue =
		raw.turnInfo ??
		raw.turn ??
		raw.currentTurn ??
		raw.turnNumber ??
		raw.round ??
		raw.activePlayer ??
		raw.turnSummary ??
		(current
			? {
					turn: current.turn ?? raw.turn ?? raw.currentTurn ?? raw.turnNumber,
					actionsRemaining: current.actionsRemaining,
					activePlayer: current.activePlayer ?? raw.activePlayer,
				}
			: undefined);
	const turnInfo =
		turnInfoValue === undefined ? null : shortenJson(turnInfoValue, 220);

	return {
		turnInfo,
		enemyRecentMoves,
		enemyRecentThoughts,
		ownRecentMoves,
		ownRecentThoughts,
	};
};

const normalizeStrategyPrompt = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return shorten(trimmed, 800);
};

const toSessionSafe = (value: string, fallback: string) => {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return normalized || fallback;
};

const resolveSessionId = (args: {
	matchId: string;
	agentSelector: string;
	agentId: string;
}) => {
	const explicitSessionId = process.env.OPENCLAW_SESSION_ID?.trim();
	if (explicitSessionId) return explicitSessionId;
	const matchPart = toSessionSafe(args.matchId, "match");
	const agentPart = toSessionSafe(args.agentSelector || args.agentId, "agent");
	return `fightclaw-${matchPart}-${agentPart}`;
};

const readBootstrapCache = async (): Promise<Record<string, true>> => {
	try {
		const raw = await readFile(BOOTSTRAP_CACHE_PATH, "utf8");
		const parsed = safeJsonParse(raw);
		if (!isRecord(parsed)) return {};
		const cache: Record<string, true> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (value === true) {
				cache[key] = true;
			}
		}
		return cache;
	} catch {
		return {};
	}
};

const markBootstrapComplete = async (sessionId: string) => {
	try {
		const cache = await readBootstrapCache();
		cache[sessionId] = true;
		await mkdir(dirname(BOOTSTRAP_CACHE_PATH), { recursive: true });
		await writeFile(
			BOOTSTRAP_CACHE_PATH,
			`${JSON.stringify(cache, null, 2)}\n`,
			"utf8",
		);
	} catch {
		// best effort cache only; failures should not block gameplay
	}
};

const hasBootstrapComplete = async (sessionId: string) => {
	const cache = await readBootstrapCache();
	return cache[sessionId] === true;
};

const buildBootstrapPrefix = (input: {
	agentId: string;
	agentName: string;
	strategyPrompt: string | null;
}) => {
	return [
		`SYSTEM_INIT: You are Fightclaw agent "${input.agentName}" (${input.agentId}).`,
		"You are running in production turn-loop mode.",
		"Treat Fightclaw game rules/strategy as preloaded local knowledge from skill references.",
		"Do not ask for rules docs or missing setup context during turns.",
		"Each turn you will receive a TURN_PAYLOAD JSON object with match state + context.",
		'You must reply in ONE line of valid JSON only: {"move": <one legal move object>, "publicThought": "<short sentence>"}',
		"publicThought must be concise, public-safe, and in-character.",
		`strategyPrompt=${input.strategyPrompt ?? "none"}`,
	].join("\n");
};

const buildTurnPayload = (input: {
	matchId: string;
	stateVersion: number;
	state: MatchState;
	legalMoves: Move[];
	turnContext: TurnContextSummary;
}) => {
	const summary = summarizeState(input.state);
	const fallback = (values: string[]) =>
		values.length > 0 ? values : ["none"];

	return {
		matchId: input.matchId,
		stateVersion: input.stateVersion,
		boardSummary: summary,
		turnInfo: input.turnContext.turnInfo ?? "none",
		recentEnemyMoves: fallback(input.turnContext.enemyRecentMoves),
		recentEnemyPublicThoughts: fallback(input.turnContext.enemyRecentThoughts),
		recentOwnMoves: fallback(input.turnContext.ownRecentMoves),
		recentOwnPublicThoughts: fallback(input.turnContext.ownRecentThoughts),
		legalMoves: input.legalMoves,
	};
};

export const buildPrompt = (input: {
	agentId: string;
	agentName: string;
	matchId: string;
	stateVersion: number;
	state: MatchState;
	legalMoves: Move[];
	turnActionIndex?: number;
	remainingActionBudget?: number;
	previousActionsThisTurn?: unknown;
	finishOverlay?: boolean;
	strategyDirective?: string;
	strategyPrompt?: string | null;
	turnContext?: TurnContextSummary;
	includeBootstrap?: boolean;
}) => {
	const summary = summarizeState(input.state);
	const strategyDirective =
		typeof input.strategyDirective === "string"
			? input.strategyDirective.trim()
			: "";
	const wantsFinishOverlay =
		input.finishOverlay || strategyDirective.length > 0;
	const turnContext = input.turnContext ?? EMPTY_TURN_CONTEXT;
	const turnPayload = buildTurnPayload({
		matchId: input.matchId,
		stateVersion: input.stateVersion,
		state: input.state,
		legalMoves: input.legalMoves,
		turnContext,
	});
	const sections = [
		...(input.includeBootstrap
			? [
					buildBootstrapPrefix({
						agentId: input.agentId,
						agentName: input.agentName,
						strategyPrompt: input.strategyPrompt ?? null,
					}),
				]
			: []),
		`You are Fightclaw agent "${input.agentName}" (${input.agentId}).`,
		"Choose the best next legal move from the provided legalMoves array.",
		"You may be called multiple times during the same player-turn.",
		"Do not end the turn after one merely safe action if a legal high-value follow-up improves combat position, objective pressure, economy, or stronghold threat.",
		"End the turn when no legal follow-up materially improves the position.",
		...(wantsFinishOverlay
			? [
					"Prefer a legal terminal or high-pressure line when it is available.",
					"Take the terminal line when it is legal.",
					"If a legal attack or decisive follow-up exists, do not choose end_turn yet.",
				]
			: []),
		"Respond with JSON only (no markdown, no prose), one line:",
		'{"move": <one legal move object>, "publicThought": "<short public-safe sentence>"}',
		"Do not invent fields. Do not output invalid JSON.",
		...(strategyDirective.length > 0
			? [`strategyDirective=${JSON.stringify(strategyDirective)}`]
			: []),
		...(input.strategyPrompt
			? [`strategyPrompt=${JSON.stringify(input.strategyPrompt)}`]
			: []),
		`matchId=${input.matchId}, stateVersion=${input.stateVersion}`,
		`turnActionIndex=${String(input.turnActionIndex ?? 1)}`,
		`remainingActionBudget=${String(input.remainingActionBudget ?? 1)}`,
		`previousActionsThisTurn=${JSON.stringify(input.previousActionsThisTurn ?? [])}`,
		`stateSummary=${JSON.stringify(summary)}`,
		`turnContextSummary=${JSON.stringify(turnPayload)}`,
		`legalMoves=${JSON.stringify(input.legalMoves)}`,
	];
	return sections.join("\n");
};

const extractJsonObject = (text: string): Record<string, unknown> | null => {
	const direct = safeJsonParse(text);
	if (isRecord(direct)) return direct;

	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	const slice = text.slice(start, end + 1);
	const parsed = safeJsonParse(slice);
	return isRecord(parsed) ? parsed : null;
};

const normalizeModelMove = (
	record: Record<string, unknown>,
): { move: Move | null; publicThought: string | undefined } => {
	const publicThought =
		typeof record.publicThought === "string"
			? record.publicThought
			: typeof record.reasoning === "string"
				? record.reasoning
				: undefined;

	if (isMove(record.move)) {
		return { move: record.move, publicThought };
	}
	if (isMove(record)) {
		return { move: record, publicThought };
	}
	return { move: null, publicThought };
};

const buildLegalFallback = (
	state: MatchState | null,
	message: string,
): GatewaySuccessOutput | GatewayFailureOutput => {
	if (!state) {
		return {
			error: message,
			publicThought:
				"State unavailable; no legal fallback move could be derived.",
		};
	}

	const legalMoves = listLegalMoves(state);
	const move = legalMoves[0] ?? null;
	if (!move) {
		return {
			error: message,
			publicThought:
				"No legal fallback move is available for the current state.",
		};
	}

	return {
		move,
		publicThought: message,
	};
};

const callOpenClawAgent = async (args: {
	agentSelector: string;
	sessionId: string;
	channel: string;
	localMode: boolean;
	timeoutSeconds: number;
	message: string;
}): Promise<string> => {
	const sshTarget = process.env.OPENCLAW_SSH_TARGET?.trim();
	const remoteBin =
		process.env.OPENCLAW_REMOTE_BIN?.trim() || "/usr/local/bin/openclaw";
	const localBin = resolveOpenClawBin();
	const shQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
	const command = sshTarget ? "ssh" : localBin;
	const commandArgs = (() => {
		if (!sshTarget) {
			return [
				"agent",
				"--agent",
				args.agentSelector,
				...(args.localMode ? ["--local"] : ["--channel", args.channel]),
				"--session-id",
				args.sessionId,
				"--json",
				"--timeout",
				String(args.timeoutSeconds),
				"--message",
				args.message,
			];
		}
		const remoteCommand = [
			`${shQuote(remoteBin)} agent`,
			`--agent ${shQuote(args.agentSelector)}`,
			...(args.localMode
				? ["--local"]
				: [`--channel ${shQuote(args.channel)}`]),
			`--session-id ${shQuote(args.sessionId)}`,
			"--json",
			`--timeout ${shQuote(String(args.timeoutSeconds))}`,
			'--message "$(cat)"',
		].join(" ");
		return [sshTarget, remoteCommand];
	})();

	return await new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, {
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (sshTarget) {
			child.stdin.write(args.message);
		}
		child.stdin.end();

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code !== 0) {
				reject(
					new Error(
						`openclaw agent failed (${code}): ${shorten(stderr || stdout || "No output.")}`,
					),
				);
				return;
			}
			resolve(stdout.trim());
		});
	});
};

const extractTextReply = (raw: string): string | null => {
	const parsed = safeJsonParse(raw);
	const record = isRecord(parsed) ? parsed : extractJsonObject(raw);
	if (!record) return null;
	const result = record.result;
	if (!isRecord(result)) return null;
	const payloads = result.payloads;
	if (!Array.isArray(payloads)) return null;
	for (const payload of payloads) {
		if (
			isRecord(payload) &&
			typeof payload.text === "string" &&
			payload.text.trim()
		) {
			return payload.text.trim();
		}
	}
	return null;
};

const sanitizeModelTextForPublicThought = (value: string) => {
	const withoutFences = value
		.replace(/```json/gi, "")
		.replace(/```/g, "")
		.trim();
	return shorten(withoutFences, 200);
};

const main = async () => {
	const raw = await readStdin();
	const parsed = safeJsonParse(raw);
	const payload: GatewayInput = isRecord(parsed)
		? (parsed as GatewayInput)
		: {};

	const state = extractState(payload.state);
	if (!state) {
		process.stdout.write(
			JSON.stringify(
				buildLegalFallback(
					null,
					"State unavailable; no fallback move could be selected.",
				),
			),
		);
		return;
	}

	const legalMoves = listLegalMoves(state);
	if (legalMoves.length === 0) {
		process.stdout.write(
			JSON.stringify({
				error: "No legal moves available for the current state.",
				publicThought:
					"No legal moves available; the gateway is not submitting a move.",
			}),
		);
		return;
	}

	const agentSelector = process.env.OPENCLAW_AGENT_ID?.trim();
	if (!agentSelector) {
		process.stdout.write(
			JSON.stringify({
				move: legalMoves[0],
				publicThought:
					"OPENCLAW_AGENT_ID missing; selected deterministic legal fallback.",
			}),
		);
		return;
	}

	const timeoutSecondsRaw = Number.parseInt(
		process.env.OPENCLAW_TIMEOUT_SECONDS ?? "30",
		10,
	);
	const timeoutSeconds =
		Number.isFinite(timeoutSecondsRaw) && timeoutSecondsRaw > 0
			? timeoutSecondsRaw
			: 30;
	const localMode =
		process.env.OPENCLAW_AGENT_LOCAL === "1" ||
		process.env.OPENCLAW_AGENT_LOCAL?.toLowerCase() === "true";
	const channel = process.env.OPENCLAW_AGENT_CHANNEL?.trim() || "last";
	const turnContext = summarizeTurnContext(payload.turnContext);
	const strategyPrompt = normalizeStrategyPrompt(payload.strategyPrompt);
	const sessionId = resolveSessionId({
		matchId: payload.matchId ?? "match",
		agentSelector,
		agentId: payload.agentId ?? "agent",
	});
	const includeBootstrap = !(await hasBootstrapComplete(sessionId));

	const message = buildPrompt({
		agentId: payload.agentId ?? "agent",
		agentName: payload.agentName ?? agentSelector,
		matchId: payload.matchId ?? "match",
		stateVersion: payload.stateVersion ?? state.stateVersion,
		state,
		legalMoves,
		turnActionIndex:
			typeof payload.turnActionIndex === "number"
				? payload.turnActionIndex
				: undefined,
		remainingActionBudget:
			typeof payload.remainingActionBudget === "number"
				? payload.remainingActionBudget
				: undefined,
		previousActionsThisTurn: payload.previousActionsThisTurn,
		finishOverlay: payload.finishOverlay === true,
		strategyDirective:
			typeof payload.strategyDirective === "string"
				? payload.strategyDirective
				: undefined,
		strategyPrompt,
		turnContext,
		includeBootstrap,
	});

	try {
		const rawAgent = await callOpenClawAgent({
			agentSelector,
			sessionId,
			channel,
			localMode,
			timeoutSeconds,
			message,
		});
		if (includeBootstrap) {
			await markBootstrapComplete(sessionId);
		}
		const textReply = extractTextReply(rawAgent);
		const decoded = textReply ? extractJsonObject(textReply) : null;
		if (!decoded) {
			const publicThoughtFromModel = textReply?.trim()
				? sanitizeModelTextForPublicThought(textReply)
				: null;
			const debug =
				debugEnabled && textReply
					? ` reply=${shorten(textReply, 120)}`
					: debugEnabled
						? ` raw=${shorten(rawAgent, 120)}`
						: "";
			process.stdout.write(
				JSON.stringify(
					buildLegalFallback(
						state,
						publicThoughtFromModel ??
							`Model reply was not parseable JSON; selected deterministic legal fallback.${debug}`,
					),
				),
			);
			return;
		}

		const normalized = normalizeModelMove(decoded);
		const chosen = normalized.move;
		const legal =
			chosen &&
			legalMoves.some((candidate) => isDeepStrictEqual(candidate, chosen));

		if (!chosen || !legal) {
			process.stdout.write(
				JSON.stringify(
					buildLegalFallback(
						state,
						"Model chose an invalid move; selected deterministic legal fallback.",
					),
				),
			);
			return;
		}

		process.stdout.write(
			JSON.stringify({
				move: chosen,
				publicThought:
					shorten(
						normalized.publicThought ??
							"Public-safe reasoning unavailable; legal move selected.",
					) || "Public-safe reasoning unavailable.",
			}),
		);
	} catch (error) {
		console.error("gateway-openclaw-agent: agent invocation failed", error);
		const errorText = debugEnabled
			? ` (${shorten(error instanceof Error ? error.message : String(error), 120)})`
			: "";
		process.stdout.write(
			JSON.stringify(
				buildLegalFallback(
					state,
					`Agent call failed; selected deterministic legal fallback.${errorText}`,
				),
			),
		);
	}
};

const isMainModule =
	typeof process.argv[1] === "string" &&
	import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href;

if (isMainModule) {
	void main();
}
