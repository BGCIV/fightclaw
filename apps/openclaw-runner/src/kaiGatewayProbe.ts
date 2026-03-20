import { isDeepStrictEqual } from "node:util";
import {
	listLegalMoves,
	type MatchState,
	type Move,
	MoveSchema,
} from "@fightclaw/engine";

export type KaiGatewayProbeFailureClass =
	| "none"
	| "parse_failure"
	| "invalid_move_selection"
	| "provider_invocation_failure";

export type KaiGatewayProbeParseOutcome =
	| "parsed_json"
	| "unparseable_text_reply"
	| "provider_error";

export type KaiGatewayProbeInput = {
	agentId: string;
	agentName: string;
	matchId: string;
	stateVersion: number;
	state: unknown;
	turnActionIndex?: number;
	remainingActionBudget?: number;
	previousActionsThisTurn?: unknown;
	finishOverlay?: boolean;
	strategyDirective?: unknown;
};

export type KaiGatewayProbeProviderResult =
	| string
	| {
			rawGatewayOutput: string;
	  }
	| null;

export type KaiGatewayProbeProvider = (
	input: KaiGatewayProbeInput,
) => Promise<KaiGatewayProbeProviderResult>;

export type KaiGatewayProbeReport = {
	failureClass: KaiGatewayProbeFailureClass;
	parseOutcome: KaiGatewayProbeParseOutcome;
	latencyMs: number;
	chosenMove: Move | null;
	fallbackMove: Move | null;
	move: Move | null;
	publicThought?: string;
	rawGatewayOutput?: string | null;
	rawTextReply?: string | null;
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

	if (MoveSchema.safeParse(record.move).success) {
		return { move: record.move as Move, publicThought };
	}
	if (MoveSchema.safeParse(record).success) {
		return { move: record as Move, publicThought };
	}
	return { move: null, publicThought };
};

const selectLegalFallbackMove = (state: MatchState | null): Move | null => {
	if (!state) return null;
	return listLegalMoves(state)[0] ?? null;
};

const buildFallbackReport = (args: {
	state: MatchState | null;
	failureClass: Exclude<KaiGatewayProbeFailureClass, "none">;
	parseOutcome: KaiGatewayProbeParseOutcome;
	publicThought: string;
	rawGatewayOutput?: string | null;
	rawTextReply?: string | null;
	startedAt: number;
}): KaiGatewayProbeReport => {
	const fallbackMove = selectLegalFallbackMove(args.state);
	return {
		failureClass: args.failureClass,
		parseOutcome: args.parseOutcome,
		latencyMs: Math.max(0, performance.now() - args.startedAt),
		chosenMove: null,
		fallbackMove,
		move: fallbackMove,
		publicThought: args.publicThought,
		rawGatewayOutput: args.rawGatewayOutput ?? null,
		rawTextReply: args.rawTextReply ?? null,
	};
};

export const probeKaiGatewayOutcome = async (
	input: KaiGatewayProbeInput,
	provider: KaiGatewayProbeProvider,
): Promise<KaiGatewayProbeReport> => {
	const startedAt = performance.now();
	const state = extractState(input.state);

	try {
		const raw = await provider(input);
		const rawGatewayOutput =
			typeof raw === "string"
				? raw
				: raw &&
						typeof raw === "object" &&
						typeof raw.rawGatewayOutput === "string"
					? raw.rawGatewayOutput
					: null;

		if (!rawGatewayOutput) {
			return buildFallbackReport({
				state,
				failureClass: "provider_invocation_failure",
				parseOutcome: "provider_error",
				publicThought:
					"Provider invocation did not return a usable gateway payload.",
				rawGatewayOutput,
				startedAt,
			});
		}

		const textReply = extractTextReply(rawGatewayOutput);
		if (!textReply) {
			return buildFallbackReport({
				state,
				failureClass: "parse_failure",
				parseOutcome: "unparseable_text_reply",
				publicThought:
					"Model reply was not parseable JSON; selected deterministic legal fallback.",
				rawGatewayOutput,
				startedAt,
			});
		}

		const decoded = extractJsonObject(textReply);
		if (!decoded) {
			return buildFallbackReport({
				state,
				failureClass: "parse_failure",
				parseOutcome: "unparseable_text_reply",
				publicThought:
					"Model reply was not parseable JSON; selected deterministic legal fallback.",
				rawGatewayOutput,
				rawTextReply: textReply,
				startedAt,
			});
		}

		const normalized = normalizeModelMove(decoded);
		const legalMoves = state ? listLegalMoves(state) : [];
		const chosen = normalized.move;
		const isLegal =
			chosen &&
			legalMoves.some((candidate) => isDeepStrictEqual(candidate, chosen));

		if (!chosen || !isLegal) {
			return buildFallbackReport({
				state,
				failureClass: "invalid_move_selection",
				parseOutcome: "parsed_json",
				publicThought:
					"Model chose an invalid move; selected deterministic legal fallback.",
				rawGatewayOutput,
				rawTextReply: textReply,
				startedAt,
			});
		}

		return {
			failureClass: "none",
			parseOutcome: "parsed_json",
			latencyMs: Math.max(0, performance.now() - startedAt),
			chosenMove: chosen,
			fallbackMove: null,
			move: chosen,
			publicThought:
				normalized.publicThought ??
				"Public-safe reasoning unavailable; legal move selected.",
			rawGatewayOutput,
			rawTextReply: textReply,
		};
	} catch {
		return buildFallbackReport({
			state,
			failureClass: "provider_invocation_failure",
			parseOutcome: "provider_error",
			publicThought:
				"Agent call failed; selected deterministic legal fallback.",
			startedAt,
		});
	}
};
