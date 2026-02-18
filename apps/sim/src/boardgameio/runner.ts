import { Client } from "boardgame.io/dist/cjs/client.js";
import { Local } from "boardgame.io/dist/cjs/multiplayer.js";
import { encodeState } from "../bots/stateEncoder";
import {
	getDiagnosticsCollector,
	resetDiagnosticsCollector,
} from "../diagnostics/collector";
import { Engine } from "../engineAdapter";
import { mulberry32 } from "../rng";
import type { Bot, MatchLog, MatchResult, Move } from "../types";
import { applyEngineMoveChecked, mapActiveSideToPlayerID } from "./adapter";
import { ArtifactBuilder, sha256, stableStringify } from "./artifact";
import { createFightclawGame } from "./createGame";
import type {
	HarnessConfig,
	MoveValidationMode,
	ScenarioName,
	TurnMetricsV2,
	TurnPlanMeta,
} from "./types";

interface BoardgameRunnerOptions {
	seed: number;
	players: Bot[];
	maxTurns: number;
	verbose?: boolean;
	record?: boolean;
	enableDiagnostics?: boolean;
	engineConfig?: HarnessConfig["engineConfig"];
	scenario?: ScenarioName;
	invalidPolicy: HarnessConfig["invalidPolicy"];
	strict: boolean;
	moveValidationMode: MoveValidationMode;
	artifactDir?: string;
	storeFullPrompt: boolean;
	storeFullOutput: boolean;
}

/**
 * Runs a two-player boardgame.io match using the provided harness configuration and bots.
 *
 * The function executes up to `opts.maxTurns`, requesting turn plans from each bot, applying and validating moves
 * against the engine, handling illegal moves according to `opts.invalidPolicy`, collecting per-turn metrics and
 * explainability, writing artifacts (prompts, moves, metrics, and optional full logs), and optionally gathering
 * diagnostics. The client is always stopped when the match completes or an error occurs.
 *
 * @param opts - Configuration and runtime options for the match (seed, players, engine/scenario config, invalid-move policy, artifact/storage options, diagnostics and verbosity flags, etc.)
 * @returns The final MatchResult containing the seed, number of turns, winner (player id or `null` for draw), count of illegal moves, termination reason (`"terminal"`, `"illegal"`, or `"maxTurns"`), and an optional recorded log when recording is enabled.
 */
export async function playMatchBoardgameIO(
	opts: BoardgameRunnerOptions,
): Promise<MatchResult> {
	const rng = mulberry32(opts.seed);
	const playerIds = opts.players.map((p) => p.id);
	if (playerIds.length !== 2) {
		throw new Error("playMatchBoardgameIO requires exactly two players");
	}
	const playerPair: [string, string] = [
		String(playerIds[0]),
		String(playerIds[1]),
	];
	const harnessConfig: HarnessConfig = {
		seed: opts.seed,
		players: [playerIds[0], playerIds[1]],
		maxTurns: opts.maxTurns,
		engineConfig: opts.engineConfig,
		scenario: opts.scenario,
		invalidPolicy: opts.invalidPolicy,
		strict: opts.strict,
		moveValidationMode: opts.moveValidationMode,
		artifactDir: opts.artifactDir,
		storeFullPrompt: opts.storeFullPrompt,
		storeFullOutput: opts.storeFullOutput,
	};

	if (opts.enableDiagnostics) {
		resetDiagnosticsCollector();
		getDiagnosticsCollector().startGame(
			opts.seed,
			opts.players[0]?.name ?? "unknown",
			opts.players[1]?.name ?? "unknown",
		);
	}

	const client = Client({
		game: createFightclawGame(harnessConfig),
		numPlayers: 2,
		multiplayer: Local(),
	});
	client.start();

	const artifact = new ArtifactBuilder(harnessConfig);
	const acceptedMoves: Move[] = [];
	const engineEvents = [] as unknown[];
	let illegalMoves = 0;
	let completedTurns = 0;
	let forfeitWinner: string | null = null;
	let forfeitTriggered = false;

	try {
		for (let turnIndex = 1; turnIndex <= opts.maxTurns; turnIndex++) {
			const state = requireState(client.getState());
			const terminal = Engine.isTerminal(state.G.matchState);
			if (terminal.ended) {
				const result = finalizeResult({
					seed: opts.seed,
					turns: completedTurns,
					winner: terminal.winner ?? null,
					illegalMoves,
					reason: "terminal",
					state: state.G.matchState,
					acceptedMoves,
					engineEvents,
					playerPair,
					record: opts.record,
				});
				artifact.setResult(
					resultSummaryFromResult(result),
					hashState(state.G.matchState),
				);
				artifact.setBoardgameLog(state.log ?? null);
				artifact.write(opts.artifactDir);
				if (opts.enableDiagnostics) {
					getDiagnosticsCollector().endGame(result.winner, result.reason);
				}
				return result;
			}

			const activeAgent = Engine.currentPlayer(state.G.matchState);
			const actingPlayerID = state.ctx.currentPlayer;
			const expectedPlayerID = mapActiveSideToPlayerID(state.G.matchState);
			if (actingPlayerID !== expectedPlayerID) {
				const msg = `Harness divergence: ctx.currentPlayer=${actingPlayerID} expected=${expectedPlayerID}`;
				if (opts.strict) {
					throw new Error(msg);
				}
				console.warn(msg);
			}

			const bot = opts.players.find((p) => p.id === activeAgent);
			if (!bot) {
				throw new Error(`No bot for active player ${String(activeAgent)}`);
			}

			const legalMoves = Engine.listLegalMoves(state.G.matchState);
			const plan = await chooseTurnPlan({
				bot,
				turnIndex,
				legalMoves,
				state: state.G.matchState,
				rng,
				playerID: actingPlayerID,
			});
			const turnRecordIdx = artifact.startTurn(
				{
					turnIndex,
					prompt: opts.storeFullPrompt ? plan.meta.prompt : undefined,
					rawOutput: opts.storeFullOutput ? plan.meta.rawOutput : undefined,
					model: plan.meta.model,
				},
				actingPlayerID,
			);
			const initialExplainability = buildInitialTurnExplainability(
				plan.moves,
				plan.meta.rawOutput,
			);
			artifact.setTurnExplainability(turnRecordIdx, initialExplainability);
			const turnStartState = state.G.matchState;

			let turnComplete = false;
			let commandIndex = 0;

			for (const move of plan.moves) {
				const current = requireState(client.getState());
				const midTerminal = Engine.isTerminal(current.G.matchState);
				if (midTerminal.ended) {
					turnComplete = true;
					break;
				}
				if (Engine.currentPlayer(current.G.matchState) !== activeAgent) {
					turnComplete = true;
					break;
				}

				const preHash = hashState(current.G.matchState);
				const checked = applyEngineMoveChecked({
					state: current.G.matchState,
					move,
					validationMode: opts.moveValidationMode,
				});
				if (!checked.accepted) {
					illegalMoves++;
					artifact.recordCommandAttempt(turnRecordIdx, {
						commandIndex,
						move,
						accepted: false,
						rejectionReason: checked.rejectionReason,
					});
					if (opts.invalidPolicy === "forfeit") {
						forfeitTriggered = true;
						forfeitWinner = String(
							playerIds.find((id) => id !== activeAgent) ?? "",
						);
						turnComplete = true;
						break;
					}
					if (opts.invalidPolicy === "stop_turn") {
						turnComplete = true;
						break;
					}
					commandIndex++;
					continue;
				}

				client.updatePlayerID(actingPlayerID);
				client.moves.applyMove({
					move,
					turnIndex,
					commandIndex,
				});

				const next = requireState(client.getState());
				const postHash = hashState(next.G.matchState);
				artifact.recordCommandAttempt(turnRecordIdx, {
					commandIndex,
					move,
					accepted: true,
				});
				const engineMove = stripMoveAnnotations(move);
				artifact.recordAcceptedMove({
					ply: acceptedMoves.length + 1,
					playerID: actingPlayerID,
					engineMove,
					preHash,
					postHash,
				});
				acceptedMoves.push(engineMove);

				if (opts.enableDiagnostics) {
					getDiagnosticsCollector().logTurn(
						turnIndex,
						bot.name,
						move.action,
						next.G.matchState as unknown as {
							players: {
								A: { units: unknown[]; vp: number };
								B: { units: unknown[]; vp: number };
							};
						},
					);
				}
				if (opts.verbose) {
					console.log(
						`[bgio turn ${turnIndex}] ${bot.name} -> ${JSON.stringify(move)}`,
					);
				}

				if (Engine.currentPlayer(next.G.matchState) !== activeAgent) {
					turnComplete = true;
					break;
				}
				commandIndex++;
			}

			// Ensure each harness "turn" closes the active player's engine turn.
			// This avoids counting partial turns (single move plans with AP remaining)
			// as full turns, which can artificially inflate maxTurns endings.
			if (!forfeitTriggered) {
				const current = requireState(client.getState());
				const midTerminal = Engine.isTerminal(current.G.matchState);
				const stillActive =
					!midTerminal.ended &&
					Engine.currentPlayer(current.G.matchState) === activeAgent &&
					current.G.matchState.actionsRemaining > 0;

				if (stillActive) {
					const forcedEndTurn: Move = { action: "end_turn" };
					const checked = applyEngineMoveChecked({
						state: current.G.matchState,
						move: forcedEndTurn,
						validationMode: opts.moveValidationMode,
					});

					if (checked.accepted) {
						client.updatePlayerID(actingPlayerID);
						client.moves.applyMove({
							move: forcedEndTurn,
							turnIndex,
							commandIndex,
						});
						artifact.recordCommandAttempt(turnRecordIdx, {
							commandIndex,
							move: forcedEndTurn,
							accepted: true,
						});
						acceptedMoves.push(forcedEndTurn);
						turnComplete = true;
					} else {
						illegalMoves++;
						artifact.recordCommandAttempt(turnRecordIdx, {
							commandIndex,
							move: forcedEndTurn,
							accepted: false,
							rejectionReason: checked.rejectionReason,
						});
						if (opts.invalidPolicy === "forfeit") {
							forfeitTriggered = true;
							forfeitWinner = String(
								playerIds.find((id) => id !== activeAgent) ?? "",
							);
						}
						if (opts.invalidPolicy === "stop_turn") {
							turnComplete = true;
						}
					}
				}
			}

			if (forfeitTriggered) {
				break;
			}

			const afterBatch = requireState(client.getState());
			const afterTerminal = Engine.isTerminal(afterBatch.G.matchState);
			const engineChangedPlayer =
				Engine.currentPlayer(afterBatch.G.matchState) !== activeAgent;
			const engineTurnComplete =
				turnComplete || afterTerminal.ended || engineChangedPlayer;

			if (
				!afterTerminal.ended &&
				engineTurnComplete &&
				afterBatch.ctx.currentPlayer === actingPlayerID
			) {
				client.updatePlayerID(actingPlayerID);
				client.events.endTurn?.();
				const postTurn = requireState(client.getState());
				const mapped = mapActiveSideToPlayerID(postTurn.G.matchState);
				if (mapped !== postTurn.ctx.currentPlayer) {
					const msg = `Post-endTurn divergence: ctx.currentPlayer=${postTurn.ctx.currentPlayer} expected=${mapped}`;
					if (opts.strict) {
						throw new Error(msg);
					}
					console.warn(msg);
				}
			}

			const turnEndState = requireState(client.getState()).G.matchState;
			const turnMetrics = buildTurnMetricsV2(
				turnStartState,
				turnEndState,
				actingPlayerID,
				artifact.getTurnCommandAttempts(turnRecordIdx),
			);
			artifact.setTurnMetrics(turnRecordIdx, turnMetrics);
			artifact.setTurnExplainability(
				turnRecordIdx,
				buildMetricsExplainability(
					turnMetrics,
					artifact.getTurnCommandAttempts(turnRecordIdx),
				),
			);

			completedTurns = turnIndex;
		}

		const finalState = requireState(client.getState());
		const finalTerminal = Engine.isTerminal(finalState.G.matchState);
		const result: MatchResult = forfeitTriggered
			? finalizeResult({
					seed: opts.seed,
					turns: completedTurns,
					winner: forfeitWinner,
					illegalMoves,
					reason: "illegal",
					state: finalState.G.matchState,
					acceptedMoves,
					engineEvents,
					playerPair,
					record: opts.record,
				})
			: finalTerminal.ended
				? finalizeResult({
						seed: opts.seed,
						turns: completedTurns,
						winner: finalTerminal.winner ?? null,
						illegalMoves,
						reason: "terminal",
						state: finalState.G.matchState,
						acceptedMoves,
						engineEvents,
						playerPair,
						record: opts.record,
					})
				: finalizeResult({
						seed: opts.seed,
						turns: opts.maxTurns,
						winner: Engine.winner(finalState.G.matchState),
						illegalMoves,
						reason: "maxTurns",
						state: finalState.G.matchState,
						acceptedMoves,
						engineEvents,
						playerPair,
						record: opts.record,
					});

		artifact.setResult(
			resultSummaryFromResult(result),
			hashState(finalState.G.matchState),
		);
		artifact.setBoardgameLog(finalState.log ?? null);
		artifact.write(opts.artifactDir);

		if (opts.enableDiagnostics) {
			getDiagnosticsCollector().endGame(result.winner, result.reason);
		}
		return result;
	} finally {
		client.stop();
	}
}

/**
 * Asserts that the provided client state is not null and returns it.
 *
 * @param state - The client state to check.
 * @returns The same `state` value, guaranteed to be non-null.
 * @throws Error if `state` is null.
 */
function requireState<T>(state: T | null): T {
	if (!state) {
		throw new Error("boardgame client state is null");
	}
	return state;
}

/**
 * Compute a deterministic SHA-256 hash of the given state.
 *
 * @param state - The value to hash; serialized with a stable JSON stringifier.
 * @returns The hexadecimal SHA-256 digest of the serialized `state`.
 */
function hashState(state: unknown): string {
	return sha256(stableStringify(state));
}

/**
 * Create a concise summary extracting the winner, reason, turns, and illegalMoves from a MatchResult.
 *
 * @param result - The full match result to summarize
 * @returns An object with `winner`, `reason`, `turns`, and `illegalMoves` fields
 */
function resultSummaryFromResult(result: MatchResult) {
	return {
		winner: result.winner,
		reason: result.reason,
		turns: result.turns,
		illegalMoves: result.illegalMoves,
	};
}

/**
 * Create a shallow copy of a Move with `reasoning` and `metadata` fields removed.
 *
 * @param move - The move to clean; may include optional `reasoning` or `metadata` annotations
 * @returns The same move shape with `reasoning` and `metadata` properties omitted
 */
function stripMoveAnnotations(move: Move): Move {
	const clean = {
		...(move as Move & { reasoning?: string; metadata?: unknown }),
	};
	delete clean.reasoning;
	delete clean.metadata;
	return clean as Move;
}

/**
 * Builds initial explainability data for a turn using committed moves and optional raw model output.
 *
 * @param moves - The sequence of attempted moves for the turn.
 * @param rawOutput - Optional raw textual output from the bot/model; used to extract a declared plan and reasoning when present.
 * @returns An object with optional `declaredPlan` (short plan summary or extracted plan) and `whyThisMove` (short rationale for the chosen move).
 */
function buildInitialTurnExplainability(
	moves: Move[],
	rawOutput?: string,
): {
	declaredPlan?: string;
	whyThisMove?: string;
} {
	const declaredFromOutput = extractDeclaredPlan(rawOutput);
	const declaredFromMoves = summarizePlanFromMoves(moves);
	const whyFromMoves = extractWhyThisMoveFromMoves(moves);
	const whyFromOutput = extractReasoningFromOutput(rawOutput);
	return {
		declaredPlan: declaredFromOutput ?? declaredFromMoves,
		whyThisMove: whyFromMoves ?? whyFromOutput,
	};
}

/**
 * Derives explainability signals for a completed turn using computed metrics and the recorded move attempts.
 *
 * @param metrics - Aggregated turn metrics (combat, resources, position, etc.) used to evaluate swings and power spikes
 * @param attempts - Sequence of attempted moves with their acceptance status; used to extract any available "why this move" rationale
 * @returns An object containing:
 *  - `powerSpikeTriggered`: `true` if the turn exhibits a significant tactical/strategic swing,
 *  - `swingEvent`: an optional short label describing the type of swing detected (e.g., unit trade, HP swing, VP swing, decisive),
 *  - `whyThisMove`: an optional extracted explanation string from the provided attempts
 */
function buildMetricsExplainability(
	metrics: TurnMetricsV2,
	attempts: Array<{ accepted: boolean; move: Move }>,
): {
	powerSpikeTriggered: boolean;
	swingEvent?: string;
	whyThisMove?: string;
} {
	const enemyUnitsLost = Math.max(0, -metrics.combat.enemyUnitsDelta);
	const ownUnitsLost = Math.max(0, -metrics.combat.ownUnitsDelta);
	const enemyHpLoss = Math.max(0, -metrics.combat.enemyHpDelta);
	const ownHpLoss = Math.max(0, -metrics.combat.ownHpDelta);
	const vpSwing = metrics.resources.ownVpDelta - metrics.resources.enemyVpDelta;
	const swingScore =
		(enemyUnitsLost - ownUnitsLost) * 6 +
		(enemyHpLoss - ownHpLoss) +
		vpSwing * 5 +
		(metrics.combat.finisherSuccesses > 0 ? 4 : 0);

	const powerSpikeTriggered =
		swingScore >= 8 ||
		(metrics.combat.favorableTrade &&
			(enemyHpLoss >= 4 || enemyUnitsLost >= 1 || vpSwing >= 2));

	let swingEvent: string | undefined;
	if (swingScore >= 12) {
		swingEvent = `decisive_swing(score=${swingScore})`;
	} else if (enemyUnitsLost > ownUnitsLost && enemyUnitsLost > 0) {
		swingEvent = `unit_trade(enemy=${enemyUnitsLost},own=${ownUnitsLost})`;
	} else if (enemyHpLoss - ownHpLoss >= 4) {
		swingEvent = `hp_swing(net=${enemyHpLoss - ownHpLoss})`;
	} else if (vpSwing >= 2) {
		swingEvent = `vp_swing(net=${vpSwing})`;
	}

	return {
		powerSpikeTriggered,
		swingEvent,
		whyThisMove: extractWhyThisMoveFromAttempts(attempts),
	};
}

/**
 * Extracts the declared plan from raw model output by taking the text before a `---` delimiter, selecting up to three non-empty, non-comment lines, and joining them with ` | `.
 *
 * @param rawOutput - Raw text that may include a plan and an optional reasoning section separated by `---`.
 * @returns The extracted plan string clipped to 220 characters, or `undefined` if no plan lines are present.
 */
function extractDeclaredPlan(rawOutput?: string): string | undefined {
	if (!rawOutput) return undefined;
	const commandBlock = rawOutput.split("---")[0] ?? rawOutput;
	const lines = commandBlock
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
		.slice(0, 3);
	if (lines.length === 0) return undefined;
	return clipText(lines.join(" | "), 220);
}

/**
 * Builds a short textual summary of the first up to five moves.
 *
 * @param moves - The sequence of moves to summarize; only the first five moves are included
 * @returns The moves joined with `" -> "` and clipped to 220 characters, or `undefined` if `moves` is empty
 */
function summarizePlanFromMoves(moves: Move[]): string | undefined {
	if (moves.length === 0) return undefined;
	const summary = moves
		.slice(0, 5)
		.map((move) => summarizeMove(move))
		.join(" -> ");
	return clipText(summary, 220);
}

/**
 * Produces a concise human-readable snippet summarizing the given move.
 *
 * @returns A short textual description of the move formatted by action, e.g. "attack <unitId> <target>", "move <unitId> <to>", "recruit <unitType> <at>", "fortify <unitId>", "upgrade <unitId>", or the raw action string for unknown actions.
 */
function summarizeMove(move: Move): string {
	switch (move.action) {
		case "attack":
			return `attack ${move.unitId} ${move.target}`;
		case "move":
			return `move ${move.unitId} ${move.to}`;
		case "recruit":
			return `recruit ${move.unitType} ${move.at}`;
		case "fortify":
			return `fortify ${move.unitId}`;
		case "upgrade":
			return `upgrade ${move.unitId}`;
		default:
			return move.action;
	}
}

/**
 * Extracts the reasoning section that follows a '---' delimiter in a model's raw output.
 *
 * If `rawOutput` contains one or more '---' separators, returns the trimmed text after the first '---', clipped to 240 characters; otherwise returns `undefined`.
 *
 * @param rawOutput - Full raw text output from a model or bot, optionally containing '---' as a delimiter before a reasoning section
 * @returns The reasoning text trimmed and clipped to 240 characters, or `undefined` if no reasoning section is present
 */
function extractReasoningFromOutput(rawOutput?: string): string | undefined {
	if (!rawOutput) return undefined;
	const sections = rawOutput.split("---");
	if (sections.length < 2) return undefined;
	const reasoning = sections.slice(1).join("---").trim();
	return reasoning.length > 0 ? clipText(reasoning, 240) : undefined;
}

/**
 * Finds the first "why this move" explanation from accepted move attempts, falling back to all attempts if none are accepted.
 *
 * @param attempts - Ordered list of move attempts, each with an `accepted` flag and a `move` object
 * @returns The first found explanation string, or `undefined` if no explanation is present on any attempted move
 */
function extractWhyThisMoveFromAttempts(
	attempts: Array<{ accepted: boolean; move: Move }>,
): string | undefined {
	const accepted = attempts.filter((attempt) => attempt.accepted);
	const preferred = accepted.length > 0 ? accepted : attempts;
	for (const attempt of preferred) {
		const why = extractWhyThisMoveFromMove(attempt.move);
		if (why) return why;
	}
	return undefined;
}

/**
 * Finds the first available "whyThisMove" explanation in the provided moves.
 *
 * @param moves - Moves to search in order for a `whyThisMove` explanation
 * @returns The first `whyThisMove` string found, or `undefined` if none exist
 */
function extractWhyThisMoveFromMoves(moves: Move[]): string | undefined {
	for (const move of moves) {
		const why = extractWhyThisMoveFromMove(move);
		if (why) return why;
	}
	return undefined;
}

/**
 * Extracts a concise "why this move" explanation from a move's annotations.
 *
 * @param move - The move which may include `reasoning` or `metadata.whyThisMove`
 * @returns The extracted explanation trimmed and clipped to 240 characters, or `undefined` if no explanation is present
 */
function extractWhyThisMoveFromMove(move: Move): string | undefined {
	const annotated = move as Move & {
		reasoning?: string;
		metadata?: { whyThisMove?: string };
	};
	const why = annotated.metadata?.whyThisMove ?? annotated.reasoning;
	if (!why || why.trim().length === 0) return undefined;
	return clipText(why.trim(), 240);
}

/**
 * Truncates a string to fit within a character budget and appends an ellipsis when truncation occurs.
 *
 * @param input - The original text to potentially truncate.
 * @param maxChars - Maximum allowed length of the returned string.
 * @returns The original `input` if its length is less than or equal to `maxChars`; otherwise the string formed by taking the first `maxChars - 3` characters of `input` and appending `...`. Note: if `maxChars` is less than or equal to 3, the returned value will contain fewer (or zero) characters from `input` before the ellipsis. 
 */
function clipText(input: string, maxChars: number): string {
	if (input.length <= maxChars) return input;
	return `${input.slice(0, maxChars - 3)}...`;
}

/**
 * Compute a structured set of metrics describing a player's turn by comparing game state before and after and summarizing attempted moves.
 *
 * @param before - Game state snapshot immediately before the turn began.
 * @param after - Game state snapshot immediately after the turn ended.
 * @param playerID - ID of the player whose turn is being evaluated.
 * @param attempts - Sequence of attempted moves for the turn; each entry indicates whether the move was accepted and contains the move.
 * @returns A TurnMetricsV2 object containing:
 *  - side: which side (`"A"` or `"B"`) corresponds to `playerID`.
 *  - actions: counts of accepted and rejected attempts and breakdowns by action type.
 *  - combat: attack-related metrics (accepted attacks, finisher opportunities/successes, HP/unit deltas, and whether the exchange was a favorable trade).
 *  - position: average distance to the enemy stronghold before and after the turn and the delta when available.
 *  - resources: resource deltas (gold, wood, victory points) for both players.
 *  - upgrade: estimated upgrade-related metrics including number of upgrades accepted and estimated gold/wood spent.
 */
function buildTurnMetricsV2(
	before: Parameters<Bot["chooseMove"]>[0]["state"],
	after: Parameters<Bot["chooseMove"]>[0]["state"],
	playerID: string,
	attempts: Array<{ accepted: boolean; move: Move }>,
): TurnMetricsV2 {
	const side = before.players.A.id === playerID ? "A" : "B";
	const enemySide = side === "A" ? "B" : "A";
	const accepted = attempts.filter((a) => a.accepted);
	const rejected = attempts.filter((a) => !a.accepted);
	const byTypeAccepted: Record<string, number> = {};
	const byTypeRejected: Record<string, number> = {};
	for (const a of accepted) {
		byTypeAccepted[a.move.action] = (byTypeAccepted[a.move.action] ?? 0) + 1;
	}
	for (const a of rejected) {
		byTypeRejected[a.move.action] = (byTypeRejected[a.move.action] ?? 0) + 1;
	}

	const beforeOwn = before.players[side];
	const beforeEnemy = before.players[enemySide];
	const afterOwn = after.players[side];
	const afterEnemy = after.players[enemySide];

	const beforeEnemyByPos = new Map(
		beforeEnemy.units.map((u) => [u.position, u]),
	);
	const afterEnemyIds = new Set(afterEnemy.units.map((u) => u.id));
	const acceptedAttacks = accepted.filter((a) => a.move.action === "attack");
	let finisherOpportunities = 0;
	let finisherSuccesses = 0;
	for (const a of acceptedAttacks) {
		if (a.move.action !== "attack") continue;
		const target = beforeEnemyByPos.get(a.move.target);
		if (!target) continue;
		if (target.hp <= 1) {
			finisherOpportunities++;
			if (!afterEnemyIds.has(target.id)) {
				finisherSuccesses++;
			}
		}
	}

	const beforeEnemyHp = sumHp(beforeEnemy.units);
	const beforeOwnHp = sumHp(beforeOwn.units);
	const afterEnemyHp = sumHp(afterEnemy.units);
	const afterOwnHp = sumHp(afterOwn.units);
	const enemyHpDelta = afterEnemyHp - beforeEnemyHp;
	const ownHpDelta = afterOwnHp - beforeOwnHp;
	const enemyUnitsDelta = afterEnemy.units.length - beforeEnemy.units.length;
	const ownUnitsDelta = afterOwn.units.length - beforeOwn.units.length;
	const enemyHpLoss = beforeEnemyHp - afterEnemyHp;
	const ownHpLoss = beforeOwnHp - afterOwnHp;
	const enemyUnitsLost = beforeEnemy.units.length - afterEnemy.units.length;
	const ownUnitsLost = beforeOwn.units.length - afterOwn.units.length;
	const favorableTrade =
		enemyHpLoss > ownHpLoss || enemyUnitsLost > ownUnitsLost;

	const startAvgDist = avgDistanceToEnemyStronghold(before, side);
	const endAvgDist = avgDistanceToEnemyStronghold(after, side);
	const upgradeSpend = estimateUpgradeSpend(before, side, accepted);

	return {
		side,
		actions: {
			accepted: accepted.length,
			rejected: rejected.length,
			byTypeAccepted,
			byTypeRejected,
		},
		combat: {
			attacksAccepted: acceptedAttacks.length,
			finisherOpportunities,
			finisherSuccesses,
			enemyHpDelta,
			ownHpDelta,
			enemyUnitsDelta,
			ownUnitsDelta,
			favorableTrade,
		},
		position: {
			startAvgDistToEnemyStronghold: startAvgDist,
			endAvgDistToEnemyStronghold: endAvgDist,
			deltaAvgDistToEnemyStronghold:
				startAvgDist !== null && endAvgDist !== null
					? endAvgDist - startAvgDist
					: null,
		},
		resources: {
			ownGoldDelta: afterOwn.gold - beforeOwn.gold,
			ownWoodDelta: afterOwn.wood - beforeOwn.wood,
			enemyGoldDelta: afterEnemy.gold - beforeEnemy.gold,
			enemyWoodDelta: afterEnemy.wood - beforeEnemy.wood,
			ownVpDelta: afterOwn.vp - beforeOwn.vp,
			enemyVpDelta: afterEnemy.vp - beforeEnemy.vp,
		},
		upgrade: {
			upgradesAccepted: upgradeSpend.upgradesAccepted,
			estimatedGoldSpend: upgradeSpend.estimatedGoldSpend,
			estimatedWoodSpend: upgradeSpend.estimatedWoodSpend,
		},
	};
}

/**
 * Estimates the number and resource cost of accepted `upgrade` moves for a given side.
 *
 * @param before - Game state snapshot used to resolve unit IDs and types
 * @param side - Which player's side (`"A"` or `"B"`) to evaluate upgrades for
 * @param accepted - Array of move attempts (each with `accepted` and `move`); only accepted moves with `action === "upgrade"` are counted
 * @returns An object with:
 *  - `upgradesAccepted`: count of accepted upgrade moves that matched a unit on `side`
 *  - `estimatedGoldSpend`: summed estimated gold cost for those upgrades
 *  - `estimatedWoodSpend`: summed estimated wood cost for those upgrades
 */
function estimateUpgradeSpend(
	before: Parameters<Bot["chooseMove"]>[0]["state"],
	side: "A" | "B",
	accepted: Array<{ accepted: boolean; move: Move }>,
): {
	upgradesAccepted: number;
	estimatedGoldSpend: number;
	estimatedWoodSpend: number;
} {
	const unitById = new Map(before.players[side].units.map((u) => [u.id, u]));
	let upgradesAccepted = 0;
	let estimatedGoldSpend = 0;
	let estimatedWoodSpend = 0;
	for (const a of accepted) {
		if (a.move.action !== "upgrade") continue;
		const unit = unitById.get(a.move.unitId);
		if (!unit) continue;
		upgradesAccepted++;
		if (unit.type === "infantry") {
			estimatedGoldSpend += 9;
			estimatedWoodSpend += 3;
		} else if (unit.type === "cavalry") {
			estimatedGoldSpend += 15;
			estimatedWoodSpend += 5;
		} else if (unit.type === "archer") {
			estimatedGoldSpend += 12;
			estimatedWoodSpend += 4;
		}
	}
	return {
		upgradesAccepted,
		estimatedGoldSpend,
		estimatedWoodSpend,
	};
}

/**
 * Compute the total hit points of a list of units.
 *
 * @param units - Array of objects containing an `hp` numeric property
 * @returns The sum of all units' `hp` values (0 if the array is empty)
 */
function sumHp(units: Array<{ hp: number }>): number {
	return units.reduce((s, u) => s + u.hp, 0);
}

/**
 * Compute the average distance in board columns from the specified side's units to the enemy stronghold.
 *
 * @param state - Game state containing board hexes and player unit positions.
 * @param side - The side ("A" or "B") whose units will be measured.
 * @returns The average absolute column distance to the enemy stronghold, or `null` if the enemy stronghold, unit positions, or column data are unavailable.
 */
function avgDistanceToEnemyStronghold(
	state: Parameters<Bot["chooseMove"]>[0]["state"],
	side: "A" | "B",
): number | null {
	const enemyStrongholdType = side === "A" ? "stronghold_b" : "stronghold_a";
	const enemyStrongholdCols = state.board
		.filter((h) => h.type === enemyStrongholdType)
		.map((h) => parseCol(h.id))
		.filter((v): v is number => v !== null);
	if (enemyStrongholdCols.length === 0) return null;
	const targetCol = Math.min(...enemyStrongholdCols);
	const ownUnits = state.players[side].units;
	if (ownUnits.length === 0) return null;
	const dists = ownUnits
		.map((u) => parseCol(u.position))
		.filter((v): v is number => v !== null)
		.map((col) => Math.abs(col - targetCol));
	if (dists.length === 0) return null;
	return dists.reduce((s, d) => s + d, 0) / dists.length;
}

/**
 * Extracts the numeric column index from a hex-style tile identifier.
 *
 * @param hexId - Tile identifier expected to start with a letter followed by digits (e.g., "A12")
 * @returns The parsed column number, or `null` if the identifier does not contain a valid number
 */
function parseCol(hexId: string): number | null {
	const n = Number.parseInt(hexId.replace(/^[A-Z]/i, ""), 10);
	return Number.isFinite(n) ? n : null;
}

/**
 * Selects a turn plan for the given bot for a specific turn.
 *
 * The function prefers bot implementations in this order: `chooseTurnWithMeta`, `chooseTurn`, then `chooseMove`.
 * When available, metadata returned by the bot (`prompt`, `rawOutput`, `model`) is included in the result; otherwise a fallback prompt is generated by encoding the current state for the bot's side.
 *
 * @param opts.bot - The bot instance to query for a plan.
 * @param opts.playerID - The player ID used to determine the bot's side when producing a fallback prompt.
 * @returns An object containing `moves` (the chosen move sequence) and `meta` (turnIndex and prompt; may also include `rawOutput` and `model` when provided by the bot).
 */
async function chooseTurnPlan(opts: {
	bot: Bot;
	state: BoardgameRunnerOptions["engineConfig"] extends never
		? never
		: Parameters<Bot["chooseMove"]>[0]["state"];
	legalMoves: Move[];
	turnIndex: number;
	rng: () => number;
	playerID: string;
}): Promise<{ moves: Move[]; meta: TurnPlanMeta }> {
	const side = opts.state.players.A.id === opts.playerID ? "A" : "B";
	const fallbackPrompt = encodeState(opts.state, side);
	const detailed = opts.bot as Bot & {
		chooseTurnWithMeta?: (ctx: {
			state: Parameters<Bot["chooseMove"]>[0]["state"];
			legalMoves: Move[];
			turn: number;
			rng: () => number;
		}) => Promise<{
			moves: Move[];
			prompt?: string;
			rawOutput?: string;
			model?: string;
		}>;
	};

	if (detailed.chooseTurnWithMeta) {
		const r = await detailed.chooseTurnWithMeta({
			state: opts.state,
			legalMoves: opts.legalMoves,
			turn: opts.turnIndex,
			rng: opts.rng,
		});
		return {
			moves: r.moves,
			meta: {
				turnIndex: opts.turnIndex,
				prompt: r.prompt ?? fallbackPrompt,
				rawOutput: r.rawOutput,
				model: r.model,
			},
		};
	}

	if (opts.bot.chooseTurn) {
		const moves = await opts.bot.chooseTurn({
			state: opts.state,
			legalMoves: opts.legalMoves,
			turn: opts.turnIndex,
			rng: opts.rng,
		});
		return {
			moves,
			meta: { turnIndex: opts.turnIndex, prompt: fallbackPrompt },
		};
	}

	const move = await opts.bot.chooseMove({
		state: opts.state,
		legalMoves: opts.legalMoves,
		turn: opts.turnIndex,
		rng: opts.rng,
	});
	return {
		moves: [move],
		meta: { turnIndex: opts.turnIndex, prompt: fallbackPrompt },
	};
}

/**
 * Builds a MatchResult from run data and conditionally attaches a MatchLog when recording.
 *
 * @param input - Run summary including seed, turns, winner, illegalMoves, termination reason, final state, accepted moves, engine events, player pair, and optional `record` flag
 * @returns The assembled MatchResult. If `input.record` is true, `log` contains `seed`, `players`, `moves`, `engineEvents`, and `finalState`; otherwise `log` is undefined.
 */
function finalizeResult(input: {
	seed: number;
	turns: number;
	winner: string | null;
	illegalMoves: number;
	reason: "terminal" | "maxTurns" | "illegal";
	state: unknown;
	acceptedMoves: Move[];
	engineEvents: unknown[];
	playerPair: [string, string];
	record?: boolean;
}): MatchResult {
	const log: MatchLog | undefined = input.record
		? {
				seed: input.seed,
				players: input.playerPair,
				moves: [...input.acceptedMoves],
				engineEvents: input.engineEvents as never,
				finalState: input.state as never,
			}
		: undefined;

	return {
		seed: input.seed,
		turns: input.turns,
		winner: input.winner,
		illegalMoves: input.illegalMoves,
		reason: input.reason,
		log,
	};
}