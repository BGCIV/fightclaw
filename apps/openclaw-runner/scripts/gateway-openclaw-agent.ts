import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { listLegalMoves, type MatchState, type Move } from "@fightclaw/engine";

type GatewayInput = {
	agentId?: string;
	agentName?: string;
	matchId?: string;
	stateVersion?: number;
	state?: unknown;
};

type GatewayOutput = {
	move: Move;
	publicThought?: string;
};

const FALLBACK_MOVE: Move = { action: "pass" };

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

const buildPrompt = (input: {
	agentId: string;
	agentName: string;
	matchId: string;
	stateVersion: number;
	state: MatchState;
	legalMoves: Move[];
}) => {
	const summary = summarizeState(input.state);
	return [
		`You are Fightclaw agent "${input.agentName}" (${input.agentId}).`,
		"Choose exactly one legal move from the provided legalMoves array.",
		"Respond with JSON only (no markdown, no prose), one line:",
		'{"move": <one legal move object>, "publicThought": "<short public-safe sentence>"}',
		"Do not invent fields. Do not output invalid JSON.",
		`matchId=${input.matchId}, stateVersion=${input.stateVersion}`,
		`stateSummary=${JSON.stringify(summary)}`,
		`legalMoves=${JSON.stringify(input.legalMoves)}`,
	].join("\n");
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

	if (isRecord(record.move)) {
		return { move: record.move as Move, publicThought };
	}
	if (typeof record.action === "string") {
		return { move: record as Move, publicThought };
	}
	return { move: null, publicThought };
};

const callOpenClawAgent = async (args: {
	agentSelector: string;
	timeoutSeconds: number;
	message: string;
}): Promise<string> => {
	return await new Promise((resolve, reject) => {
		const child = spawn(
			"openclaw",
			[
				"agent",
				"--agent",
				args.agentSelector,
				"--json",
				"--timeout",
				String(args.timeoutSeconds),
				"--message",
				args.message,
			],
			{
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

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
	if (!isRecord(parsed)) return null;
	const result = parsed.result;
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

const main = async () => {
	const raw = await readStdin();
	const parsed = safeJsonParse(raw);
	const payload: GatewayInput = isRecord(parsed)
		? (parsed as GatewayInput)
		: {};

	const state = extractState(payload.state);
	if (!state) {
		process.stdout.write(
			JSON.stringify({
				move: FALLBACK_MOVE,
				publicThought: "State unavailable; fallback move applied.",
			}),
		);
		return;
	}

	const legalMoves = listLegalMoves(state);
	if (legalMoves.length === 0) {
		process.stdout.write(
			JSON.stringify({
				move: { action: "end_turn" },
				publicThought: "No legal moves available; ending turn.",
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

	const message = buildPrompt({
		agentId: payload.agentId ?? "agent",
		agentName: payload.agentName ?? agentSelector,
		matchId: payload.matchId ?? "match",
		stateVersion: payload.stateVersion ?? state.stateVersion,
		state,
		legalMoves,
	});

	try {
		const rawAgent = await callOpenClawAgent({
			agentSelector,
			timeoutSeconds,
			message,
		});
		const textReply = extractTextReply(rawAgent);
		const decoded = textReply ? extractJsonObject(textReply) : null;
		if (!decoded) {
			process.stdout.write(
				JSON.stringify({
					move: legalMoves[0],
					publicThought:
						"Model reply was not parseable JSON; selected deterministic legal fallback.",
				}),
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
				JSON.stringify({
					move: legalMoves[0],
					publicThought:
						"Model chose an invalid move; selected deterministic legal fallback.",
				}),
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
	} catch {
		process.stdout.write(
			JSON.stringify({
				move: legalMoves[0],
				publicThought:
					"Agent call failed; selected deterministic legal fallback.",
			}),
		);
	}
};

void main();
