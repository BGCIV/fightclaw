# Algebraic Notation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a chess-inspired algebraic notation system so Fightclaw sub-agents read/write compact text instead of verbose JSON — giving them spatial awareness via a board grid and cutting per-turn tokens by ~30%.

**Architecture:** A single TypeScript module (`fightclaw-notation.ts`) exports three pure functions: `stateToNotation`, `parseMove`, and `renderBoard`. The existing shell turn helper (`fightclaw-turn-helper.sh`) gains an `--algebraic {side}` flag that pipes through these functions transparently. The sub-agent never sees JSON.

**Tech Stack:** TypeScript, `@fightclaw/engine` types, Node built-in test runner via `tsx --test`

**Spec:** `docs/superpowers/specs/2026-03-23-algebraic-notation-design.md`

---

## File Structure

| File | Role |
|------|------|
| `apps/openclaw-runner/scripts/fightclaw-notation.ts` | **New** — notation module (stateToNotation, parseMove, renderBoard) |
| `apps/openclaw-runner/test/fightclaw-notation.test.ts` | **New** — unit + integration tests |
| `apps/openclaw-runner/scripts/fightclaw-turn-helper.sh` | **Modify** — add `--algebraic {side}` flag |
| `apps/openclaw-runner/skills/fightclaw-arena/references/subagent-match-loop.md` | **Modify** — replace JSON examples with algebraic notation |
| `skills/fightclaw-arena/SKILL.md` | **Modify** — update spawn task to use `--algebraic` flag |

All files live in `apps/openclaw-runner/` except the top-level skill mirror in `skills/`.

---

## Shared Constants & Helpers (used across tasks)

These will be defined at the top of `fightclaw-notation.ts` and referenced by all three exported functions:

```ts
import type { MatchState, Move, Unit, HexState, HexType, PlayerSide, UnitType } from "@fightclaw/engine";

// Piece code mapping: engine UnitType → single-char notation code
const PIECE_CODE: Record<UnitType, string> = {
  infantry: "I", cavalry: "C", archer: "A",
  swordsman: "S", knight: "K", crossbow: "X",
};

// Reverse: notation code → engine UnitType (base types only for recruit)
const CODE_TO_BASE_UNIT: Record<string, "infantry" | "cavalry" | "archer"> = {
  I: "infantry", C: "cavalry", A: "archer",
};

// Terrain display markers (4 chars wide for grid alignment)
const TERRAIN_MARKER: Record<string, string> = {
  stronghold_a: "[SA]", stronghold_b: "[SB]",
  crown: "*Cr*", gold_mine: "$G$", lumber_camp: "$W$",
  high_ground: "^H^", forest: "~F~", hills: "^h^",
  plains: " .  ", deploy_a: " .  ", deploy_b: " .  ",
};

const ROW_LETTERS = "ABCDEFGHI";

/**
 * Extract the numeric suffix from a unit ID like "A-1" → 1, "B-12" → 12.
 */
function unitNum(unitId: string): number {
  return Number(unitId.split("-")[1]);
}

/**
 * Get the piece code for a unit, applying case for perspective.
 * own=true → uppercase ("I"), own=false → lowercase ("i").
 */
function pieceTag(unit: Unit, mySide: PlayerSide): string {
  const code = PIECE_CODE[unit.type];
  return unit.owner === mySide ? code : code.toLowerCase();
}
```

---

## Task 1: `parseMove` — Notation String → Wire JSON

The simplest function. No board rendering, no state traversal. Pure string parsing.

**Files:**
- Create: `apps/openclaw-runner/scripts/fightclaw-notation.ts` (initial scaffold with parseMove)
- Test: `apps/openclaw-runner/test/fightclaw-notation.test.ts`

### Step 1.1: Write failing tests for parseMove

- [ ] **Write tests**

```ts
// apps/openclaw-runner/test/fightclaw-notation.test.ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseMove } from "../scripts/fightclaw-notation.ts";

describe("parseMove", () => {
  test("move: I1-D5 as side A", () => {
    assert.deepEqual(parseMove("I1-D5", "A"), {
      action: "move", unitId: "A-1", to: "D5",
    });
  });

  test("move: I1-D5 as side B", () => {
    assert.deepEqual(parseMove("I1-D5", "B"), {
      action: "move", unitId: "B-1", to: "D5",
    });
  });

  test("attack: A3xG6", () => {
    assert.deepEqual(parseMove("A3xG6", "A"), {
      action: "attack", unitId: "A-3", target: "G6",
    });
  });

  test("recruit: +I@B2", () => {
    assert.deepEqual(parseMove("+I@B2", "A"), {
      action: "recruit", unitType: "infantry", at: "B2",
    });
  });

  test("recruit cavalry: +C@A1", () => {
    assert.deepEqual(parseMove("+C@A1", "B"), {
      action: "recruit", unitType: "cavalry", at: "A1",
    });
  });

  test("recruit archer: +A@H16", () => {
    assert.deepEqual(parseMove("+A@H16", "A"), {
      action: "recruit", unitType: "archer", at: "H16",
    });
  });

  test("fortify: I1f", () => {
    assert.deepEqual(parseMove("I1f", "A"), {
      action: "fortify", unitId: "A-1",
    });
  });

  test("upgrade: I1^", () => {
    assert.deepEqual(parseMove("I1^", "B"), {
      action: "upgrade", unitId: "B-1",
    });
  });

  test("end turn: ET", () => {
    assert.deepEqual(parseMove("ET", "A"), { action: "end_turn" });
  });

  test("pass: --", () => {
    assert.deepEqual(parseMove("--", "A"), { action: "pass" });
  });

  test("high unit number: C12-E9", () => {
    assert.deepEqual(parseMove("C12-E9", "A"), {
      action: "move", unitId: "A-12", to: "E9",
    });
  });

  test("swordsman move: S1-D5", () => {
    assert.deepEqual(parseMove("S1-D5", "A"), {
      action: "move", unitId: "A-1", to: "D5",
    });
  });

  test("knight attack: K2xF8", () => {
    assert.deepEqual(parseMove("K2xF8", "B"), {
      action: "attack", unitId: "B-2", target: "F8",
    });
  });

  test("crossbow upgrade: X3^", () => {
    assert.deepEqual(parseMove("X3^", "A"), {
      action: "upgrade", unitId: "A-3",
    });
  });

  test("throws on invalid notation", () => {
    assert.throws(() => parseMove("ZZZZZ", "A"), /invalid notation/i);
  });

  test("throws on empty string", () => {
    assert.throws(() => parseMove("", "A"), /invalid notation/i);
  });
});
```

- [ ] **Run tests to verify they fail**

Run: `cd apps/openclaw-runner && npx tsx --test test/fightclaw-notation.test.ts`
Expected: FAIL — module does not exist yet

### Step 1.2: Implement parseMove

- [ ] **Create fightclaw-notation.ts with parseMove**

```ts
// apps/openclaw-runner/scripts/fightclaw-notation.ts
import type {
  MatchState, Move, Unit, HexState, HexType,
  PlayerSide, UnitType, BaseUnitType,
} from "@fightclaw/engine";

const PIECE_CODE: Record<UnitType, string> = {
  infantry: "I", cavalry: "C", archer: "A",
  swordsman: "S", knight: "K", crossbow: "X",
};

const CODE_TO_BASE_UNIT: Record<string, BaseUnitType> = {
  I: "infantry", C: "cavalry", A: "archer",
};

// All valid piece codes (base + tier 2) for move/attack/fortify/upgrade parsing
const ALL_PIECE_CODES = new Set(Object.values(PIECE_CODE));

const ROW_LETTERS = "ABCDEFGHI";

function unitNum(unitId: string): number {
  return Number(unitId.split("-")[1]);
}

function pieceTag(unit: Unit, mySide: PlayerSide): string {
  const code = PIECE_CODE[unit.type];
  return unit.owner === mySide ? code : code.toLowerCase();
}

/**
 * Parse algebraic notation into wire-format Move JSON.
 *
 * Notation patterns:
 *   Move:    {piece}{num}-{cell}   e.g. I1-D5
 *   Attack:  {piece}{num}x{cell}   e.g. A3xG6
 *   Recruit: +{piece}@{cell}       e.g. +I@B2
 *   Fortify: {piece}{num}f         e.g. I1f
 *   Upgrade: {piece}{num}^         e.g. I1^
 *   End:     ET
 *   Pass:    --
 */
export function parseMove(notation: string, mySide: PlayerSide): Move {
  if (!notation) throw new Error("Invalid notation: empty string");

  // End turn
  if (notation === "ET") return { action: "end_turn" };
  // Pass
  if (notation === "--") return { action: "pass" };

  // Recruit: +{piece}@{cell}
  if (notation.startsWith("+")) {
    const match = notation.match(/^\+([ICASKX])@([A-I]\d{1,2})$/);
    if (!match) throw new Error(`Invalid notation: "${notation}"`);
    const unitType = CODE_TO_BASE_UNIT[match[1]];
    if (!unitType) throw new Error(`Invalid notation: "${notation}" — only base units (I/C/A) can be recruited`);
    return { action: "recruit", unitType, at: match[2] };
  }

  // Unit actions: {piece}{num}{operator}{cell?}
  // Piece code is one uppercase letter, num is 1+ digits
  const unitMatch = notation.match(/^([ICASKX])(\d+)(.+)$/);
  if (!unitMatch) throw new Error(`Invalid notation: "${notation}"`);

  const [, , numStr, rest] = unitMatch;
  const unitId = `${mySide}-${numStr}`;

  // Fortify: ends with 'f'
  if (rest === "f") return { action: "fortify", unitId };

  // Upgrade: ends with '^'
  if (rest === "^") return { action: "upgrade", unitId };

  // Move: -{cell}
  const moveMatch = rest.match(/^-([A-I]\d{1,2})$/);
  if (moveMatch) return { action: "move", unitId, to: moveMatch[1] };

  // Attack: x{cell}
  const attackMatch = rest.match(/^x([A-I]\d{1,2})$/);
  if (attackMatch) return { action: "attack", unitId, target: attackMatch[1] };

  throw new Error(`Invalid notation: "${notation}"`);
}
```

- [ ] **Run tests to verify they pass**

Run: `cd apps/openclaw-runner && npx tsx --test test/fightclaw-notation.test.ts`
Expected: All parseMove tests PASS

- [ ] **Commit**

```bash
git add apps/openclaw-runner/scripts/fightclaw-notation.ts apps/openclaw-runner/test/fightclaw-notation.test.ts
git commit -m "feat: add parseMove for algebraic notation"
```

---

## Task 2: `renderBoard` — Game State → Board Grid

Renders the 17×9 hex grid with terrain markers and unit positions.

**Files:**
- Modify: `apps/openclaw-runner/scripts/fightclaw-notation.ts` (add renderBoard + helpers)
- Modify: `apps/openclaw-runner/test/fightclaw-notation.test.ts` (add renderBoard tests)

### Step 2.1: Write failing tests for renderBoard

- [ ] **Write tests**

Add to `test/fightclaw-notation.test.ts`:

```ts
import { createInitialState, listLegalMoves } from "@fightclaw/engine";
import { parseMove, renderBoard } from "../scripts/fightclaw-notation.ts";

describe("renderBoard", () => {
  test("empty board has correct dimensions (9 rows, 17 columns)", () => {
    const state = createInitialState(1, undefined, ["agent-a", "agent-b"]);
    // Clear all units for a clean board
    state.players.A.units = [];
    state.players.B.units = [];
    state.board.forEach(h => { h.unitIds = []; });

    const board = renderBoard(state, "A");
    const lines = board.split("\n");
    // 9 row lines + 1 header line (column numbers)
    assert.equal(lines.length, 10);
    // Each row starts with "X:" where X is A-I
    for (let i = 1; i < lines.length; i++) {
      assert.match(lines[i], /^[A-I]:/);
    }
  });

  test("strongholds render at B2 and H2 for side A, B16 and H16 for side B", () => {
    const state = createInitialState(1, undefined, ["agent-a", "agent-b"]);
    state.players.A.units = [];
    state.players.B.units = [];
    state.board.forEach(h => { h.unitIds = []; });

    const board = renderBoard(state, "A");
    // Row B should contain [SA] (stronghold A)
    const rowB = board.split("\n").find(l => l.startsWith("B:"));
    assert.ok(rowB, "Row B should exist");
    assert.ok(rowB.includes("[SA]"), `Row B should contain [SA], got: ${rowB}`);
    assert.ok(rowB.includes("[SB]"), `Row B should contain [SB], got: ${rowB}`);

    // Row H should also contain strongholds
    const rowH = board.split("\n").find(l => l.startsWith("H:"));
    assert.ok(rowH, "Row H should exist");
    assert.ok(rowH.includes("[SA]"), `Row H should contain [SA], got: ${rowH}`);
    assert.ok(rowH.includes("[SB]"), `Row H should contain [SB], got: ${rowH}`);
  });

  test("unit at a position overrides terrain marker", () => {
    const state = createInitialState(1, undefined, ["agent-a", "agent-b"]);
    // Place a single infantry at a known position
    state.players.A.units = [{
      id: "A-1", type: "infantry", owner: "A", position: "E9",
      hp: 3, maxHp: 3, isFortified: false,
      movedThisTurn: false, movedDistance: 0,
      attackedThisTurn: false, canActThisTurn: true,
    }];
    state.players.B.units = [];
    state.board.forEach(h => { h.unitIds = []; });
    const hex = state.board.find(h => h.id === "E9");
    if (hex) hex.unitIds = ["A-1"];

    const board = renderBoard(state, "A");
    const rowE = board.split("\n").find(l => l.startsWith("E:"));
    assert.ok(rowE, "Row E should exist");
    // I1 should appear (uppercase = own unit, infantry = I, num = 1)
    assert.ok(rowE.includes("I1"), `Row E should contain I1, got: ${rowE}`);
  });

  test("enemy units render lowercase", () => {
    const state = createInitialState(1, undefined, ["agent-a", "agent-b"]);
    state.players.A.units = [];
    state.players.B.units = [{
      id: "B-3", type: "cavalry", owner: "B", position: "D5",
      hp: 2, maxHp: 2, isFortified: false,
      movedThisTurn: false, movedDistance: 0,
      attackedThisTurn: false, canActThisTurn: true,
    }];
    state.board.forEach(h => { h.unitIds = []; });
    const hex = state.board.find(h => h.id === "D5");
    if (hex) hex.unitIds = ["B-3"];

    const board = renderBoard(state, "A");
    const rowD = board.split("\n").find(l => l.startsWith("D:"));
    assert.ok(rowD, "Row D should exist");
    // c3 = lowercase cavalry, enemy, num 3
    assert.ok(rowD.includes("c3"), `Row D should contain c3, got: ${rowD}`);
  });

  test("terrain types render correct markers", () => {
    const state = createInitialState(1, undefined, ["agent-a", "agent-b"]);
    state.players.A.units = [];
    state.players.B.units = [];
    state.board.forEach(h => { h.unitIds = []; });

    const board = renderBoard(state, "A");
    // Crown is at E9 on the 17-col board (canonical col 11 = crown)
    const rowE = board.split("\n").find(l => l.startsWith("E:"));
    assert.ok(rowE?.includes("*Cr*"), `Row E should contain crown, got: ${rowE}`);
    // Gold mines should appear
    assert.ok(board.includes("$G$"), "Board should contain gold mine markers");
    // Forest should appear
    assert.ok(board.includes("~F~"), "Board should contain forest markers");
  });
});
```

- [ ] **Run tests to verify they fail**

Run: `cd apps/openclaw-runner && npx tsx --test test/fightclaw-notation.test.ts`
Expected: FAIL — `renderBoard` is not exported yet

### Step 2.2: Implement renderBoard

- [ ] **Add renderBoard to fightclaw-notation.ts**

Add after `parseMove` in the same file:

```ts
const TERRAIN_MARKER: Partial<Record<HexType, string>> = {
  stronghold_a: "[SA]", stronghold_b: "[SB]",
  crown: "*Cr*", gold_mine: "$G$", lumber_camp: "$W$",
  high_ground: "^H^", forest: "~F~", hills: "^h^",
};

// Default marker for terrain types not in the map (plains, deploy_a, deploy_b)
const DEFAULT_MARKER = " .  ";

/**
 * Render the board grid as a text string.
 * Returns column header + 9 row lines (A-I), each cell 4 chars wide.
 * Units override terrain at their position.
 */
export function renderBoard(state: MatchState, mySide: PlayerSide): string {
  const cols = inferColumns(state);

  // Build unit lookup: hexId → Unit
  const unitAt = new Map<string, Unit>();
  for (const unit of [...state.players.A.units, ...state.players.B.units]) {
    unitAt.set(unit.position, unit);
  }

  // Column header
  const colNums = Array.from({ length: cols }, (_, i) => String(i + 1).padStart(4));
  const header = "   " + colNums.join("");

  const rows: string[] = [header];
  for (let r = 0; r < 9; r++) {
    const rowLabel = ROW_LETTERS[r] + ":";
    let rowStr = rowLabel;
    for (let c = 0; c < cols; c++) {
      const hex = state.board[r * cols + c];
      const unit = hex ? unitAt.get(hex.id) : undefined;
      if (unit) {
        // Unit display: piece code + unit num, padded to 4 chars
        const tag = pieceTag(unit, mySide);
        const num = unitNum(unit.id);
        const cell = ` ${tag}${num}`;
        rowStr += cell.padEnd(4);
      } else {
        const marker = hex ? (TERRAIN_MARKER[hex.type] ?? DEFAULT_MARKER) : DEFAULT_MARKER;
        rowStr += marker;
      }
    }
    rows.push(rowStr);
  }
  return rows.join("\n");
}

/** Infer board column count from state. */
function inferColumns(state: MatchState): number {
  const total = state.board.length;
  const cols = total / 9;
  if (cols !== 17 && cols !== 21) {
    throw new Error(`Unexpected board size: ${total} hexes (expected 153 or 189)`);
  }
  return cols;
}
```

- [ ] **Run tests to verify they pass**

Run: `cd apps/openclaw-runner && npx tsx --test test/fightclaw-notation.test.ts`
Expected: All tests PASS

- [ ] **Commit**

```bash
git add apps/openclaw-runner/scripts/fightclaw-notation.ts apps/openclaw-runner/test/fightclaw-notation.test.ts
git commit -m "feat: add renderBoard for algebraic notation"
```

---

## Task 3: `stateToNotation` — Full State → Complete Notation Block

Combines header, resources, board, roster, and legal moves into the complete text output.

**Files:**
- Modify: `apps/openclaw-runner/scripts/fightclaw-notation.ts` (add stateToNotation + helpers)
- Modify: `apps/openclaw-runner/test/fightclaw-notation.test.ts` (add stateToNotation tests)

### Step 3.1: Write failing tests for unit roster + legal moves helpers

- [ ] **Write tests for moveToNotation (internal helper, tested via stateToNotation)**

Add to `test/fightclaw-notation.test.ts`:

```ts
import { parseMove, renderBoard, stateToNotation } from "../scripts/fightclaw-notation.ts";

describe("stateToNotation", () => {
  function makeTestState(): MatchState {
    const state = createInitialState(42, undefined, ["agent-a", "agent-b"]);
    // Clear default units and place specific ones for predictable output
    state.players.A.units = [{
      id: "A-1", type: "infantry", owner: "A", position: "C3",
      hp: 3, maxHp: 3, isFortified: false,
      movedThisTurn: false, movedDistance: 0,
      attackedThisTurn: false, canActThisTurn: true,
    }];
    state.players.B.units = [{
      id: "B-4", type: "archer", owner: "B", position: "E12",
      hp: 2, maxHp: 2, isFortified: true,
      movedThisTurn: false, movedDistance: 0,
      attackedThisTurn: false, canActThisTurn: true,
    }];
    state.board.forEach(h => { h.unitIds = []; });
    const hexC3 = state.board.find(h => h.id === "C3");
    if (hexC3) hexC3.unitIds = ["A-1"];
    const hexE12 = state.board.find(h => h.id === "E12");
    if (hexE12) hexE12.unitIds = ["B-4"];
    state.turn = 5;
    state.activePlayer = "A";
    state.actionsRemaining = 7;
    state.players.A.gold = 30;
    state.players.A.wood = 5;
    state.players.A.vp = 2;
    state.players.B.gold = 25;
    state.players.B.wood = 3;
    state.players.B.vp = 1;
    return state;
  }

  test("header line contains turn, active player, actions, version", () => {
    const state = makeTestState();
    const legalMoves = listLegalMoves(state);
    const output = stateToNotation(state, legalMoves, "A", 42);
    const header = output.split("\n")[0];
    assert.match(header, /^T5 AP=A AR=7 V=42$/);
  });

  test("resource line shows both players", () => {
    const state = makeTestState();
    const legalMoves = listLegalMoves(state);
    const output = stateToNotation(state, legalMoves, "A", 42);
    const resLine = output.split("\n")[1];
    assert.match(resLine, /A: 30g 5w 2vp/);
    assert.match(resLine, /B: 25g 3w 1vp/);
  });

  test("unit roster shows own units as YOU, enemy as OPP", () => {
    const state = makeTestState();
    const legalMoves = listLegalMoves(state);
    const output = stateToNotation(state, legalMoves, "A", 42);
    // YOU line: I1@C3(3/3)
    assert.ok(output.includes("YOU: I1@C3(3/3)"), `Should contain YOU roster, got:\n${output}`);
    // OPP line: a4@E12(2/2)f (lowercase archer, fortified flag)
    assert.ok(output.includes("OPP: a4@E12(2/2)f"), `Should contain OPP roster, got:\n${output}`);
  });

  test("side flip: same state renders differently for B perspective", () => {
    const state = makeTestState();
    const legalMoves = listLegalMoves(state);
    const outputB = stateToNotation(state, legalMoves, "B", 42);
    // From B's perspective: B-4 is own → uppercase A4
    assert.ok(outputB.includes("YOU: A4@E12(2/2)f"), `B perspective should show A4 as own, got:\n${outputB}`);
    // A-1 is enemy → lowercase i1
    assert.ok(outputB.includes("OPP: i1@C3(3/3)"), `B perspective should show i1 as enemy, got:\n${outputB}`);
  });

  test("MOVES line contains legal moves in notation", () => {
    const state = makeTestState();
    const legalMoves = listLegalMoves(state);
    const output = stateToNotation(state, legalMoves, "A", 42);
    const movesLine = output.split("\n").find(l => l.startsWith("MOVES:"));
    assert.ok(movesLine, "Should have a MOVES line");
    // Should contain at least ET (end turn is always legal when active)
    assert.ok(movesLine.includes("ET"), `MOVES should contain ET, got: ${movesLine}`);
  });

  test("match ended: no MOVES line, shows winner", () => {
    const state = makeTestState();
    state.status = "ended";
    const output = stateToNotation(state, [], "A", 42);
    assert.ok(output.startsWith("MATCH ENDED"), `Should start with MATCH ENDED, got:\n${output}`);
    assert.ok(!output.includes("MOVES:"), "Should not have MOVES line when ended");
  });
});
```

- [ ] **Run tests to verify they fail**

Run: `cd apps/openclaw-runner && npx tsx --test test/fightclaw-notation.test.ts`
Expected: FAIL — `stateToNotation` is not exported yet

### Step 3.2: Implement stateToNotation

- [ ] **Add stateToNotation and moveToNotation to fightclaw-notation.ts**

```ts
/**
 * Convert a wire-format Move to algebraic notation.
 * This is the inverse of parseMove.
 */
function moveToNotation(move: Move, mySide: PlayerSide, units: Unit[]): string {
  switch (move.action) {
    case "end_turn": return "ET";
    case "pass": return "--";
    case "recruit": {
      const code = Object.entries(CODE_TO_BASE_UNIT).find(([, v]) => v === move.unitType)?.[0];
      return `+${code ?? "?"}@${move.at}`;
    }
    case "move": {
      const unit = units.find(u => u.id === move.unitId);
      const code = unit ? PIECE_CODE[unit.type] : "?";
      return `${code}${unitNum(move.unitId)}-${move.to}`;
    }
    case "attack": {
      const unit = units.find(u => u.id === move.unitId);
      const code = unit ? PIECE_CODE[unit.type] : "?";
      return `${code}${unitNum(move.unitId)}x${move.target}`;
    }
    case "fortify": {
      const unit = units.find(u => u.id === move.unitId);
      const code = unit ? PIECE_CODE[unit.type] : "?";
      return `${code}${unitNum(move.unitId)}f`;
    }
    case "upgrade": {
      const unit = units.find(u => u.id === move.unitId);
      const code = unit ? PIECE_CODE[unit.type] : "?";
      return `${code}${unitNum(move.unitId)}^`;
    }
  }
}

/**
 * Format a unit for the roster line.
 * Format: {code}{num}@{cell}({hp}/{maxHp}){flags}
 * Flags: f = fortified, * = already acted
 */
function unitRosterEntry(unit: Unit, mySide: PlayerSide): string {
  const code = pieceTag(unit, mySide);
  const num = unitNum(unit.id);
  let flags = "";
  if (unit.isFortified) flags += "f";
  if (unit.movedThisTurn || unit.attackedThisTurn) flags += "*";
  return `${code}${num}@${unit.position}(${unit.hp}/${unit.maxHp})${flags}`;
}

/**
 * Convert full game state + legal moves to algebraic notation text block.
 *
 * @param state - Engine MatchState
 * @param legalMoves - Array of legal Move objects (empty if match ended)
 * @param mySide - The agent's side ("A" or "B")
 * @param stateVersion - The stateVersion number from the match envelope
 * @returns Multi-line notation string
 */
export function stateToNotation(
  state: MatchState,
  legalMoves: Move[],
  mySide: PlayerSide,
  stateVersion: number,
): string {
  const myPlayer = state.players[mySide];
  const oppSide: PlayerSide = mySide === "A" ? "B" : "A";
  const oppPlayer = state.players[oppSide];
  const allUnits = [...state.players.A.units, ...state.players.B.units];

  // Match ended — special format
  if (state.status === "ended") {
    const lines: string[] = [];
    lines.push(`MATCH ENDED | Turn: ${state.turn}`);
    lines.push(`A: ${state.players.A.gold}g ${state.players.A.wood}w ${state.players.A.vp}vp | B: ${state.players.B.gold}g ${state.players.B.wood}w ${state.players.B.vp}vp`);
    lines.push(renderBoard(state, mySide));
    const myUnits = myPlayer.units.map(u => unitRosterEntry(u, mySide)).join(" ");
    const oppUnits = oppPlayer.units.map(u => unitRosterEntry(u, mySide)).join(" ");
    lines.push(`YOU: ${myUnits || "(none)"}`);
    lines.push(`OPP: ${oppUnits || "(none)"}`);
    return lines.join("\n");
  }

  // Active match
  const lines: string[] = [];

  // Header
  lines.push(`T${state.turn} AP=${state.activePlayer} AR=${state.actionsRemaining} V=${stateVersion}`);

  // Resources
  lines.push(`A: ${state.players.A.gold}g ${state.players.A.wood}w ${state.players.A.vp}vp | B: ${state.players.B.gold}g ${state.players.B.wood}w ${state.players.B.vp}vp`);

  // Board
  lines.push(renderBoard(state, mySide));

  // Roster
  const myUnits = myPlayer.units.map(u => unitRosterEntry(u, mySide)).join(" ");
  const oppUnits = oppPlayer.units.map(u => unitRosterEntry(u, mySide)).join(" ");
  lines.push(`YOU: ${myUnits || "(none)"}`);
  lines.push(`OPP: ${oppUnits || "(none)"}`);

  // Legal moves
  const activeUnits = state.players[state.activePlayer].units;
  const moveStrs = legalMoves.map(m => moveToNotation(m, mySide, activeUnits));
  lines.push(`MOVES: ${moveStrs.join(" ")}`);

  return lines.join("\n");
}
```

- [ ] **Run tests to verify they pass**

Run: `cd apps/openclaw-runner && npx tsx --test test/fightclaw-notation.test.ts`
Expected: All tests PASS

- [ ] **Commit**

```bash
git add apps/openclaw-runner/scripts/fightclaw-notation.ts apps/openclaw-runner/test/fightclaw-notation.test.ts
git commit -m "feat: add stateToNotation for algebraic notation"
```

---

## Task 4: Round-Trip Integration Test

Verifies that `stateToNotation` → pick a move from `MOVES:` line → `parseMove` → engine accepts it.

**Files:**
- Modify: `apps/openclaw-runner/test/fightclaw-notation.test.ts`

### Step 4.1: Write round-trip test

- [ ] **Write integration test**

Add to `test/fightclaw-notation.test.ts`:

```ts
import { createInitialState, listLegalMoves, applyMove } from "@fightclaw/engine";

describe("round-trip integration", () => {
  test("notation → parse → engine accepts the move", () => {
    const state = createInitialState(7, undefined, ["agent-a", "agent-b"]);
    const legalMoves = listLegalMoves(state);
    const mySide: PlayerSide = state.activePlayer;

    const notation = stateToNotation(state, legalMoves, mySide, 1);
    const movesLine = notation.split("\n").find(l => l.startsWith("MOVES:"));
    assert.ok(movesLine, "Should have MOVES line");

    const moveStrs = movesLine.replace("MOVES: ", "").split(" ");
    assert.ok(moveStrs.length > 0, "Should have at least one legal move");

    // Pick the first non-ET, non--- move (a unit action)
    const unitMove = moveStrs.find(m => m !== "ET" && m !== "--");
    if (!unitMove) return; // Only ET/-- available, skip

    const parsed = parseMove(unitMove, mySide);

    // Verify the parsed move is in the legal moves list
    const matching = legalMoves.find(lm => {
      if (lm.action !== parsed.action) return false;
      if ("unitId" in lm && "unitId" in parsed) return lm.unitId === parsed.unitId && (("to" in lm && "to" in parsed && lm.to === parsed.to) || ("target" in lm && "target" in parsed && lm.target === parsed.target) || lm.action === "fortify" || lm.action === "upgrade");
      if (lm.action === "recruit" && parsed.action === "recruit") return lm.unitType === parsed.unitType && lm.at === parsed.at;
      return lm.action === parsed.action;
    });
    assert.ok(matching, `Parsed move should match a legal move. Notation: ${unitMove}, Parsed: ${JSON.stringify(parsed)}`);

    // Verify engine accepts the move (doesn't throw)
    const result = applyMove(state, parsed);
    assert.ok(result, "Engine should accept the parsed move");
  });

  test("all moves in MOVES line round-trip cleanly", () => {
    const state = createInitialState(7, undefined, ["agent-a", "agent-b"]);
    const legalMoves = listLegalMoves(state);
    const mySide: PlayerSide = state.activePlayer;

    const notation = stateToNotation(state, legalMoves, mySide, 1);
    const movesLine = notation.split("\n").find(l => l.startsWith("MOVES:"));
    assert.ok(movesLine);

    const moveStrs = movesLine.replace("MOVES: ", "").split(" ");

    // Every notation string should parse without error
    for (const moveStr of moveStrs) {
      assert.doesNotThrow(() => parseMove(moveStr, mySide), `Should parse: ${moveStr}`);
    }

    // Count should match
    assert.equal(moveStrs.length, legalMoves.length,
      `Notation has ${moveStrs.length} moves but engine has ${legalMoves.length}`);
  });
});
```

- [ ] **Run tests to verify they pass**

Run: `cd apps/openclaw-runner && npx tsx --test test/fightclaw-notation.test.ts`
Expected: All tests PASS (these test existing code, should pass immediately)

Note: If `applyMove` is not exported from the engine, replace with a membership check against `listLegalMoves`. Check engine exports first:

```bash
grep "export.*applyMove\|export.*function applyMove" packages/engine/src/index.ts
```

If not exported, drop the `applyMove` assertion and keep only the membership check.

- [ ] **Commit**

```bash
git add apps/openclaw-runner/test/fightclaw-notation.test.ts
git commit -m "test: add round-trip integration test for algebraic notation"
```

---

## Task 5: Turn Helper Shell Integration

Add `--algebraic {side}` flag to `fightclaw-turn-helper.sh` so the sub-agent gets text output.

**Files:**
- Modify: `apps/openclaw-runner/scripts/fightclaw-turn-helper.sh`
- Create: `apps/openclaw-runner/scripts/fightclaw-notation-cli.ts` (CLI wrapper that reads stdin JSON + outputs notation)

The shell script can't directly call TypeScript functions, so we create a small CLI entrypoint that the shell script pipes through.

### Step 5.1: Write the notation CLI wrapper

- [ ] **Create fightclaw-notation-cli.ts**

```ts
// apps/openclaw-runner/scripts/fightclaw-notation-cli.ts
//
// CLI wrapper for algebraic notation.
// Reads JSON state from stdin, outputs notation text to stdout.
//
// Usage:
//   echo $JSON | node fightclaw-notation-cli.mjs --side A --version 42
//   echo $NOTATION | node fightclaw-notation-cli.mjs --parse --side A
//
// Modes:
//   Default (no --parse): reads state+legalMoves JSON, outputs notation text
//   --parse: reads a single notation string from stdin, outputs Move JSON

import { listLegalMoves, type MatchState } from "@fightclaw/engine";
import type { PlayerSide } from "@fightclaw/engine";
import { stateToNotation, parseMove } from "./fightclaw-notation.ts";

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
};

const args = process.argv.slice(2);
const sideIdx = args.indexOf("--side");
const side = (sideIdx >= 0 ? args[sideIdx + 1] : "A") as PlayerSide;
const versionIdx = args.indexOf("--version");
const version = versionIdx >= 0 ? Number(args[versionIdx + 1]) : 0;
const isParseMode = args.includes("--parse");

const main = async () => {
  const raw = await readStdin();
  if (!raw) {
    process.stderr.write("No input on stdin\n");
    process.exit(1);
  }

  if (isParseMode) {
    // Parse notation → Move JSON
    try {
      const move = parseMove(raw, side);
      process.stdout.write(JSON.stringify(move));
    } catch (err) {
      process.stderr.write(`ERR: ${(err as Error).message}\n`);
      process.exit(1);
    }
    return;
  }

  // State → Notation
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write("ERR: Invalid JSON on stdin\n");
    process.exit(1);
  }

  const obj = parsed as Record<string, unknown>;
  const gameState = obj.game as MatchState;
  if (!gameState?.board) {
    process.stderr.write("ERR: No game state found in input\n");
    process.exit(1);
  }

  const legalMoves = gameState.status === "ended" ? [] : listLegalMoves(gameState);
  const output = stateToNotation(gameState, legalMoves, side, version);
  process.stdout.write(output + "\n");
};

void main();
```

- [ ] **Commit**

```bash
git add apps/openclaw-runner/scripts/fightclaw-notation-cli.ts
git commit -m "feat: add notation CLI wrapper for shell integration"
```

### Step 5.2: Modify fightclaw-turn-helper.sh

- [ ] **Add --algebraic flag support**

The turn helper needs these changes:
1. Parse `--algebraic {side}` from the args
2. In `state` mode: pipe combined JSON through `fightclaw-notation-cli.ts`
3. In `move` mode: parse notation to JSON via `fightclaw-notation-cli.ts --parse`, then submit

Modify `fightclaw-turn-helper.sh`:

At the top, after `LEGAL_MOVES_BIN=...`:

```bash
NOTATION_CLI="${NOTATION_CLI:-$SCRIPT_DIR/../dist/fightclaw-notation-cli.mjs}"
```

Add a new function `parse_algebraic_args` before the case statement:

```bash
# Parse --algebraic flag from remaining args
ALGEBRAIC_SIDE=""
parse_algebraic_args() {
  local -a remaining=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --algebraic)
        ALGEBRAIC_SIDE="$2"
        shift 2
        ;;
      *)
        remaining+=("$1")
        shift
        ;;
    esac
  done
  # Re-set positional params to remaining args
  set -- "${remaining[@]}"
}
```

Modify `fetch_state_and_moves` — after the final `node -e` output, add algebraic conversion:

```bash
  # If algebraic mode, convert JSON output to notation
  if [ -n "$ALGEBRAIC_SIDE" ]; then
    local json_output
    json_output=$( ... existing node -e command ... )
    echo "$json_output" | node "$NOTATION_CLI" --side "$ALGEBRAIC_SIDE" --version "$(echo "$json_output" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).stateVersion || 0)")"
  else
    ... existing output ...
  fi
```

Modify `submit_and_refetch` — when algebraic mode and move_json doesn't start with `{`, parse notation first:

```bash
  # If algebraic mode and input is notation (not JSON), parse it
  if [ -n "$ALGEBRAIC_SIDE" ] && [[ ! "$move_json" == \{* ]]; then
    move_json=$(echo "$move_json" | node "$NOTATION_CLI" --parse --side "$ALGEBRAIC_SIDE")
  fi
```

**Important:** The exact diff depends on the current state of the file. The implementing agent should read the full file, understand the flow, and integrate the algebraic mode cleanly. The key behavior is:

1. `bash $HELPER state URL ID KEY --algebraic B` → outputs notation text instead of JSON
2. `bash $HELPER move URL ID KEY VER "I1-D5" --algebraic B` → parses notation to JSON, submits, returns notation

- [ ] **Test manually with a mock state (if possible) or via unit test**

Create a quick smoke test by piping known JSON through the CLI:

```bash
echo '{"game":{"seed":1,"turn":1,"activePlayer":"A","actionsRemaining":7,"status":"active","players":{"A":{"id":"a","gold":15,"wood":5,"vp":0,"units":[]},"B":{"id":"b","gold":15,"wood":5,"vp":0,"units":[]}},"board":[]}}' | npx tsx apps/openclaw-runner/scripts/fightclaw-notation-cli.ts --side A --version 1
```

Expected: Notation text output (may error on empty board — adjust test data as needed).

- [ ] **Commit**

```bash
git add apps/openclaw-runner/scripts/fightclaw-turn-helper.sh apps/openclaw-runner/scripts/fightclaw-notation-cli.ts
git commit -m "feat: add --algebraic flag to turn helper"
```

---

## Task 6: Update Skill Docs for Algebraic Mode

Update the sub-agent instructions to use algebraic notation instead of JSON.

**Files:**
- Modify: `apps/openclaw-runner/skills/fightclaw-arena/references/subagent-match-loop.md`
- Modify: `skills/fightclaw-arena/SKILL.md` (top-level mirror)

### Step 6.1: Update subagent-match-loop.md

- [ ] **Replace JSON examples with algebraic notation**

Key changes to `subagent-match-loop.md`:

1. Change the helper invocations to include `--algebraic $SIDE`:
```bash
bash $HELPER state $BASE_URL $MATCH_ID $API_KEY --algebraic $SIDE
```

2. Replace the JSON output example with algebraic notation example:
```
T5 AP=A AR=7 V=12
A: 30g 5w 2vp | B: 25g 3w 1vp
       1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17
A:  .   .   .   .  ~F~  .   .  ^h^  .   .   .   .  ^h^  .   .  ~F~  .
B:  .  [SA] .   .   .  ^h^ ~F~  .  ^h^  .  ~F~ ^h^  .   .   .  [SB] .
C:  .   .   I1 ~F~  .   .   .  $W$  .  ~F~  .  ~F~  .  $W$  .   .   .
...
YOU: I1@C3(3/3)
OPP: i4@E12(2/2)
MOVES: I1-B3 I1-B4 I1-D3 I1-D4 +I@B2 +C@B2 +A@B2 I1f ET
```

3. Change move submission example:
```bash
bash $HELPER move $BASE_URL $MATCH_ID $API_KEY $STATE_VERSION "I1-D5" --algebraic $SIDE
```

4. Remove the "Reading the compact format" section (no longer relevant — the board IS the format).

5. Add a "Reading the Notation" section explaining:
   - Header: `T{turn} AP={side} AR={actions} V={version}`
   - Board: terrain markers and unit positions
   - `YOU:` = your units (uppercase), `OPP:` = enemy (lowercase)
   - `MOVES:` = all legal moves in algebraic notation
   - Move syntax: `I1-D5` (move), `A3xG6` (attack), `+I@B2` (recruit), `I1f` (fortify), `I1^` (upgrade), `ET` (end turn)

- [ ] **Commit**

```bash
git add apps/openclaw-runner/skills/fightclaw-arena/references/subagent-match-loop.md
git commit -m "docs: update subagent-match-loop for algebraic notation"
```

### Step 6.2: Update SKILL.md spawn task

- [ ] **Add --algebraic flag to spawn task**

In the SKILL.md's match lifecycle section or spawn task, ensure the sub-agent is told to use `--algebraic $SIDE` when invoking the turn helper. The specific edit depends on how the spawn task is structured in the latest version.

Key addition: Add an environment variable or instruction line:
```
SIDE — your player side ("A" or "B"), from the match_found event. Pass to --algebraic flag.
```

And update any example helper invocations to include `--algebraic $SIDE`.

- [ ] **Commit**

```bash
git add skills/fightclaw-arena/SKILL.md
git commit -m "docs: update SKILL.md spawn task for algebraic mode"
```

---

## Task 7: Build & Deploy

Build the notation module for production and deploy to EC2.

**Files:**
- May need to update build scripts if they exist for the openclaw-runner scripts

### Step 7.1: Build the notation CLI

- [ ] **Verify the notation module builds**

The legal-moves script is referenced as `dist/fightclaw-legal-moves.mjs`. Follow the same pattern for the notation CLI. Check if there's an esbuild or tsup config:

```bash
ls apps/openclaw-runner/esbuild* apps/openclaw-runner/tsup* apps/openclaw-runner/build* 2>/dev/null
grep -r "esbuild\|tsup\|build" apps/openclaw-runner/package.json
```

If a build step exists, add `fightclaw-notation-cli.ts` as an additional entrypoint. If scripts are run directly via `tsx` on EC2, no build step is needed.

- [ ] **Deploy updated scripts to EC2**

```bash
# SCP the new/modified files to EC2
scp apps/openclaw-runner/scripts/fightclaw-notation.ts EC2_HOST:~/projects/fightclaw/apps/openclaw-runner/scripts/
scp apps/openclaw-runner/scripts/fightclaw-notation-cli.ts EC2_HOST:~/projects/fightclaw/apps/openclaw-runner/scripts/
scp apps/openclaw-runner/scripts/fightclaw-turn-helper.sh EC2_HOST:~/projects/fightclaw/apps/openclaw-runner/scripts/
scp apps/openclaw-runner/skills/fightclaw-arena/references/subagent-match-loop.md EC2_HOST:~/openclaw/skills/fightclaw-arena/references/
scp skills/fightclaw-arena/SKILL.md EC2_HOST:~/openclaw/skills/fightclaw-arena/
```

Adjust paths based on the actual EC2 setup documented in memory (`reference_ec2_openclaw.md`).

- [ ] **Commit any build config changes**

```bash
git add -A && git commit -m "chore: update build config for notation CLI"
```

### Step 7.2: Smoke test

- [ ] **Run a test match with algebraic mode**

Trigger a match via the existing "go play fightclaw" flow and verify:
1. The sub-agent receives notation text (not JSON)
2. The sub-agent submits moves in algebraic notation
3. Moves are accepted by the server
4. Match completes without notation-related errors

---

## Summary

| Task | What | Commits |
|------|------|---------|
| 1 | `parseMove` (TDD) | 1 |
| 2 | `renderBoard` (TDD) | 1 |
| 3 | `stateToNotation` (TDD) | 1 |
| 4 | Round-trip integration test | 1 |
| 5 | Turn helper shell integration | 2 |
| 6 | Skill doc updates | 2 |
| 7 | Build & deploy | 1-2 |
| **Total** | | **9-10 commits** |
