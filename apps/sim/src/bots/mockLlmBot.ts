import * as fs from "node:fs";
import * as path from "node:path";
import { pickOne } from "../rng";
import type { Bot, MatchState, Move } from "../types";

/** Configuration for mock LLM bot */
export interface MockLlmConfig {
	/** Inline prompt instructions (e.g., "Always attack first") */
	inline?: string;
	/** Path to JSON file with prompt config */
	file?: string;
	/** Strategy pattern: aggressive, defensive, random, strategic */
	strategy?: "aggressive" | "defensive" | "random" | "strategic";
}

/** File-based prompt config */
interface PromptFileConfig {
	botId: string;
	inline?: string;
	strategy?: "aggressive" | "defensive" | "random" | "strategic";
}

function loadPromptFromFile(filePath: string): PromptFileConfig {
	const absolutePath = path.isAbsolute(filePath)
		? filePath
		: path.resolve(process.cwd(), filePath);
	const content = fs.readFileSync(absolutePath, "utf-8");
	return JSON.parse(content) as PromptFileConfig;
}

const actionScores: Record<string, Record<Move["action"], number>> = {
	aggressive: {
		attack: 95,
		move: 70,
		recruit: 35,
		fortify: 15,
		end_turn: -20,
		pass: -20,
	},
	defensive: {
		fortify: 80,
		recruit: 70,
		move: 45,
		attack: 57,
		end_turn: 5,
		pass: 0,
	},
	balanced: {
		attack: 90,
		move: 72,
		recruit: 60,
		fortify: 35,
		end_turn: 0,
		pass: 0,
	},
	strategic: {
		attack: 102,
		move: 82,
		recruit: 62,
		fortify: 28,
		end_turn: -5,
		pass: -5,
	},
};

interface PromptIntents {
	attack: boolean;
	defend: boolean;
	recruit: boolean;
	advance: boolean;
}

function includesAny(haystack: string, needles: string[]): boolean {
	return needles.some((needle) => haystack.includes(needle));
}

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

function inferSide(state: MatchState, id: string): "A" | "B" {
	return String(state.players.A.id) === String(id) ? "A" : "B";
}

function colIndex(hexId: string): number {
	const value = Number(hexId.slice(1));
	return Number.isFinite(value) ? value : 0;
}

function findUnit(state: MatchState, unitId: string) {
	for (const unit of state.players.A.units) {
		if (unit.id === unitId) return unit;
	}
	for (const unit of state.players.B.units) {
		if (unit.id === unitId) return unit;
	}
	return null;
}

function enemyUnitsAtHex(state: MatchState, side: "A" | "B", hexId: string) {
	const enemy = side === "A" ? state.players.B : state.players.A;
	return enemy.units.filter((unit) => unit.position === hexId);
}

function isAllCavalryMirror(state: MatchState): boolean {
	const a = state.players.A.units;
	const b = state.players.B.units;
	if (a.length === 0 || b.length === 0) return false;
	return (
		a.every((u) => u.type === "cavalry") && b.every((u) => u.type === "cavalry")
	);
}

function friendlyUnitsAtHex(state: MatchState, side: "A" | "B", hexId: string) {
	const own = side === "A" ? state.players.A : state.players.B;
	return own.units.filter((unit) => unit.position === hexId);
}

function hexTypeAt(state: MatchState, hexId: string): string | null {
	const hex = state.board.find((h) => h.id === hexId);
	return hex?.type ?? null;
}

function matchupBonus(attackerType: string, defenderType: string): number {
	if (attackerType === "infantry" && defenderType === "cavalry") return 10;
	if (attackerType === "cavalry" && defenderType === "archer") return 10;
	if (attackerType === "archer" && defenderType === "infantry") return 10;
	if (attackerType === "infantry" && defenderType === "archer") return -6;
	if (attackerType === "cavalry" && defenderType === "infantry") return -6;
	if (attackerType === "archer" && defenderType === "cavalry") return -6;
	return 0;
}

function strategicWeight(
	value: number,
	strategy: "aggressive" | "defensive" | "random" | "strategic",
): number {
	if (strategy === "strategic") return Math.round(value * 1.25);
	if (strategy === "aggressive") return Math.round(value * 0.8);
	if (strategy === "defensive") return Math.round(value * 0.85);
	return value;
}

function scoreMoveContext(
	move: Move,
	state: MatchState,
	side: "A" | "B",
	strategy: "aggressive" | "defensive" | "random" | "strategic",
): number {
	switch (move.action) {
		case "attack": {
			const attacker = findUnit(state, move.unitId);
			const enemies = enemyUnitsAtHex(state, side, move.target);
			const damaged = enemies.filter((u) => u.hp < u.maxHp).length;
			const finishable = enemies.filter((u) => u.hp <= 1).length;
			const typeBonus =
				attacker && enemies.length > 0
					? Math.max(
							...enemies.map((enemy) =>
								matchupBonus(attacker.type, enemy.type),
							),
						)
					: 0;
			const fortifiedPenalty = enemies.some((enemy) => enemy.isFortified)
				? strategy === "strategic"
					? -3
					: -8
				: 0;
			const strategicTacticalBonus =
				strategy === "strategic"
					? damaged * 10 + finishable * 35 + (enemies.length > 1 ? 8 : 0)
					: 0;
			const contextScore =
				enemies.length * 12 +
				damaged * 18 +
				finishable * 25 +
				typeBonus +
				fortifiedPenalty +
				strategicTacticalBonus;
			return (
				strategicWeight(contextScore, strategy) +
				(strategy === "aggressive" ? 10 : 0)
			);
		}
		case "move": {
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
						: 0;
			const stackUnits = friendlyUnitsAtHex(state, side, move.to);
			const stackBonus =
				stackUnits.length > 0 &&
				stackUnits.every((u) => u.type === mover.type) &&
				stackUnits.length < 5
					? 8
					: 0;
			return strategicWeight(delta * 6 + terrainBonus + stackBonus, strategy);
		}
		case "recruit": {
			const ownUnits =
				side === "A"
					? state.players.A.units.length
					: state.players.B.units.length;
			return ownUnits < 4 ? 20 : 0;
		}
		default:
			return 0;
	}
}

/**
 * Score a move based on strategy and optional prompt instructions.
 * The "strategic" mode parses prompt text to bias move selection,
 * simulating how real LLM agents interpret prompt instructions.
 */
function scoreMoveForStrategy(
	move: Move,
	state: MatchState,
	side: "A" | "B",
	strategy: "aggressive" | "defensive" | "random" | "strategic",
	promptIntents: PromptIntents,
	hasPlayableAlternatives: boolean,
): number {
	if (strategy === "random") return 0;
	const cavalryMirror = isAllCavalryMirror(state);

	const baseTable =
		strategy === "aggressive"
			? actionScores.aggressive
			: strategy === "defensive"
				? actionScores.defensive
				: strategy === "strategic"
					? actionScores.strategic
					: actionScores.balanced;
	let score = baseTable[move.action] ?? 0;

	if (promptIntents.attack && move.action === "attack") score += 65;
	if (promptIntents.defend && move.action === "fortify") score += 30;
	if (promptIntents.defend && move.action === "recruit") score += 15;
	if (promptIntents.recruit && move.action === "recruit") score += 25;
	if (promptIntents.advance && move.action === "move") score += 20;
	if (promptIntents.advance && move.action === "attack") score += 10;

	score += scoreMoveContext(move, state, side, strategy);

	if (strategy === "strategic" && cavalryMirror) {
		if (move.action === "recruit") score += 18;
		if (move.action === "fortify") score += 14;
		if (move.action === "move") score += 8;
		if (move.action === "attack") {
			const enemies = enemyUnitsAtHex(state, side, move.target);
			const finishable = enemies.filter((u) => u.hp <= 1).length;
			if (finishable === 0) score -= 10;
		}
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
 * Create a mock LLM bot that simulates prompt-driven strategy selection.
 *
 * This is key for testing game balance: by varying the prompt instructions
 * and strategies across thousands of matches, we can detect whether any
 * single strategy dominates or whether diverse approaches are viable.
 */
export function makeMockLlmBot(id: string, config: MockLlmConfig = {}): Bot {
	let fileConfig: PromptFileConfig | null = null;
	if (config.file) {
		fileConfig = loadPromptFromFile(config.file);
	}

	const effectiveStrategy =
		config.strategy ?? fileConfig?.strategy ?? "strategic";
	const effectiveInline = config.inline ?? fileConfig?.inline;
	const promptIntents = parsePromptIntents(effectiveInline);
	const promptTag = effectiveInline?.trim().length ? "custom" : "default";

	return {
		id,
		name:
			fileConfig?.botId ??
			`MockLLM[strategy=${effectiveStrategy},prompt=${promptTag}]`,
		chooseMove: async ({ legalMoves, rng, state }) => {
			if (effectiveStrategy === "random") {
				return pickOne(legalMoves, rng);
			}
			const side = inferSide(state, id);
			const hasPlayableAlternatives = legalMoves.some(
				(move) => move.action !== "end_turn" && move.action !== "pass",
			);

			let bestScore = Number.NEGATIVE_INFINITY;
			let bestMoves: Move[] = [];

			for (const move of legalMoves) {
				const score = scoreMoveForStrategy(
					move,
					state,
					side,
					effectiveStrategy,
					promptIntents,
					hasPlayableAlternatives,
				);
				if (score > bestScore) {
					bestScore = score;
					bestMoves = [move];
				} else if (score === bestScore) {
					bestMoves.push(move);
				}
			}

			return pickOne(bestMoves.length > 0 ? bestMoves : legalMoves, rng);
		},
	};
}
