import type { Move } from "@fightclaw/engine";

type TurnKeyGame = {
	turn?: number;
	activePlayer?: string;
} | null;

type EarlyEndTurnOverrideInput = {
	chosenMove: Move;
	legalMoves: Move[];
	actionsTakenThisTurn: number;
	minActionsBeforeEndTurn: number;
	requireOpeningPressure?: boolean;
};

const TERMINAL_ACTIONS = new Set<Move["action"]>(["end_turn", "pass"]);

export const buildMoveProviderTurnKey = (
	matchId: string,
	game: TurnKeyGame,
) => {
	if (!game) return `${matchId}:unknown`;
	return `${matchId}:${String(game.turn ?? "unknown")}:${String(game.activePlayer ?? "unknown")}`;
};

export const selectFinishFollowUpMove = (legalMoves: Move[]): Move | null => {
	const priorities: Move["action"][] = [
		"attack",
		"recruit",
		"fortify",
		"upgrade",
		"move",
	];
	for (const action of priorities) {
		const match = legalMoves.find((move) => move.action === action);
		if (match) return match;
	}
	return legalMoves.find((move) => !TERMINAL_ACTIONS.has(move.action)) ?? null;
};

export const movesMatchByIdentity = (
	candidate: Move,
	chosenMove: Move,
): boolean => {
	if (candidate.action !== chosenMove.action) return false;
	const fields: Array<"unitId" | "unitType" | "to" | "target" | "at"> = [
		"unitId",
		"unitType",
		"to",
		"target",
		"at",
	];
	for (const field of fields) {
		const candidateValue = (candidate as Record<string, unknown>)[field];
		const chosenValue = (chosenMove as Record<string, unknown>)[field];
		if (candidateValue !== chosenValue) return false;
	}
	return true;
};

export const resolveEarlyEndTurnOverride = ({
	chosenMove,
	legalMoves,
	actionsTakenThisTurn,
	minActionsBeforeEndTurn,
	requireOpeningPressure = false,
}: EarlyEndTurnOverrideInput): Move | null => {
	if (chosenMove.action !== "end_turn") return null;
	const pressureFloor = Math.max(
		minActionsBeforeEndTurn,
		requireOpeningPressure ? 1 : 0,
	);
	if (actionsTakenThisTurn >= pressureFloor) return null;
	return selectFinishFollowUpMove(legalMoves);
};
