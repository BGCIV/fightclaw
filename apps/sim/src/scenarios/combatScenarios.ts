import type { ScenarioName } from "../boardgameio/types";
import { Engine } from "../engineAdapter";
import type { AgentId, EngineConfigInput, MatchState } from "../types";

const BOARD_17_CANONICAL_COL_MAP = [
	0, 1, 2, 3, 4, 5, 6, 7, 10, 13, 14, 15, 16, 17, 18, 19, 20,
] as const;

type UnitType = "infantry" | "cavalry" | "archer";
type UnitOwner = "A" | "B";
type UnitPlacement = readonly [
	unitId: string,
	unitType: UnitType,
	owner: UnitOwner,
	position: string,
];
type FormationLayoutName = "frontline" | "staggered" | "blitz";

const FORMATION_LAYOUTS: Record<
	FormationLayoutName,
	{ A: readonly string[]; B: readonly string[] }
> = {
	frontline: {
		A: ["D10", "E10", "F10", "D9", "E9", "F9"],
		B: ["D11", "E11", "F11", "D12", "E12", "F12"],
	},
	staggered: {
		A: ["C8", "E8", "G8", "D7", "E7", "F7"],
		B: ["C13", "E13", "G13", "D14", "E14", "F14"],
	},
	blitz: {
		A: ["D9", "E9", "F9", "D8", "E8", "F8"],
		B: ["D10", "E10", "F10", "D11", "E11", "F11"],
	},
};

const COMPOSITION_SCENARIOS: Partial<
	Record<
		ScenarioName,
		{ layout: FormationLayoutName; aType: UnitType; bType: UnitType }
	>
> = {
	all_infantry: { layout: "staggered", aType: "infantry", bType: "infantry" },
	all_cavalry: { layout: "blitz", aType: "cavalry", bType: "cavalry" },
	all_archer: { layout: "frontline", aType: "archer", bType: "archer" },
	infantry_archer: {
		layout: "frontline",
		aType: "infantry",
		bType: "archer",
	},
	cavalry_archer: {
		layout: "frontline",
		aType: "cavalry",
		bType: "archer",
	},
	infantry_cavalry: {
		layout: "frontline",
		aType: "infantry",
		bType: "cavalry",
	},
};

const STATIC_SCENARIO_PLACEMENTS: Partial<
	Record<ScenarioName, readonly UnitPlacement[]>
> = {
	melee: [
		["A-1", "infantry", "A", "F9"],
		["A-2", "cavalry", "A", "G9"],
		["A-3", "archer", "A", "E9"],
		["B-1", "infantry", "B", "G10"],
		["B-2", "cavalry", "B", "F10"],
		["B-3", "archer", "B", "H10"],
	],
	ranged: [
		["A-1", "archer", "A", "F8"],
		["A-2", "archer", "A", "G8"],
		["B-1", "infantry", "B", "F11"],
		["B-2", "cavalry", "B", "G11"],
	],
	stronghold_rush: [
		["A-1", "cavalry", "A", "C3"],
		["A-2", "infantry", "A", "C2"],
		["B-1", "cavalry", "B", "B20"],
	],
	midfield: [
		["A-1", "infantry", "A", "D10"],
		["A-2", "infantry", "A", "E10"],
		["A-3", "infantry", "A", "F10"],
		["A-4", "cavalry", "A", "D9"],
		["A-5", "cavalry", "A", "F9"],
		["A-6", "archer", "A", "E9"],
		["B-1", "infantry", "B", "D11"],
		["B-2", "infantry", "B", "E11"],
		["B-3", "infantry", "B", "F11"],
		["B-4", "cavalry", "B", "D12"],
		["B-5", "cavalry", "B", "F12"],
		["B-6", "archer", "B", "E12"],
	],
	high_ground_clash: [
		["A-1", "infantry", "A", "D10"],
		["A-2", "cavalry", "A", "E10"],
		["A-3", "archer", "A", "C10"],
		["B-1", "infantry", "B", "D12"],
		["B-2", "cavalry", "B", "E12"],
		["B-3", "archer", "B", "F12"],
	],
	forest_chokepoints: [
		["A-1", "infantry", "A", "C9"],
		["A-2", "cavalry", "A", "D8"],
		["A-3", "archer", "A", "E9"],
		["B-1", "infantry", "B", "C11"],
		["B-2", "cavalry", "B", "D12"],
		["B-3", "archer", "B", "E11"],
	],
	resource_race: [
		["A-1", "infantry", "A", "D6"],
		["A-2", "cavalry", "A", "C8"],
		["A-3", "archer", "A", "E9"],
		["B-1", "infantry", "B", "D16"],
		["B-2", "cavalry", "B", "G14"],
		["B-3", "archer", "B", "E13"],
	],
};

/**
 * Create an initial MatchState with units placed for immediate combat according to the chosen scenario.
 *
 * Initializes the engine state, clears any default units and board unitIds, then applies either a composition layout
 * or static unit placements for the provided scenario so the resulting state is ready for combat testing.
 *
 * @param scenario - The scenario name that determines unit placement (defaults to "melee")
 * @returns The initialized MatchState with units positioned for combat
 */
export function createCombatScenario(
	seed: number,
	players: AgentId[],
	scenario: ScenarioName = "melee",
	engineConfig?: EngineConfigInput,
): MatchState {
	const state = Engine.createInitialState(seed, players, engineConfig);
	resetScenarioState(state);

	const composition = COMPOSITION_SCENARIOS[scenario];
	if (composition) {
		addComposition(
			state,
			composition.layout,
			composition.aType,
			composition.bType,
		);
		return state;
	}

	addPlacements(state, STATIC_SCENARIO_PLACEMENTS[scenario] ?? []);
	return state;
}

/**
 * Clears all unit lists from both players and removes unit references from every board hex.
 *
 * This mutates the provided match state by emptying players.A.units and players.B.units
 * and setting each hex.unitIds to an empty array.
 *
 * @param state - The match state to reset for scenario placement
 */
function resetScenarioState(state: MatchState) {
	state.players.A.units = [];
	state.players.B.units = [];
	state.board.forEach((hex) => {
		hex.unitIds = [];
	});
}

/**
 * Apply a list of unit placements to the given match state.
 *
 * @param state - The match state to modify
 * @param placements - Readonly array of unit placement tuples `[unitId, unitType, owner, position]` to add to the state
 */
function addPlacements(
	state: MatchState,
	placements: readonly UnitPlacement[],
) {
	for (const [unitId, unitType, owner, position] of placements) {
		addUnitToState(state, unitId, unitType, owner, position);
	}
}

/**
 * Populate the match state with units for both players according to a named formation layout.
 *
 * @param state - The match state to modify by adding units
 * @param layoutName - The formation layout to use for positioning units
 * @param aType - Unit type to assign to player A's formation
 * @param bType - Unit type to assign to player B's formation
 */
function addComposition(
	state: MatchState,
	layoutName: FormationLayoutName,
	aType: UnitType,
	bType: UnitType,
) {
	const layout = FORMATION_LAYOUTS[layoutName];
	addFormationUnits(state, "A", aType, layout.A);
	addFormationUnits(state, "B", bType, layout.B);
}

/**
 * Adds a formation of units for a given owner at the specified board positions.
 *
 * Each unit is created with `unitType`, placed at the corresponding entry in `positions`,
 * and assigned a sequential id of the form `<owner>-<n>` (starting at 1).
 *
 * @param state - The match state to modify
 * @param owner - Owner identifier used for created unit ids and ownership
 * @param unitType - Type assigned to every unit in the formation
 * @param positions - Ordered list of board coordinates where units will be placed; the nth entry produces an id of `<owner>-<n>`
 */
function addFormationUnits(
	state: MatchState,
	owner: UnitOwner,
	unitType: UnitType,
	positions: readonly string[],
) {
	for (const [index, position] of positions.entries()) {
		addUnitToState(state, `${owner}-${index + 1}`, unitType, owner, position);
	}
}

/**
 * Place a unit into the match state at the given scenario coordinate, relocating to the nearest empty hex in the same row if the target is occupied.
 *
 * Mutates `state` by adding a new unit object to `state.players[owner].units` and appending `unitId` to the destination hex's `unitIds`. If the requested position cannot be resolved to a board hex or no empty hex is found in the row, the state is left unchanged.
 *
 * @param state - The match state to modify
 * @param unitId - The unique identifier to assign to the new unit
 * @param unitType - The unit's type, which determines its initial HP values
 * @param owner - The unit owner (`"A"` or `"B"`)
 * @param position - A scenario coordinate to place the unit; this may be resolved or remapped (including canonical 17-column mapping), and if occupied the unit will be moved to the nearest empty hex in the same row
 */
function addUnitToState(
	state: MatchState,
	unitId: string,
	unitType: UnitType,
	owner: UnitOwner,
	position: string,
) {
	let resolvedPosition = resolveScenarioHex(state, position);
	let hex = getHexById(state, resolvedPosition);
	if (!hex) return;
	if (hex.unitIds.length > 0) {
		const relocated = findNearestEmptyInRow(state, resolvedPosition);
		if (!relocated) return;
		resolvedPosition = relocated;
		hex = getHexById(state, resolvedPosition);
		if (!hex) return;
	}

	const unit = {
		id: unitId,
		type: unitType,
		owner,
		position: resolvedPosition,
		hp: unitType === "infantry" ? 3 : 2,
		maxHp: unitType === "infantry" ? 3 : 2,
		isFortified: false,
		movedThisTurn: false,
		movedDistance: 0,
		attackedThisTurn: false,
		canActThisTurn: true,
	};

	state.players[owner].units.push(unit as Unit);
	hex.unitIds.push(unitId);
}

/**
 * Retrieve a board hex by its identifier.
 *
 * @param state - The match state containing the board
 * @param id - The hex identifier to look up (e.g., "A1")
 * @returns The hex with the matching `id`, or `undefined` if no match exists
 */
function getHexById(state: MatchState, id: string) {
	return state.board.find((hex) => hex.id === id);
}

/**
 * Map a requested hex coordinate to the board's canonical coordinate when using the 17-column layout.
 *
 * If `requested` is not a valid hex coordinate, the board does not have 17 columns, or the requested column is invalid, the original `requested` string is returned. Otherwise the requested canonical column is mapped (or rounded to the nearest mapped column) using the 17-column canonical column map and the resulting row+column string is returned.
 *
 * @param state - Current match state used to determine the board's column count and mapping
 * @param requested - Hex coordinate string (e.g., "A5")
 * @returns The resolved hex coordinate string; returns `requested` unchanged if no mapping is applied
 */
function resolveScenarioHex(state: MatchState, requested: string): string {
	const coord = parseHexCoordinate(requested);
	if (!coord) return requested;
	const canonicalCol = coord.col - 1;
	if (!Number.isFinite(canonicalCol) || canonicalCol < 0) return requested;

	const cols = boardColumns(state);
	if (cols !== 17) return requested;

	const map = BOARD_17_CANONICAL_COL_MAP as readonly number[];
	const exact = map.indexOf(canonicalCol);
	if (exact >= 0) return `${coord.row}${exact + 1}`;

	let nearestIndex = 0;
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (let i = 0; i < map.length; i++) {
		const distance = Math.abs(map[i]! - canonicalCol);
		if (distance < nearestDistance) {
			nearestDistance = distance;
			nearestIndex = i;
		}
	}
	return `${coord.row}${nearestIndex + 1}`;
}

/**
 * Determines the number of columns in the match board.
 *
 * @param state - The current match state containing the board array
 * @returns The board's column count (floor of `state.board.length / 9`)
 */
function boardColumns(state: MatchState): number {
	return Math.floor(state.board.length / 9);
}

/**
 * Finds the nearest empty hex in the same row as a given position.
 *
 * @param state - Current match state
 * @param position - Hex coordinate (row letter A-I followed by column number) to search from
 * @returns The coordinate of the nearest empty hex in the same row, or `undefined` if none is available
 */
function findNearestEmptyInRow(
	state: MatchState,
	position: string,
): string | undefined {
	const coord = parseHexCoordinate(position);
	if (!coord) return undefined;
	const row = coord.row;
	const col = coord.col;
	if (!Number.isFinite(col) || col < 1) return undefined;

	const cols = boardColumns(state);
	const isEmpty = (candidateCol: number) => {
		const id = `${row}${candidateCol}`;
		const hex = getHexById(state, id);
		return hex ? hex.unitIds.length === 0 : false;
	};
	if (isEmpty(col)) return `${row}${col}`;

	for (let d = 1; d < cols; d++) {
		const right = col + d;
		if (right <= cols && isEmpty(right)) return `${row}${right}`;
		const left = col - d;
		if (left >= 1 && isEmpty(left)) return `${row}${left}`;
	}
	return undefined;
}

/**
 * Parse a hex grid coordinate string into its row letter and 1-based column number.
 *
 * @param value - Coordinate in the form `A1` through `I<number>` (row A–I followed by a positive integer)
 * @returns An object `{ row, col }` with `row` as the letter and `col` as the column number when valid, `undefined` otherwise
 */
function parseHexCoordinate(
	value: string,
): { row: string; col: number } | undefined {
	const match = /^([A-I])(\d+)$/.exec(value);
	if (!match) return undefined;
	const row = match[1] ?? "";
	const col = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isFinite(col) || col < 1) return undefined;
	return { row, col };
}

// Type augmentation
interface Unit {
	id: string;
	type: UnitType;
	owner: UnitOwner;
	position: string;
	hp: number;
	maxHp: number;
	isFortified: boolean;
	movedThisTurn: boolean;
	movedDistance: number;
	attackedThisTurn: boolean;
	canActThisTurn: boolean;
}