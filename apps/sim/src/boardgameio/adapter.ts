import { MoveSchema } from "@fightclaw/engine";
import { Engine } from "../engineAdapter";
import type { AgentId, MatchState, Move } from "../types";
import type { MoveValidationMode } from "./types";

/**
 * Build bidirectional mappings between engine player indices and harness agent IDs.
 *
 * @param players - Tuple where index 0 is the agent ID for engine player "0" and index 1 is the agent ID for engine player "1"
 * @returns An object with `playerMap` mapping "0" and "1" to their corresponding AgentId, and `reversePlayerMap` mapping stringified AgentId values back to "0" or "1"
 */
export function createPlayerMap(players: [AgentId, AgentId]) {
	const playerMap: Record<string, AgentId> = {
		"0": players[0],
		"1": players[1],
	};
	const reversePlayerMap: Record<string, string> = {
		[String(players[0])]: "0",
		[String(players[1])]: "1",
	};
	return { playerMap, reversePlayerMap };
}

/**
 * Convert the match state's active side ("A" or "B") to the harness player ID "0" or "1".
 *
 * @param state - The current match state whose `activePlayer` is expected to be "A" or "B"
 * @returns `'0'` if `state.activePlayer` is `"A"`, `'1'` otherwise
 */
export function mapActiveSideToPlayerID(state: MatchState): string {
	return state.activePlayer === "A" ? "0" : "1";
}

/**
 * Verify that the engine's active player is one of the harness players.
 *
 * @param state - Match state containing the engine's active player and player mapping
 * @param players - Tuple of harness agent IDs corresponding to player indices "0" and "1"
 * @throws Error if the engine active player's agent ID is not equal to either harness player ID
 */
export function assertActivePlayerMapped(
	state: MatchState,
	players: [AgentId, AgentId],
): void {
	const expectedAgent = state.players[state.activePlayer].id;
	if (expectedAgent !== players[0] && expectedAgent !== players[1]) {
		throw new Error(
			`Engine active player ${String(expectedAgent)} is not in harness players`,
		);
	}
}

/**
 * Validate an engine move and apply it to the provided match state, returning whether it was accepted and the resulting state.
 *
 * Validates the move against the move schema, optionally enforces legality when `validationMode` is `"strict"`, and applies the move via the engine. The returned object captures acceptance, the new state (or the state after a failed application), an optional rejection reason when not accepted, and the number of engine events produced.
 *
 * @param state - The current match state to validate against and apply the move to
 * @param move - The move to validate and apply (annotation fields will be ignored for validation)
 * @param validationMode - `"strict"` to enforce legal-move checking against the engine's legal move list; other modes skip that check
 * @returns An object with:
 *  - `accepted`: `true` if the move was applied successfully, `false` otherwise.
 *  - `nextState`: the resulting `MatchState` (unchanged original state on schema/legality rejection; engine-returned state on application failure).
 *  - `rejectionReason` (optional): the engine-provided reason when a move is rejected during application or a string like `"invalid_move_schema"`/`"illegal_move"` for early rejections.
 *  - `engineEventsCount`: number of engine events produced by the attempted application.
 */
export function applyEngineMoveChecked(opts: {
	state: MatchState;
	move: Move;
	validationMode: MoveValidationMode;
}): {
	accepted: boolean;
	nextState: MatchState;
	rejectionReason?: string;
	engineEventsCount: number;
} {
	const engineMove = stripMoveAnnotations(opts.move);

	if (!MoveSchema.safeParse(engineMove).success) {
		return {
			accepted: false,
			nextState: opts.state,
			rejectionReason: "invalid_move_schema",
			engineEventsCount: 0,
		};
	}

	if (opts.validationMode === "strict") {
		const legalMoves = Engine.listLegalMoves(opts.state);
		const legal = legalMoves.some(
			(m) => stripReasoningJson(m) === stripReasoningJson(engineMove),
		);
		if (!legal) {
			return {
				accepted: false,
				nextState: opts.state,
				rejectionReason: "illegal_move",
				engineEventsCount: 0,
			};
		}
	}

	const result = Engine.applyMove(opts.state, engineMove);
	if (!result.ok) {
		return {
			accepted: false,
			nextState: result.state,
			rejectionReason: result.reason,
			engineEventsCount: result.engineEvents.length,
		};
	}
	return {
		accepted: true,
		nextState: result.state,
		engineEventsCount: result.engineEvents.length,
	};
}

/**
 * Produce a canonical JSON representation of a move with `reasoning` and `metadata` fields removed.
 *
 * @param move - The move object to canonicalize; `reasoning` and `metadata` (if present) will be omitted.
 * @returns A JSON string of `move` without the `reasoning` or `metadata` fields.
 */
function stripReasoningJson(move: Move): string {
	const clean = {
		...(move as Move & { reasoning?: string; metadata?: unknown }),
	};
	delete clean.reasoning;
	delete clean.metadata;
	return JSON.stringify(clean);
}

/**
 * Return a copy of a move with annotation fields removed.
 *
 * Produces a shallow copy of `move` with the `reasoning` and `metadata` fields deleted to produce a canonical move object for validation or comparison.
 *
 * @param move - The move to clean of annotation fields
 * @returns The same move object shape without `reasoning` or `metadata`
 */
function stripMoveAnnotations(move: Move): Move {
	const clean = {
		...(move as Move & { reasoning?: string; metadata?: unknown }),
	};
	delete clean.reasoning;
	delete clean.metadata;
	return clean as Move;
}