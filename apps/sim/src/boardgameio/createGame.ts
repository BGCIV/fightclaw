import { Engine } from "../engineAdapter";
import { createCombatScenario } from "../scenarios/combatScenarios";
import type { Move } from "../types";
import {
	applyEngineMoveChecked,
	assertActivePlayerMapped,
	createPlayerMap,
	mapActiveSideToPlayerID,
} from "./adapter";
import type {
	BoardgameHarnessState,
	HarnessConfig,
	MoveApplyPayload,
	TurnPlanMeta,
} from "./types";

/**
 * Create a boardgame.io game object configured for the Fightclaw simulation harness.
 *
 * The returned game is wired for harness use: it initializes match state from a scenario
 * or engine initial state, maps players, advances a turn index, determines turn order
 * from the engine's active side, evaluates terminal state, and exposes move handlers
 * for applying engine moves and setting turn-plan metadata.
 *
 * @param config - Harness configuration (players, optional scenario, seed, engineConfig, and move validation mode)
 * @returns A boardgame.io-compatible game object implementing the Fightclaw simulation harness
 */
export function createFightclawGame(config: HarnessConfig) {
	const game: {
		[key: string]: unknown;
	} = {
		name: "fightclaw-sim-harness",
		events: {
			endTurn: true,
		},
		setup: () => {
			const { playerMap, reversePlayerMap } = createPlayerMap(config.players);
			const matchState = config.scenario
				? createCombatScenario(
						config.seed,
						config.players,
						config.scenario,
						config.engineConfig,
					)
				: Engine.createInitialState(
						config.seed,
						config.players,
						config.engineConfig,
					);
			assertActivePlayerMapped(matchState, config.players);
			return {
				matchState,
				turnIndex: 1,
				playerMap,
				reversePlayerMap,
			};
		},
		turn: {
			order: {
				first: ({
					G,
					ctx,
				}: {
					G: BoardgameHarnessState;
					ctx: { playOrder: string[] };
				}) => {
					const playerID = mapActiveSideToPlayerID(G.matchState);
					const idx = ctx.playOrder.indexOf(playerID);
					return idx >= 0 ? idx : 0;
				},
				next: ({
					G,
					ctx,
				}: {
					G: BoardgameHarnessState;
					ctx: { playOrder: string[] };
				}) => {
					const playerID = mapActiveSideToPlayerID(G.matchState);
					const idx = ctx.playOrder.indexOf(playerID);
					return idx >= 0 ? idx : undefined;
				},
			},
			onBegin: ({ G }: { G: BoardgameHarnessState }) => ({
				...G,
				turnIndex: G.turnIndex + 1,
			}),
		},
		endIf: ({ G }: { G: BoardgameHarnessState }) => {
			const terminal = Engine.isTerminal(G.matchState);
			if (!terminal.ended) return undefined;
			return {
				winner: terminal.winner ?? undefined,
				reason: terminal.reason,
			};
		},
		moves: {
			applyMove: (
				{ G }: { G: BoardgameHarnessState },
				payload: MoveApplyPayload,
			) => {
				const result = applyEngineMoveChecked({
					state: G.matchState,
					move: payload.move,
					validationMode: config.moveValidationMode,
				});
				if (!result.accepted) {
					return G;
				}
				return {
					...G,
					matchState: result.nextState,
				};
			},
			setTurnPlanMeta: (
				{ G }: { G: BoardgameHarnessState },
				_payload: TurnPlanMeta,
			) => {
				return G;
			},
		},
	};
	return game;
}

export type BoardgameMoveDispatchers = {
	applyMove: (payload: MoveApplyPayload) => void;
	setTurnPlanMeta: (payload: TurnPlanMeta) => void;
};

/**
 * Create a shallow copy of a `Move` object.
 *
 * @returns A new `Move` with the same top-level properties as `move` (shallow copy).
 */
export function normalizeMove(move: Move): Move {
	return { ...move };
}