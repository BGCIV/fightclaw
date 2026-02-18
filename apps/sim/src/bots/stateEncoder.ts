/**
 * Compact state encoder for LLM consumption.
 *
 * Replaces verbose ASCII board + JSON dumps with a structured,
 * token-efficient format that conveys all necessary tactical information.
 */

import type { MatchState, Move } from "../types";

// ---------------------------------------------------------------------------
// Type abbreviations
// ---------------------------------------------------------------------------

const TYPE_ABBREV: Record<string, string> = {
	infantry: "inf",
	cavalry: "cav",
	archer: "arc",
	swordsman: "swd",
	knight: "kni",
	crossbow: "xbw",
};

// Terrain types to skip when listing terrain near units
const BORING_TERRAIN = new Set(["plains", "deploy_a", "deploy_b"]);

// Terrain display names (compact)
const TERRAIN_DISPLAY: Record<string, string> = {
	forest: "forest",
	hills: "hills",
	high_ground: "high_ground",
	gold_mine: "gold_mine",
	lumber_camp: "lumber_camp",
	crown: "crown",
	stronghold_a: "stronghold",
	stronghold_b: "stronghold",
};

const ROWS = 9;

/**
 * Parse a hex-grid identifier (e.g., "A1") into zero-based row and column indices.
 *
 * @param id - Hex identifier where the first character is a row letter A–I and the following digits are a 1-based column number
 * @returns An object with `row` and `col` as zero-based indices, or `null` if `id` does not match the expected format
 */
function parseHexId(id: string): { row: number; col: number } | null {
	const match = /^([A-I])(\d+)$/.exec(id);
	if (!match) return null;
	const rowChar = match[1];
	const colRaw = match[2];
	if (!rowChar || !colRaw) return null;
	return {
		row: rowChar.charCodeAt(0) - 65,
		col: Number.parseInt(colRaw, 10) - 1,
	};
}

/**
 * Convert 0-based grid coordinates to a human-readable hex ID (e.g., "A1").
 *
 * @param row - Row index, 0-based (0 -> "A")
 * @param col - Column index, 0-based (0 -> 1)
 * @returns The hex identifier combining an uppercase row letter and a 1-based column (e.g., "A1")
 */
function toHexId(row: number, col: number): string {
	return `${String.fromCharCode(65 + row)}${col + 1}`;
}

/**
 * Get the valid neighboring hex IDs for a given hex on a board.
 *
 * @param id - The hex identifier in "A1" style
 * @param cols - The number of columns on the board
 * @returns An array of adjacent hex IDs (human-readable) that fall within board bounds
 */
function neighborsOfHex(id: string, cols: number): string[] {
	const parsed = parseHexId(id);
	if (!parsed) return [];
	const { row, col } = parsed;
	const deltas =
		row % 2 === 0
			? [
					[+1, 0],
					[0, +1],
					[-1, +1],
					[-1, 0],
					[-1, -1],
					[0, -1],
				]
			: [
					[+1, 0],
					[+1, +1],
					[0, +1],
					[-1, 0],
					[0, -1],
					[+1, -1],
				];
	const result: string[] = [];
	for (const [dc, dr] of deltas) {
		const nr = row + dr;
		const nc = col + dc;
		if (nr >= 0 && nr < ROWS && nc >= 0 && nc < cols) {
			result.push(toHexId(nr, nc));
		}
	}
	return result;
}

/**
 * Compare two hex IDs by their grid coordinates.
 *
 * @param a - First hex ID (e.g., "A1")
 * @param b - Second hex ID (e.g., "B3")
 * @returns A negative number if `a` comes before `b`, `0` if they are equivalent, or a positive number if `a` comes after `b`. Comparison is by row then column; if either ID cannot be parsed, falls back to lexicographic string comparison.
 */
function compareHexId(a: string, b: string): number {
	const pa = parseHexId(a);
	const pb = parseHexId(b);
	if (!pa || !pb) return a.localeCompare(b);
	return pa.row - pb.row || pa.col - pb.col;
}

/**
 * Compare two terrain entry strings by their hex coordinate portion (the substring before `=`).
 *
 * @param a - First terrain entry, typically formatted as `"A1"` or `"A1=terrain"`
 * @param b - Second terrain entry, typically formatted as `"B2"` or `"B2=terrain"`
 * @returns A negative number if `a` sorts before `b`, `0` if they are equal, or a positive number if `a` sorts after `b`
 */
function compareTerrainEntry(a: string, b: string): number {
	const aHex = a.split("=")[0] ?? a;
	const bHex = b.split("=")[0] ?? b;
	return compareHexId(aHex, bHex);
}

// ---------------------------------------------------------------------------
// encodeMove — single move to CLI command string
/**
 * Convert a Move object into its compact CLI command string.
 *
 * Encodes actions into one of the canonical command tokens used by the simulator:
 * `move {unitId} {to}`, `attack {unitId} {target}`, `recruit {unitType} {at}`,
 * `fortify {unitId}`, `upgrade {unitId}`, or `end_turn`.
 *
 * @param move - The move to encode
 * @returns The encoded command string representing the move
 */

export function encodeMove(move: Move): string {
	switch (move.action) {
		case "move":
			return `move ${move.unitId} ${move.to}`;
		case "attack":
			return `attack ${move.unitId} ${move.target}`;
		case "recruit":
			return `recruit ${move.unitType} ${move.at}`;
		case "fortify":
			return `fortify ${move.unitId}`;
		case "upgrade":
			return `upgrade ${move.unitId}`;
		case "end_turn":
			return "end_turn";
		case "pass":
			return "end_turn";
	}
}

// ---------------------------------------------------------------------------
// encodeState — full game state in compact notation
/**
 * Produce a compact, token-efficient textual representation of the game state from a given side's perspective.
 *
 * The output includes a header with turn, active player, actions remaining, and resources; separate unit lists for the active side and the enemy (unit id, abbreviated type, position, hp, fortified flag, and stronghold annotation); optional terrain near units and contested nearby terrain entries; and an optional listing of the last enemy moves encoded as CLI-style commands.
 *
 * @param state - Full match state to encode
 * @param side - Perspective side (`"A"` or `"B"`) for which the state is rendered
 * @param lastEnemyMoves - Optional list of the enemy's most recent moves to include under `LAST_ENEMY_TURN`
 * @returns A multi-section string describing the encoded state suitable for LLM consumption (sections: header, ENEMY, UNITS_<side>, UNITS_<enemy>, TERRAIN_NEAR_UNITS, TERRAIN_CONTESTED_NEARBY, LAST_ENEMY_TURN as present)
 */

export function encodeState(
	state: MatchState,
	side: "A" | "B",
	lastEnemyMoves?: Move[],
): string {
	const enemySide = side === "A" ? "B" : "A";
	const player = state.players[side];
	const enemy = state.players[enemySide];

	const lines: string[] = [];
	const boardCols = Math.floor(state.board.length / ROWS);

	// Header
	lines.push(
		`STATE turn=${state.turn} player=${side} actions=${state.actionsRemaining} gold=${player.gold} wood=${player.wood} vp=${player.vp}`,
	);
	lines.push(`ENEMY gold=${enemy.gold} wood=${enemy.wood} vp=${enemy.vp}`);
	lines.push("");

	// Build a hex lookup for quick terrain checks
	const hexMap = new Map<string, { type: string }>();
	for (const hex of state.board) {
		hexMap.set(hex.id, { type: hex.type });
	}

	// Units for the active side
	lines.push(`UNITS_${side}:`);
	const sortedFriendly = [...player.units].sort((a, b) =>
		a.id.localeCompare(b.id),
	);
	for (const unit of sortedFriendly) {
		const abbrev = TYPE_ABBREV[unit.type] ?? unit.type;
		let line = `  ${unit.id} ${abbrev} ${unit.position} hp=${unit.hp}/${unit.maxHp}`;
		if (unit.isFortified) {
			line += " fortified";
		}
		// Check if unit is on a stronghold
		const hex = hexMap.get(unit.position);
		if (hex && (hex.type === "stronghold_a" || hex.type === "stronghold_b")) {
			line += " [stronghold]";
		}
		lines.push(line);
	}
	lines.push("");

	// Units for the enemy side
	lines.push(`UNITS_${enemySide}:`);
	const sortedEnemy = [...enemy.units].sort((a, b) => a.id.localeCompare(b.id));
	for (const unit of sortedEnemy) {
		const abbrev = TYPE_ABBREV[unit.type] ?? unit.type;
		let line = `  ${unit.id} ${abbrev} ${unit.position} hp=${unit.hp}/${unit.maxHp}`;
		if (unit.isFortified) {
			line += " fortified";
		}
		const hex = hexMap.get(unit.position);
		if (hex && (hex.type === "stronghold_a" || hex.type === "stronghold_b")) {
			line += " [stronghold]";
		}
		lines.push(line);
	}
	lines.push("");

	// Terrain near units — only interesting terrain on hexes where units stand
	const terrainEntries: string[] = [];
	const allUnits = [...player.units, ...enemy.units];
	const seenPositions = new Set<string>();
	for (const unit of allUnits) {
		if (seenPositions.has(unit.position)) continue;
		seenPositions.add(unit.position);
		const hex = hexMap.get(unit.position);
		if (hex && !BORING_TERRAIN.has(hex.type)) {
			const display = TERRAIN_DISPLAY[hex.type] ?? hex.type;
			terrainEntries.push(`${unit.position}=${display}`);
		}
	}
	if (terrainEntries.length > 0) {
		lines.push("TERRAIN_NEAR_UNITS:");
		lines.push(`  ${terrainEntries.sort(compareTerrainEntry).join(" ")}`);
		lines.push("");
	}

	// Contested nearby terrain — interesting hexes adjacent to both sides.
	const nearbyByA = new Set<string>();
	const nearbyByB = new Set<string>();
	for (const unit of player.units) {
		nearbyByA.add(unit.position);
		for (const nearby of neighborsOfHex(unit.position, boardCols)) {
			nearbyByA.add(nearby);
		}
	}
	for (const unit of enemy.units) {
		nearbyByB.add(unit.position);
		for (const nearby of neighborsOfHex(unit.position, boardCols)) {
			nearbyByB.add(nearby);
		}
	}
	const contestedEntries: string[] = [];
	for (const hex of state.board) {
		if (BORING_TERRAIN.has(hex.type)) continue;
		if (!nearbyByA.has(hex.id) || !nearbyByB.has(hex.id)) continue;
		if (seenPositions.has(hex.id)) continue;
		const display = TERRAIN_DISPLAY[hex.type] ?? hex.type;
		contestedEntries.push(`${hex.id}=${display}`);
	}
	if (contestedEntries.length > 0) {
		lines.push("TERRAIN_CONTESTED_NEARBY:");
		lines.push(`  ${contestedEntries.sort(compareTerrainEntry).join(" ")}`);
		lines.push("");
	}

	// Last enemy moves
	if (lastEnemyMoves && lastEnemyMoves.length > 0) {
		lines.push("LAST_ENEMY_TURN:");
		for (const move of lastEnemyMoves) {
			lines.push(`  ${encodeMove(move)}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// encodeLegalMoves — categorize legal moves by action type
/**
 * Encode a list of legal moves into a compact, categorized multiline text format.
 *
 * Attack entries are enriched using the provided game state when a target unit occupies the target hex.
 *
 * @param moves - Array of legal moves to encode
 * @param state - Current match state used to look up units for enriching attack entries
 * @returns A multiline string beginning with "LEGAL_MOVES:" and optional sections "ATTACKS:", "MOVES:", "RECRUIT:", and "OTHER:". Attack lines include target id, short type abbreviation, and `hp=current/max` when the target unit is known. */

export function encodeLegalMoves(moves: Move[], state: MatchState): string {
	const attacks: string[] = [];
	const moveMoves: string[] = [];
	const recruits: string[] = [];
	const other: string[] = [];

	// Build a unit lookup by position for attack target info
	const unitsByPosition = new Map<
		string,
		{ id: string; type: string; hp: number; maxHp: number }
	>();
	for (const side of ["A", "B"] as const) {
		for (const unit of state.players[side].units) {
			// Store the first unit at each position (lead unit of stack)
			if (!unitsByPosition.has(unit.position)) {
				unitsByPosition.set(unit.position, {
					id: unit.id,
					type: unit.type,
					hp: unit.hp,
					maxHp: unit.maxHp,
				});
			}
		}
	}

	for (const move of moves) {
		switch (move.action) {
			case "attack": {
				const targetUnit = unitsByPosition.get(move.target);
				if (targetUnit) {
					const abbrev = TYPE_ABBREV[targetUnit.type] ?? targetUnit.type;
					attacks.push(
						`  attack ${move.unitId} ${move.target} (target: ${targetUnit.id} ${abbrev} hp=${targetUnit.hp}/${targetUnit.maxHp})`,
					);
				} else {
					attacks.push(`  attack ${move.unitId} ${move.target}`);
				}
				break;
			}
			case "move":
				moveMoves.push(`  move ${move.unitId} ${move.to}`);
				break;
			case "recruit":
				recruits.push(`  recruit ${move.unitType} ${move.at}`);
				break;
			case "end_turn":
			case "pass":
				other.push("  end_turn");
				break;
			case "fortify":
				other.push(`  fortify ${move.unitId}`);
				break;
			case "upgrade":
				other.push(`  upgrade ${move.unitId}`);
				break;
		}
	}

	const lines: string[] = [];
	lines.push("LEGAL_MOVES:");

	if (attacks.length > 0) {
		lines.push("ATTACKS:");
		lines.push(...attacks);
	}
	if (moveMoves.length > 0) {
		lines.push("MOVES:");
		lines.push(...moveMoves);
	}
	if (recruits.length > 0) {
		lines.push("RECRUIT:");
		lines.push(...recruits);
	}
	if (other.length > 0) {
		lines.push("OTHER:");
		lines.push(...other);
	}

	return lines.join("\n");
}