import type { Move } from "@fightclaw/engine";

const isTerminalAction = (move: Move) =>
	move.action === "end_turn" || move.action === "pass";

export const selectPreferredLegalFallbackMove = (
	legalMoves: Move[],
): Move | null => {
	if (legalMoves.length === 0) return null;

	const nonTerminal = legalMoves.find((move) => !isTerminalAction(move));
	if (nonTerminal) return nonTerminal;

	const endTurn = legalMoves.find((move) => move.action === "end_turn");
	if (endTurn) return endTurn;

	const pass = legalMoves.find((move) => move.action === "pass");
	if (pass) return pass;

	return legalMoves[0] ?? null;
};
