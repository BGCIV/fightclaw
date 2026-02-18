import { playMatchBoardgameIO } from "./boardgameio/runner";
import type {
	HarnessMode,
	InvalidPolicy,
	MoveValidationMode,
	ScenarioName,
} from "./boardgameio/types";
import {
	getDiagnosticsCollector,
	resetDiagnosticsCollector,
} from "./diagnostics/collector";
import { Engine } from "./engineAdapter";
import { mulberry32 } from "./rng";
import { createCombatScenario } from "./scenarios/combatScenarios";
import type {
	AgentId,
	Bot,
	EngineConfigInput,
	EngineEvent,
	MatchLog,
	MatchResult,
	MatchState,
	Move,
} from "./types";

/**
 * Plays a simulated match between the provided bots using the configured harness and options.
 *
 * @param opts.seed - Seed used to initialize deterministic RNG for the match
 * @param opts.players - Bots in turn order for the match
 * @param opts.maxTurns - Maximum number of turns before the match is ended as a draw
 * @param opts.harness - When `"boardgameio"`, runs the boardgame.io harness path; otherwise uses the legacy engine
 * @param opts.enableDiagnostics - When true, collects per-turn diagnostics and final game diagnostics
 * @param opts.invalidPolicy - Policy for handling invalid moves when using the boardgame.io harness (default `"skip"`)
 * @param opts.strict - When true enforces strict harness runtime checks; defaults to the HARNESS_STRICT environment setting when not provided
 * @param opts.moveValidationMode - Validation mode for moves when using the boardgame.io harness (default `"strict"`)
 * @param opts.artifactDir - Directory to write harness artifacts (used by boardgame.io harness)
 * @param opts.storeFullPrompt - When true, store full prompts in artifacts; defaults to false in CI
 * @param opts.storeFullOutput - When true, store full outputs in artifacts; defaults to false in CI
 * @param opts.engineConfig - Optional engine configuration passed to the game engine
 * @param opts.scenario - Optional scenario name to initialize a preconfigured game state
 * @returns A MatchResult describing the final outcome, including turns played, winner (if any), illegal move count, termination reason, and an optional match log when recording is enabled
 */
export async function playMatch(opts: {
	seed: number;
	players: Bot[]; // turn order
	maxTurns: number;
	verbose?: boolean;
	record?: boolean;
	autofixIllegal?: boolean;
	enableDiagnostics?: boolean;
	engineConfig?: EngineConfigInput;
	scenario?: ScenarioName;
	harness?: HarnessMode;
	invalidPolicy?: InvalidPolicy;
	strict?: boolean;
	moveValidationMode?: MoveValidationMode;
	artifactDir?: string;
	storeFullPrompt?: boolean;
	storeFullOutput?: boolean;
}): Promise<MatchResult> {
	if (opts.harness === "boardgameio") {
		return playMatchBoardgameIO({
			seed: opts.seed,
			players: opts.players,
			maxTurns: opts.maxTurns,
			verbose: opts.verbose,
			record: opts.record,
			enableDiagnostics: opts.enableDiagnostics,
			engineConfig: opts.engineConfig,
			scenario: opts.scenario,
			invalidPolicy: opts.invalidPolicy ?? "skip",
			strict: opts.strict ?? process.env.HARNESS_STRICT === "1",
			moveValidationMode: opts.moveValidationMode ?? "strict",
			artifactDir: opts.artifactDir,
			storeFullPrompt: opts.storeFullPrompt ?? process.env.CI !== "true",
			storeFullOutput: opts.storeFullOutput ?? process.env.CI !== "true",
		});
	}
	return playMatchLegacy(opts);
}

/**
 * Plays a two-player match using the engine and returns the final match result.
 *
 * Runs up to `maxTurns`, invoking each bot's `chooseTurn` (batch) or `chooseMove` (single-move) handler,
 * validating and applying moves, tracking engine events and illegal-move handling, optionally recording
 * the full match and collecting diagnostics.
 *
 * @param opts - Configuration for the match
 * @param opts.seed - RNG seed used to initialize state and deterministically drive bots
 * @param opts.players - Two bots in turn order (must contain exactly two entries)
 * @param opts.maxTurns - Maximum number of turns to simulate before stopping with reason `"maxTurns"`
 * @param opts.verbose - If true, log per-turn actions and warnings
 * @param opts.record - If true, include a MatchLog in the returned result with moves, engine events, and final state
 * @param opts.autofixIllegal - If true, attempt fallback/forced legal moves when bots produce illegal moves or crash; otherwise the match ends with reason `"illegal"`
 * @param opts.enableDiagnostics - If true, collect per-turn and end-of-game diagnostics via the diagnostics collector
 * @param opts.engineConfig - Optional engine configuration passed to initial state creation
 * @param opts.scenario - Optional named scenario to initialize state instead of the engine's normal initial state
 * @returns The final MatchResult containing the seed, number of turns simulated, the winner (or `null`), the count of illegal moves, the terminal reason (`"terminal"`, `"illegal"`, or `"maxTurns"`), and an optional `log` when `opts.record` is true
 */
async function playMatchLegacy(opts: {
	seed: number;
	players: Bot[]; // turn order
	maxTurns: number;
	verbose?: boolean;
	record?: boolean;
	autofixIllegal?: boolean;
	enableDiagnostics?: boolean;
	engineConfig?: EngineConfigInput;
	scenario?: ScenarioName;
}): Promise<MatchResult> {
	const rng = mulberry32(opts.seed);
	const playerIds = opts.players.map((p) => p.id);
	if (playerIds.length !== 2) {
		throw new Error("playMatch requires exactly two players.");
	}
	// biome-ignore lint/style/noNonNullAssertion: length checked above
	const playerPair: [AgentId, AgentId] = [playerIds[0]!, playerIds[1]!];

	// Initialize diagnostics if enabled
	if (opts.enableDiagnostics) {
		resetDiagnosticsCollector();
		const collector = getDiagnosticsCollector();
		collector.startGame(
			opts.seed,
			opts.players[0]?.name ?? "unknown",
			opts.players[1]?.name ?? "unknown",
		);
	}

	let state: MatchState = opts.scenario
		? createCombatScenario(
				opts.seed,
				playerIds,
				opts.scenario,
				opts.engineConfig,
			)
		: Engine.createInitialState(opts.seed, playerIds, opts.engineConfig);
	let illegalMoves = 0;
	const moves: Move[] = [];
	const engineEvents: EngineEvent[] = [];

	const logIfNeeded = (): MatchLog | undefined => {
		if (!opts.record) return undefined;
		return {
			seed: opts.seed,
			players: playerPair,
			moves: [...moves],
			engineEvents: [...engineEvents],
			finalState: state,
		};
	};

	for (let turn = 1; turn <= opts.maxTurns; turn++) {
		const active = Engine.currentPlayer(state);
		const bot = opts.players.find((p) => p.id === active);
		if (!bot) throw new Error(`No bot for active player id ${String(active)}`);

		const terminal = Engine.isTerminal(state);
		if (terminal.ended) {
			const result: MatchResult = {
				seed: opts.seed,
				turns: turn - 1,
				winner: terminal.winner ?? null,
				illegalMoves,
				reason: "terminal",
				log: logIfNeeded(),
			};
			if (opts.enableDiagnostics) {
				getDiagnosticsCollector().endGame(result.winner, result.reason);
			}
			return result;
		}

		const legalMoves = Engine.listLegalMoves(state);
		if (!Array.isArray(legalMoves) || legalMoves.length === 0) {
			throw new Error(
				"Engine.listLegalMoves returned empty list — game cannot progress",
			);
		}

		/* ── batch turn path: bot.chooseTurn returns all moves for the turn ── */
		if (bot.chooseTurn) {
			let turnMoves: Move[];
			try {
				turnMoves = await bot.chooseTurn({ state, legalMoves, turn, rng });
			} catch (e) {
				illegalMoves++;
				if (!opts.autofixIllegal) {
					if (opts.verbose)
						console.error(`[turn ${turn}] bot ${bot.name} crashed (batch)`, e);
					const result: MatchResult = {
						seed: opts.seed,
						turns: turn - 1,
						winner: null,
						illegalMoves,
						reason: "illegal",
						log: logIfNeeded(),
					};
					if (opts.enableDiagnostics) {
						getDiagnosticsCollector().endGame(result.winner, result.reason);
					}
					return result;
				}
				turnMoves = [{ action: "end_turn" }];
			}

			for (const batchMove of turnMoves) {
				const midTerminal = Engine.isTerminal(state);
				if (midTerminal.ended) break;
				if (Engine.currentPlayer(state) !== bot.id) break;

				const currentLegal = Engine.listLegalMoves(state);
				if (currentLegal.length === 0) break;

				const isLegal = currentLegal.some(
					(m) =>
						safeJson(stripReasoning(m)) === safeJson(stripReasoning(batchMove)),
				);

				if (!isLegal) {
					illegalMoves++;
					if (opts.verbose)
						console.warn(
							`[turn ${turn}] batch move skipped: ${short(batchMove)}`,
						);
					continue; // skip this move
				}

				const engineBatchMove = stripReasoning(batchMove);
				const result = Engine.applyMove(state, engineBatchMove);
				engineEvents.push(...result.engineEvents);
				moves.push(engineBatchMove);
				if (result.ok) {
					state = result.state;
				}

				if (opts.verbose) {
					console.log(`[turn ${turn}] ${bot.name} -> ${short(batchMove)}`);
				}

				if (opts.enableDiagnostics) {
					getDiagnosticsCollector().logTurn(
						turn,
						bot.name,
						batchMove.action,
						state as unknown as {
							players: {
								A: { units: unknown[]; vp: number };
								B: { units: unknown[]; vp: number };
							};
						},
					);
				}
			}
			continue; // back to outer loop to re-check active player
		}

		/* ── single-move path: bot.chooseMove (unchanged) ── */
		let move: Move;
		try {
			move = await bot.chooseMove({ state, legalMoves, turn, rng });
		} catch (e) {
			illegalMoves++;
			if (!opts.autofixIllegal) {
				if (opts.verbose)
					console.error(`[turn ${turn}] bot ${bot.name} crashed`, e);
				const result: MatchResult = {
					seed: opts.seed,
					turns: turn - 1,
					winner: null,
					illegalMoves,
					reason: "illegal",
					log: logIfNeeded(),
				};
				if (opts.enableDiagnostics) {
					getDiagnosticsCollector().endGame(result.winner, result.reason);
				}
				return result;
			}
			move = legalMoves[0] as Move;
			if (opts.verbose)
				console.error(`[turn ${turn}] bot ${bot.name} crashed; fallback`, e);
		}

		const isLegal = legalMoves.some(
			(m) => safeJson(stripReasoning(m)) === safeJson(stripReasoning(move)),
		);
		if (!isLegal) {
			illegalMoves++;
			if (!opts.autofixIllegal) {
				if (opts.verbose)
					console.warn(`[turn ${turn}] bot ${bot.name} chose illegal move`);
				const result: MatchResult = {
					seed: opts.seed,
					turns: turn - 1,
					winner: null,
					illegalMoves,
					reason: "illegal",
					log: logIfNeeded(),
				};
				if (opts.enableDiagnostics) {
					getDiagnosticsCollector().endGame(result.winner, result.reason);
				}
				return result;
			}
			if (opts.verbose)
				console.warn(
					`[turn ${turn}] bot ${bot.name} chose illegal move; forcing legal`,
				);
			move = legalMoves[Math.floor(rng() * legalMoves.length)] as Move;
		}

		const engineMove = stripReasoning(move);
		const result = Engine.applyMove(state, engineMove);
		engineEvents.push(...result.engineEvents);
		moves.push(engineMove);
		if (!result.ok) {
			illegalMoves++;
			if (!opts.autofixIllegal) {
				const result: MatchResult = {
					seed: opts.seed,
					turns: turn - 1,
					winner: null,
					illegalMoves,
					reason: "illegal",
					log: logIfNeeded(),
				};
				if (opts.enableDiagnostics) {
					getDiagnosticsCollector().endGame(result.winner, result.reason);
				}
				return result;
			}
			if (opts.verbose)
				console.warn(`[turn ${turn}] engine rejected move; forcing legal`);
			const fallback = legalMoves[
				Math.floor(rng() * legalMoves.length)
			] as Move;
			const fallbackResult = Engine.applyMove(state, stripReasoning(fallback));
			engineEvents.push(...fallbackResult.engineEvents);
			moves.push(stripReasoning(fallback));
			if (fallbackResult.ok) {
				state = fallbackResult.state;
			} else {
				const result: MatchResult = {
					seed: opts.seed,
					turns: turn - 1,
					winner: null,
					illegalMoves,
					reason: "illegal",
					log: logIfNeeded(),
				};
				if (opts.enableDiagnostics) {
					getDiagnosticsCollector().endGame(result.winner, result.reason);
				}
				return result;
			}
		} else {
			state = result.state;
		}

		// Log turn diagnostics
		if (opts.enableDiagnostics) {
			getDiagnosticsCollector().logTurn(
				turn,
				bot.name,
				move.action,
				state as unknown as {
					players: {
						A: { units: unknown[]; vp: number };
						B: { units: unknown[]; vp: number };
					};
				},
			);
		}

		if (opts.verbose) {
			console.log(`[turn ${turn}] ${bot.name} -> ${short(move)}`);
		}
	}

	const result: MatchResult = {
		seed: opts.seed,
		turns: opts.maxTurns,
		winner: Engine.winner(state),
		illegalMoves,
		reason: "maxTurns",
		log: logIfNeeded(),
	};

	// End game diagnostics
	if (opts.enableDiagnostics) {
		getDiagnosticsCollector().endGame(result.winner, result.reason);
	}

	return result;
}

/**
 * Replays a recorded match log through the game engine to verify that applied moves, emitted engine events, and final state match the log.
 *
 * @param log - Recorded match data containing `seed`, `players`, `moves`, and optional `engineEvents` and `finalState`.
 * @returns `ok: true` if the replay matches the recorded events and final state; otherwise `ok: false` with an `error` message, and `mismatchAt` when engine events differ.
 */
export function replayMatch(log: MatchLog): {
	ok: boolean;
	mismatchAt?: number;
	error?: string;
} {
	let state = Engine.createInitialState(log.seed, log.players);
	const events: EngineEvent[] = [];

	for (let i = 0; i < log.moves.length; i++) {
		const result = Engine.applyMove(state, log.moves[i]);
		events.push(...result.engineEvents);
		if (result.ok) {
			state = result.state;
		}
	}

	if (log.engineEvents && safeJson(events) !== safeJson(log.engineEvents)) {
		const mismatchAt = firstMismatchIndex(events, log.engineEvents);
		return { ok: false, mismatchAt, error: "Engine events mismatch." };
	}

	if (log.finalState && safeJson(state) !== safeJson(log.finalState)) {
		return { ok: false, error: "Final state mismatch." };
	}

	return { ok: true };
}

/**
 * Remove any `reasoning` and `metadata` properties from a move object.
 *
 * @param m - The move that may include `reasoning` and/or `metadata`
 * @returns A copy of `m` with `reasoning` and `metadata` omitted
 */
function stripReasoning(m: Move): Move {
	const {
		reasoning: _,
		metadata: __,
		...rest
	} = m as Move & {
		reasoning?: string;
		metadata?: unknown;
	};
	return rest as Move;
}

/**
 * Serialize a value to JSON, falling back to its string form if JSON serialization fails.
 *
 * @param x - The value to serialize
 * @returns The JSON representation of `x` when possible, otherwise `String(x)`
 */
function safeJson(x: unknown): string {
	try {
		return JSON.stringify(x);
	} catch {
		return String(x);
	}
}

function firstMismatchIndex(a: unknown[], b: unknown[]): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		if (safeJson(a[i]) !== safeJson(b[i])) return i;
	}
	return len;
}

function short(x: unknown): string {
	const s = safeJson(x);
	return s.length > 140 ? s.slice(0, 140) + "…" : s;
}