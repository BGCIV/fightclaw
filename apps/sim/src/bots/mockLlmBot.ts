import * as fs from "node:fs";
import * as path from "node:path";
import { pickOne } from "../rng";
import type { Bot, MatchState, Move } from "../types";
import {
	type ArchetypeConfig,
	type BotPhase,
	DEFAULT_PHASE_POLICY,
	MOCK_LLM_ARCHETYPES,
	type MockLlmArchetypeName,
	type UtilityTerm,
} from "./mockLlmArchetypes";

type LegacyStrategy = "aggressive" | "defensive" | "random" | "strategic";
type StrategyLike = LegacyStrategy | MockLlmArchetypeName;

interface MoveUtilityBreakdown {
	archetype: MockLlmArchetypeName | "random";
	phase: BotPhase;
	phaseTriggers: string[];
	baseActionBias: number;
	phaseActionBias: number;
	promptBonus: number;
	policyAdjustments: number;
	termsRaw: Record<UtilityTerm, number>;
	termWeights: Record<UtilityTerm, number>;
	termsWeighted: Record<UtilityTerm, number>;
	total: number;
}

interface MoveMetadata {
	whyThisMove: string;
	breakdown: MoveUtilityBreakdown;
}

interface MoveCandidate {
	move: Move;
	metadata: MoveMetadata;
}

/** Configuration for mock LLM bot */
export interface MockLlmConfig {
	/** Inline prompt instructions (e.g., "Always attack first") */
	inline?: string;
	/** Path to JSON file with prompt config */
	file?: string;
	/** Strategy pattern (legacy or direct archetype) */
	strategy?: StrategyLike;
	/** Explicit archetype override */
	archetype?: MockLlmArchetypeName;
}

/** File-based prompt config */
interface PromptFileConfig {
	botId: string;
	inline?: string;
	strategy?: StrategyLike;
	archetype?: MockLlmArchetypeName;
}

interface PromptIntents {
	attack: boolean;
	defend: boolean;
	recruit: boolean;
	advance: boolean;
}

interface ScoringContext {
	move: Move;
	state: MatchState;
	side: "A" | "B";
	archetype: ArchetypeConfig;
	phase: BotPhase;
	phaseTriggers: string[];
	turn: number;
	promptIntents: PromptIntents;
	hasPlayableAlternatives: boolean;
	hasLegalAttack: boolean;
}

/**
 * Load and parse a prompt file into a PromptFileConfig.
 *
 * @param filePath - Absolute or relative path to a JSON file containing a PromptFileConfig
 * @returns The parsed PromptFileConfig
 */
function loadPromptFromFile(filePath: string): PromptFileConfig {
	const absolutePath = path.isAbsolute(filePath)
		? filePath
		: path.resolve(process.cwd(), filePath);
	const content = fs.readFileSync(absolutePath, "utf-8");
	return JSON.parse(content) as PromptFileConfig;
}

/**
 * Determine whether any of the given substrings appear in the target string.
 *
 * @param haystack - The string to search within
 * @param needles - Substrings to search for
 * @returns `true` if at least one substring in `needles` is contained in `haystack`, `false` otherwise.
 */
function includesAny(haystack: string, needles: string[]): boolean {
	return needles.some((needle) => haystack.includes(needle));
}

/**
 * Infers intent flags (attack, defend, recruit, advance) from free-form prompt instructions.
 *
 * @param promptInstructions - Free-form prompt or instructions to parse for intent keywords; may be undefined.
 * @returns `PromptIntents` with each flag set to `true` if the corresponding intent is detected in the input, `false` otherwise.
 */
function parsePromptIntents(promptInstructions?: string): PromptIntents {
	if (!promptInstructions) {
		return {
			attack: false,
			defend: false,
			recruit: false,
			advance: false,
		};
	}

	const lower = promptInstructions.toLowerCase();
	return {
		attack: includesAny(lower, [
			"attack",
			"eliminate",
			"kill",
			"finish",
			"counterattack",
			"focus fire",
			"damaged enem",
		]),
		defend: includesAny(lower, [
			"defend",
			"protect",
			"hold",
			"formation",
			"fortify",
		]),
		recruit: includesAny(lower, [
			"recruit",
			"reinforce",
			"build",
			"train",
			"economy",
		]),
		advance: includesAny(lower, [
			"advance",
			"press",
			"push",
			"stronghold",
			"capture",
			"frontline",
		]),
	};
}

/**
 * Determine which side ("A" or "B") a player id belongs to in the given match state.
 *
 * @param state - The current match state containing players A and B
 * @param id - The player id to locate
 * @returns `"A"` if `id` matches the A-side player, `"B"` otherwise
 */
function inferSide(state: MatchState, id: string): "A" | "B" {
	return String(state.players.A.id) === String(id) ? "A" : "B";
}

/**
 * Extracts the numeric column index from a hex identifier.
 *
 * @param hexId - Hex identifier expected to contain a leading character followed by a number (e.g., "h12")
 * @returns The numeric column index parsed from `hexId`, or 0 if the numeric part is not a finite number
 */
function colIndex(hexId: string): number {
	const value = Number(hexId.slice(1));
	return Number.isFinite(value) ? value : 0;
}

/**
 * Locate a unit by its id within either player's unit list.
 *
 * @param state - The match state containing both players and their units
 * @param unitId - The id of the unit to find
 * @returns The unit with the matching id, or `null` if no such unit exists
 */
function findUnit(state: MatchState, unitId: string) {
	for (const unit of state.players.A.units) {
		if (unit.id === unitId) return unit;
	}
	for (const unit of state.players.B.units) {
		if (unit.id === unitId) return unit;
	}
	return null;
}

/**
 * Retrieves units belonging to the opponent of the given side that occupy the specified hex.
 *
 * @param state - The current match state
 * @param side - The perspective side ("A" or "B"); units returned belong to the opposite side
 * @param hexId - The hex identifier to inspect
 * @returns An array of enemy units located on `hexId` (empty if none)
 */
function enemyUnitsAtHex(state: MatchState, side: "A" | "B", hexId: string) {
	const enemy = side === "A" ? state.players.B : state.players.A;
	return enemy.units.filter((unit) => unit.position === hexId);
}

/**
 * Retrieve friendly units for the given side that occupy a specific hex.
 *
 * @param state - Current match state
 * @param side - The side ("A" or "B") whose units to return
 * @param hexId - Hex identifier to match unit positions against
 * @returns An array of units from the specified side that are located on `hexId`
 */
function friendlyUnitsAtHex(state: MatchState, side: "A" | "B", hexId: string) {
	const own = side === "A" ? state.players.A : state.players.B;
	return own.units.filter((unit) => unit.position === hexId);
}

/**
 * Get the terrain/type of a board hex by its id.
 *
 * @param state - The match state containing the board hexes
 * @param hexId - The identifier of the hex to look up
 * @returns The hex's `type` string if a hex with `hexId` exists on the board, `null` otherwise
 */
function hexTypeAt(state: MatchState, hexId: string): string | null {
	const hex = state.board.find((h) => h.id === hexId);
	return hex?.type ?? null;
}

/**
 * Normalizes a unit type string into one of the canonical archetype labels.
 *
 * @param unitType - The unit type identifier to normalize (e.g., "swordsman", "knight", "crossbow" or already an archetype)
 * @returns `"infantry"`, `"cavalry"`, or `"archer"` corresponding to the provided unit type
 */
function archetypeUnit(unitType: string): "infantry" | "cavalry" | "archer" {
	if (unitType === "swordsman") return "infantry";
	if (unitType === "knight") return "cavalry";
	if (unitType === "crossbow") return "archer";
	return unitType as "infantry" | "cavalry" | "archer";
}

/**
 * Compute a small combat matchup bonus for an attacker against a defender.
 *
 * @param attackerType - Identifier for the attacking unit's type (e.g., specific unit name or archetype)
 * @param defenderType - Identifier for the defending unit's type (e.g., specific unit name or archetype)
 * @returns `10` if the attacker has a favorable archetype matchup (infantry > cavalry, cavalry > archer, archer > infantry), `-6` if the attacker has an unfavorable matchup, `0` otherwise
 */
function matchupBonus(attackerType: string, defenderType: string): number {
	const attacker = archetypeUnit(attackerType);
	const defender = archetypeUnit(defenderType);
	if (attacker === "infantry" && defender === "cavalry") return 10;
	if (attacker === "cavalry" && defender === "archer") return 10;
	if (attacker === "archer" && defender === "infantry") return 10;
	if (attacker === "infantry" && defender === "archer") return -6;
	if (attacker === "cavalry" && defender === "infantry") return -6;
	if (attacker === "archer" && defender === "cavalry") return -6;
	return 0;
}

/**
 * Determine the current game phase and the triggers that justify it.
 *
 * Evaluates turn number, unit counts, and VP lead (plus a short tactical window) to classify the state as "opening", "midgame", or "closing" and returns the list of observed trigger reasons.
 *
 * @param ctx.state - The full match state used to inspect players, units, and VP.
 * @param ctx.side - The perspective side ("A" or "B") for evaluating VP lead and unit counts.
 * @param ctx.turn - The current turn number used for opening/closing thresholds.
 * @param ctx.hasLegalAttack - Whether the side currently has any legal attack; used to detect a tactical closing window.
 * @returns An object containing `phase` (one of "opening", "midgame", or "closing") and `triggers` — an array of strings describing which conditions caused the selected phase.
function resolvePhase(ctx: {
	state: MatchState;
	side: "A" | "B";
	turn: number;
	hasLegalAttack: boolean;
}): { phase: BotPhase; triggers: string[] } {
	const triggers: string[] = [];
	const own = ctx.side === "A" ? ctx.state.players.A : ctx.state.players.B;
	const enemy = ctx.side === "A" ? ctx.state.players.B : ctx.state.players.A;
	const vpLead = own.vp - enemy.vp;

	if (ctx.turn <= DEFAULT_PHASE_POLICY.openingTurnMax) {
		triggers.push(`turn<=${DEFAULT_PHASE_POLICY.openingTurnMax}`);
		return { phase: "opening", triggers };
	}

	if (ctx.turn >= DEFAULT_PHASE_POLICY.closingTurnMin) {
		triggers.push(`turn>=${DEFAULT_PHASE_POLICY.closingTurnMin}`);
	}
	if (enemy.units.length <= DEFAULT_PHASE_POLICY.closingUnitsThreshold) {
		triggers.push(`enemyUnits<=${DEFAULT_PHASE_POLICY.closingUnitsThreshold}`);
	}
	if (own.units.length <= DEFAULT_PHASE_POLICY.closingUnitsThreshold) {
		triggers.push(`ownUnits<=${DEFAULT_PHASE_POLICY.closingUnitsThreshold}`);
	}
	if (
		Math.abs(vpLead) >= DEFAULT_PHASE_POLICY.closingVpLeadThreshold &&
		ctx.turn > DEFAULT_PHASE_POLICY.openingTurnMax
	) {
		triggers.push(`absVpLead>=${DEFAULT_PHASE_POLICY.closingVpLeadThreshold}`);
	}
	if (
		ctx.hasLegalAttack &&
		ctx.turn >= DEFAULT_PHASE_POLICY.closingTurnMin - 2 &&
		enemy.units.length <= DEFAULT_PHASE_POLICY.closingUnitsThreshold + 1
	) {
		triggers.push("tactical_closing_window");
	}

	if (triggers.length > 0) {
		return { phase: "closing", triggers };
	}
	return { phase: "midgame", triggers: ["default"] };
}

/**
 * Map a high-level strategy identifier to a concrete mock-LLM archetype name.
 *
 * @param strategy - Strategy identifier: can be a known archetype name, a high-level alias (e.g., "aggressive", "defensive"), or "random"
 * @returns The corresponding archetype name, or `null` when `strategy` is "random"
 */
function mapStrategyToArchetype(
	strategy: StrategyLike,
): MockLlmArchetypeName | null {
	if (strategy === "random") return null;
	if (strategy in MOCK_LLM_ARCHETYPES) {
		return strategy as MockLlmArchetypeName;
	}
	if (strategy === "aggressive") return "timing_push";
	if (strategy === "defensive") return "turtle_boom";
	return "map_control";
}

/**
 * Determine an effective archetype name from parsed prompt intents, using the provided mapped archetype as a fallback.
 *
 * Maps intents to archetypes with the following precedence:
 * - If `recruit` is true and `attack` is false → `"greedy_macro"`.
 * - If `defend` is true and `advance` is false → `"turtle_boom"`.
 * - If both `advance` and `attack` are true → `"timing_push"`.
 * - If `advance` is true → `"map_control"`.
 * - Otherwise returns the supplied `mapped` archetype.
 *
 * @param mapped - The archetype name inferred from strategy mapping or configuration to use as a fallback.
 * @param promptIntents - Parsed prompt intents (`attack`, `defend`, `recruit`, `advance`) derived from the inline prompt.
 * @returns The inferred archetype name based on prompt intents or the `mapped` fallback.
 */
function inferArchetypeFromIntents(
	mapped: MockLlmArchetypeName,
	promptIntents: PromptIntents,
): MockLlmArchetypeName {
	if (promptIntents.recruit && !promptIntents.attack) return "greedy_macro";
	if (promptIntents.defend && !promptIntents.advance) return "turtle_boom";
	if (promptIntents.advance && promptIntents.attack) return "timing_push";
	if (promptIntents.advance) return "map_control";
	return mapped;
}

/**
 * Computes a numeric bias to favor moves that match parsed prompt intents.
 *
 * Adds positive bias values when the move's action aligns with any enabled intent
 * in `promptIntents` (for example, rewarding attacks when `attack` is set).
 *
 * @param move - The candidate move to evaluate; its `action` determines which intent bonuses apply.
 * @param promptIntents - Parsed prompt intents indicating preferred behaviors (attack, defend, recruit, advance).
 * @returns The cumulative bias score (a non-negative number) to add to the move's utility; larger values indicate stronger alignment with the prompt intents.
 */
function scorePromptBias(move: Move, promptIntents: PromptIntents): number {
	let bonus = 0;
	if (promptIntents.attack && move.action === "attack") bonus += 65;
	if (promptIntents.defend && move.action === "fortify") bonus += 32;
	if (promptIntents.defend && move.action === "recruit") bonus += 14;
	if (promptIntents.defend && move.action === "upgrade") bonus += 8;
	if (promptIntents.recruit && move.action === "recruit") bonus += 28;
	if (promptIntents.recruit && move.action === "upgrade") bonus += 18;
	if (promptIntents.advance && move.action === "move") bonus += 22;
	if (promptIntents.advance && move.action === "attack") bonus += 10;
	return bonus;
}

/**
 * Compute the combat-related utility score for a candidate move.
 *
 * Evaluates only combat-relevant contributions: for an `attack` it rewards enemy count, damaged enemies, finishable kills, unit-type matchup bonuses, and penalizes fortified defenders; for `fortify` it returns a higher value when the unit is threatened by nearby enemies; for `upgrade` it returns a value that depends on the unit's archetype. Non-combat actions yield 0.
 *
 * @param ctx - Scoring context containing the move, current game state, side, and other evaluation metadata
 * @returns A numeric utility value representing the combat desirability of the move; larger values indicate stronger combat preference.
function combatValue(ctx: ScoringContext): number {
	const { move, state, side } = ctx;
	if (move.action === "attack") {
		const attacker = findUnit(state, move.unitId);
		const enemies = enemyUnitsAtHex(state, side, move.target);
		const damaged = enemies.filter((u) => u.hp < u.maxHp).length;
		const finishable = enemies.filter((u) => u.hp <= 1).length;
		const typeBonus =
			attacker && enemies.length > 0
				? Math.max(
						...enemies.map((enemy) => matchupBonus(attacker.type, enemy.type)),
					)
				: 0;
		const fortifiedPenalty = enemies.some((enemy) => enemy.isFortified)
			? -8
			: 0;
		return (
			enemies.length * 12 +
			damaged * 16 +
			finishable * 30 +
			typeBonus +
			fortifiedPenalty
		);
	}

	if (move.action === "fortify") {
		const unit = findUnit(state, move.unitId);
		if (!unit) return 0;
		const enemy = side === "A" ? state.players.B : state.players.A;
		const threatened = enemy.units.some(
			(u) => Math.abs(colIndex(u.position) - colIndex(unit.position)) <= 1,
		);
		return threatened ? 14 : 4;
	}

	if (move.action === "upgrade") {
		const unit = findUnit(state, move.unitId);
		if (!unit) return 0;
		if (unit.type === "infantry") return 14;
		if (unit.type === "archer") return 12;
		if (unit.type === "cavalry") return 10;
	}

	return 0;
}

/**
 * Computes the positional utility for a movement action based on advance direction, terrain at the destination, and friendly stacking.
 *
 * Returns a positive score for moves that advance toward the opponent (scaled by column delta), occupy advantageous terrain (high ground, hills, forest, resource hexes), or join a small stack of same-type allied units; returns 0 when the candidate is not a `move` action or the moving unit cannot be found.
 *
 * @returns A numeric positional score for the move (higher is better), or `0` if not applicable.
 */
function positionValue(ctx: ScoringContext): number {
	const { move, state, side } = ctx;
	if (move.action !== "move") return 0;
	const mover = findUnit(state, move.unitId);
	if (!mover) return 0;

	const fromCol = colIndex(mover.position);
	const toCol = colIndex(move.to);
	const delta = side === "A" ? toCol - fromCol : fromCol - toCol;
	const targetTerrain = hexTypeAt(state, move.to);
	const terrainBonus =
		targetTerrain === "high_ground"
			? 12
			: targetTerrain === "hills" || targetTerrain === "forest"
				? 6
				: targetTerrain === "gold_mine" || targetTerrain === "lumber_camp"
					? 7
					: 0;
	const stackUnits = friendlyUnitsAtHex(state, side, move.to);
	const stackBonus =
		stackUnits.length > 0 &&
		stackUnits.every((u) => u.type === mover.type) &&
		stackUnits.length < 5
			? 8
			: 0;

	return delta * 6 + terrainBonus + stackBonus;
}

/**
 * Scores the economic utility of a candidate move.
 *
 * The score reflects how the move affects resource and force balance, taking into account
 * resource lead, unit count difference, and the current phase.
 *
 * Behavior by action:
 * - `recruit`: base 12; +14 if the bot has fewer than 4 units; +8 if resource lead > 4; -20 in closing phase.
 * - `upgrade`: returns 0 if the target unit is missing; otherwise base 10; +6 if resource lead > 2; +4 if unit difference <= -1; -8 in closing phase.
 * - `fortify`: returns -4 if resource lead < 0; returns 4 in opening phase when resourceLead >= 0; otherwise 0.
 * - other actions: 0.
 *
 * @returns A numeric economic value (higher is better) for the provided move and context.
 */
function economyValue(ctx: ScoringContext): number {
	const { move, state, side, phase } = ctx;
	const own = side === "A" ? state.players.A : state.players.B;
	const enemy = side === "A" ? state.players.B : state.players.A;
	const resourceLead = own.gold + own.wood - (enemy.gold + enemy.wood);
	const unitDiff = own.units.length - enemy.units.length;

	if (move.action === "recruit") {
		let value = 12;
		if (own.units.length < 4) value += 14;
		if (resourceLead > 4) value += 8;
		if (phase === "closing") value -= 20;
		return value;
	}

	if (move.action === "upgrade") {
		const unit = findUnit(state, move.unitId);
		if (!unit) return 0;
		let value = 10;
		if (resourceLead > 2) value += 6;
		if (unitDiff <= -1) value += 4;
		if (phase === "closing") value -= 8;
		return value;
	}

	if (move.action === "fortify") {
		if (resourceLead < 0) return -4;
		return phase === "opening" ? 4 : 0;
	}

	return 0;
}

/**
 * Computes a numeric risk adjustment for a candidate move based on unit exposure and relative combat strength.
 *
 * @param ctx - Scoring context containing the move, game state, acting side, and current phase
 * @returns A numeric risk score:
 * - For `attack`: `(attacker.hp - max(enemy.hp)) * 4 - 6 * (number of fortified enemies)`, plus `8` if phase is `"closing"`; returns `-5` if the attacker is missing or there are no enemies.
 * - For `move`: `-8` if the destination is within one column of any enemy unit (exposed), otherwise `3`.
 * - For `fortify`: `10`.
 * - For `end_turn` or `pass`: `-2`.
 * - For all other actions: `0`.
 */
function riskValue(ctx: ScoringContext): number {
	const { move, state, side, phase } = ctx;
	if (move.action === "attack") {
		const enemies = enemyUnitsAtHex(state, side, move.target);
		const attacker = findUnit(state, move.unitId);
		if (!attacker || enemies.length === 0) return -5;
		const hpGap = attacker.hp - Math.max(...enemies.map((u) => u.hp));
		const fortifiedEnemies = enemies.filter((u) => u.isFortified).length;
		let value = hpGap * 4 - fortifiedEnemies * 6;
		if (phase === "closing") {
			value += 8;
		}
		return value;
	}
	if (move.action === "move") {
		const unit = findUnit(state, move.unitId);
		if (!unit) return 0;
		const enemy = side === "A" ? state.players.B : state.players.A;
		const destinationCol = colIndex(move.to);
		const exposed = enemy.units.some(
			(u) => Math.abs(colIndex(u.position) - destinationCol) <= 1,
		);
		return exposed ? -8 : 3;
	}
	if (move.action === "fortify") return 10;
	if (move.action === "end_turn" || move.action === "pass") return -2;
	return 0;
}

/**
 * Computes the timing bias for a candidate move based on turn, game phase, and immediate attack opportunities.
 *
 * @param ctx - Scoring context containing the move, game state, side, current turn, phase, and relevant flags used to compute timing bias
 * @returns A numeric timing bias (positive or negative) that adjusts a move's utility to reflect urgency or tempo considerations
 */
function timingValue(ctx: ScoringContext): number {
	const { move, state, side, turn, phase, hasLegalAttack } = ctx;
	if (move.action === "upgrade") {
		if (turn <= 10) return 16;
		if (turn <= 20) return 8;
		return -8;
	}
	if (move.action === "attack") {
		const enemies = enemyUnitsAtHex(state, side, move.target);
		const finishable = enemies.filter((u) => u.hp <= 1).length;
		let value = finishable * 22;
		if (phase === "closing") value += 16;
		if (hasLegalAttack) value += turn >= 16 ? 18 : 10;
		return value;
	}
	if (move.action === "move") {
		if (phase === "opening") return 8;
		if (phase === "closing") return -10;
		return 2;
	}
	if (move.action === "recruit") {
		if (phase === "opening") return 10;
		if (phase === "closing") return -18;
		return 0;
	}
	if (move.action === "fortify") {
		if (phase === "closing") return -8;
		return phase === "opening" ? 4 : 0;
	}
	return 0;
}

/**
 * Computes a policy-driven numeric adjustment applied to a move's utility.
 *
 * Applies turn- and policy-based bonuses or penalties based on whether the
 * side has a legal attack, whether the move is a move/recruit/attack/fortify/end_turn/pass,
 * whether there are playable alternatives, and the current game phase.
 *
 * @param ctx - Scoring context containing:
 *   - move: the candidate move being evaluated
 *   - turn: current turn number
 *   - hasLegalAttack: whether any legal attack exists for the side
 *   - hasPlayableAlternatives: whether other non-end-turn moves are available
 *   - phase: resolved game phase ("opening" | "midgame" | "closing")
 * @returns The cumulative integer score adjustment to apply to the move's utility (positive favors the move, negative penalizes it).
 */
function scorePolicyAdjustments(ctx: ScoringContext): number {
	const { move, turn, hasLegalAttack, hasPlayableAlternatives, phase } = ctx;
	let score = 0;

	if (hasLegalAttack) {
		if (move.action === "attack") {
			score += turn >= 16 ? 28 : 14;
		}
		if (move.action === "move" && turn >= 22) score -= 14;
		if (move.action === "recruit" && turn >= 14) score -= 26;
	}

	if (phase === "closing") {
		if (move.action === "move") score -= 8;
		if (move.action === "recruit") score -= 16;
		if (move.action === "fortify") score -= 10;
		if (move.action === "attack") score += 14;
	}

	if (
		hasPlayableAlternatives &&
		(move.action === "end_turn" || move.action === "pass")
	) {
		score -= 100;
	}
	return score;
}

/**
 * Compute weighted utility terms for a move using raw term values, an archetype's base weights, and phase-specific nudges.
 *
 * @param raw - Raw numeric term values for `combatValue`, `positionValue`, `economyValue`, `riskValue`, and `timingValue`
 * @param archetype - Archetype configuration providing base `termWeights` and `phaseTermNudges`
 * @param phase - Current bot phase used to apply per-term nudges from the archetype
 * @returns An object containing:
 *  - `weights`: term weights after applying phase nudges,
 *  - `weighted`: per-term values computed by multiplying raw terms by their weights and rounding,
 *  - `total`: sum of the weighted term values
 */
function buildWeightedTerms(
	raw: Record<UtilityTerm, number>,
	archetype: ArchetypeConfig,
	phase: BotPhase,
): {
	weights: Record<UtilityTerm, number>;
	weighted: Record<UtilityTerm, number>;
	total: number;
} {
	const weights = { ...archetype.termWeights };
	for (const key of Object.keys(
		archetype.phaseTermNudges[phase],
	) as UtilityTerm[]) {
		weights[key] += archetype.phaseTermNudges[phase][key] ?? 0;
	}

	const weighted = {
		combatValue: Math.round(raw.combatValue * weights.combatValue),
		positionValue: Math.round(raw.positionValue * weights.positionValue),
		economyValue: Math.round(raw.economyValue * weights.economyValue),
		riskValue: Math.round(raw.riskValue * weights.riskValue),
		timingValue: Math.round(raw.timingValue * weights.timingValue),
	};

	const total =
		weighted.combatValue +
		weighted.positionValue +
		weighted.economyValue +
		weighted.riskValue +
		weighted.timingValue;

	return { weights, weighted, total };
}

/**
 * Produce a compact, human-readable explanation summarizing a move's evaluated utility.
 *
 * @param breakdown - The move's utility breakdown containing phase, phaseTriggers, archetype, total score, and weighted term values.
 * @returns A single-line string containing the phase (with triggers), archetype, total score, and weighted term breakdown (combat, position, economy, risk, timing).
 */
function buildWhyThisMove(breakdown: MoveUtilityBreakdown): string {
	const termSummary = [
		`combat=${breakdown.termsWeighted.combatValue}`,
		`position=${breakdown.termsWeighted.positionValue}`,
		`economy=${breakdown.termsWeighted.economyValue}`,
		`risk=${breakdown.termsWeighted.riskValue}`,
		`timing=${breakdown.termsWeighted.timingValue}`,
	].join(", ");
	const triggerLabel = breakdown.phaseTriggers.join("+");
	return `phase=${breakdown.phase}(${triggerLabel}) archetype=${breakdown.archetype} total=${breakdown.total}; ${termSummary}`;
}

/**
 * Computes a utility-based evaluation for a candidate move and returns reasoning metadata.
 *
 * @param ctx - ScoringContext containing the move, game state, archetype, phase, prompt intents, RNG flags, and other inputs needed to score the move
 * @returns MoveMetadata containing a human-readable `whyThisMove` explanation and a `breakdown` with the archetype, phase, individual term values (raw and weighted), term weights, biases, policy adjustments, phase triggers, and the total utility score
 */
function scoreMoveWithUtility(ctx: ScoringContext): MoveMetadata {
	const baseActionBias = ctx.archetype.actionBias[ctx.move.action] ?? 0;
	const phaseActionBias =
		ctx.archetype.phaseActionBias[ctx.phase][ctx.move.action] ?? 0;
	const promptBonus = scorePromptBias(ctx.move, ctx.promptIntents);
	const policyAdjustments = scorePolicyAdjustments(ctx);

	const rawTerms = {
		combatValue: combatValue(ctx),
		positionValue: positionValue(ctx),
		economyValue: economyValue(ctx),
		riskValue: riskValue(ctx),
		timingValue: timingValue(ctx),
	};

	const weighted = buildWeightedTerms(rawTerms, ctx.archetype, ctx.phase);
	const total =
		baseActionBias +
		phaseActionBias +
		promptBonus +
		policyAdjustments +
		weighted.total;

	const breakdown: MoveUtilityBreakdown = {
		archetype: ctx.archetype.name,
		phase: ctx.phase,
		phaseTriggers: ctx.phaseTriggers,
		baseActionBias,
		phaseActionBias,
		promptBonus,
		policyAdjustments,
		termsRaw: rawTerms,
		termWeights: weighted.weights,
		termsWeighted: weighted.weighted,
		total,
	};

	return {
		whyThisMove: buildWhyThisMove(breakdown),
		breakdown,
	};
}

/**
 * Attach reasoning and metadata to a move and return the augmented move.
 *
 * @param move - The original move object to augment
 * @param metadata - The metadata and human-readable explanation to attach to `move`
 * @returns The same move augmented with `reasoning` (from `metadata.whyThisMove`) and a `metadata` field
 */
function withMetadata(move: Move, metadata: MoveMetadata): Move {
	return {
		...(move as Move & {
			reasoning?: string;
			metadata?: MoveMetadata;
		}),
		reasoning: metadata.whyThisMove,
		metadata,
	} as unknown as Move;
}

/**
 * Create a mock LLM-style Bot that scores legal moves using archetype-driven utility and prompt intents.
 *
 * The returned bot derives its behavior from the provided config (inline prompt, prompt file, strategy, and optional archetype override).
 * It maps legacy strategies to archetypes, infers archetypes from parsed prompt intents when applicable, and resolves a game phase (opening/midgame/closing) to apply phase-specific scoring nudges.
 * If the effective archetype is missing or the strategy is `"random"`, the bot selects a legal move uniformly at random.
 *
 * @param id - The bot's unique identifier
 * @param config - Optional configuration that can include an inline prompt, a path to a prompt file, a strategy, or an explicit archetype override
 * @returns A Bot that, when asked to choose a move, evaluates legal moves with a utility composed of combat, position, economy, risk, and timing terms (adjusted by archetype weights, prompt-derived intent biases, and policy/phase adjustments) and returns the highest-scoring move (ties broken randomly); falls back to random selection if configured as random or no archetype is available.
 */
export function makeMockLlmBot(id: string, config: MockLlmConfig = {}): Bot {
	let fileConfig: PromptFileConfig | null = null;
	if (config.file) {
		fileConfig = loadPromptFromFile(config.file);
	}

	const strategy = config.strategy ?? fileConfig?.strategy ?? "strategic";
	const effectiveInline = config.inline ?? fileConfig?.inline;
	const promptIntents = parsePromptIntents(effectiveInline);
	const promptTag = effectiveInline?.trim().length ? "custom" : "default";

	const mappedArchetype = mapStrategyToArchetype(strategy);
	const effectiveArchetype =
		config.archetype ??
		fileConfig?.archetype ??
		(mappedArchetype
			? inferArchetypeFromIntents(mappedArchetype, promptIntents)
			: null);

	return {
		id,
		name:
			fileConfig?.botId ??
			`MockLLM[strategy=${strategy},archetype=${effectiveArchetype ?? "random"},prompt=${promptTag}]`,
		chooseMove: async ({ legalMoves, rng, state, turn }) => {
			if (strategy === "random" || !effectiveArchetype) {
				const randomMove = pickOne(legalMoves, rng);
				return withMetadata(randomMove, {
					whyThisMove:
						"phase=midgame(default) archetype=random total=0; random_pick",
					breakdown: {
						archetype: "random",
						phase: "midgame",
						phaseTriggers: ["random_strategy"],
						baseActionBias: 0,
						phaseActionBias: 0,
						promptBonus: 0,
						policyAdjustments: 0,
						termsRaw: {
							combatValue: 0,
							positionValue: 0,
							economyValue: 0,
							riskValue: 0,
							timingValue: 0,
						},
						termWeights: {
							combatValue: 0,
							positionValue: 0,
							economyValue: 0,
							riskValue: 0,
							timingValue: 0,
						},
						termsWeighted: {
							combatValue: 0,
							positionValue: 0,
							economyValue: 0,
							riskValue: 0,
							timingValue: 0,
						},
						total: 0,
					},
				});
			}

			const side = inferSide(state, id);
			const hasLegalAttack = legalMoves.some(
				(move) => move.action === "attack",
			);
			const hasPlayableAlternatives = legalMoves.some(
				(move) => move.action !== "end_turn" && move.action !== "pass",
			);
			const { phase, triggers } = resolvePhase({
				state,
				side,
				turn,
				hasLegalAttack,
			});
			const archetype = MOCK_LLM_ARCHETYPES[effectiveArchetype];

			let bestScore = Number.NEGATIVE_INFINITY;
			let bestMoves: MoveCandidate[] = [];

			for (const move of legalMoves) {
				const metadata = scoreMoveWithUtility({
					move,
					state,
					side,
					archetype,
					phase,
					phaseTriggers: triggers,
					turn,
					promptIntents,
					hasPlayableAlternatives,
					hasLegalAttack,
				});
				if (metadata.breakdown.total > bestScore) {
					bestScore = metadata.breakdown.total;
					bestMoves = [{ move, metadata }];
				} else if (metadata.breakdown.total === bestScore) {
					bestMoves.push({ move, metadata });
				}
			}

			const selected = pickOne(bestMoves, rng);
			return withMetadata(selected.move, selected.metadata);
		},
	};
}