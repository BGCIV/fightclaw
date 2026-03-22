/**
 * Legal-move helper for OpenClaw sub-agents.
 *
 * Reads a Fightclaw game state JSON from stdin, outputs legal moves as JSON
 * to stdout. Designed to be called via `exec` from an OpenClaw sub-agent
 * during a match loop.
 *
 * Input (stdin):  GameState JSON (the `game` object from the match state envelope)
 * Output (stdout): JSON object with `legalMoves` array and `summary` metadata
 *
 * Exit codes:
 *   0 — success
 *   1 — invalid input or no state provided
 */

import { listLegalMoves, type MatchState } from "@fightclaw/engine";

const readStdin = async (): Promise<string> => {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	return Buffer.concat(chunks).toString("utf8").trim();
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Accept multiple input shapes:
 * 1. Raw GameState (has board + players)
 * 2. { state: { game: GameState } }  (match state envelope)
 * 3. { state: GameState }            (partial envelope)
 * 4. { game: GameState }             (nested game)
 */
const extractGameState = (input: unknown): MatchState | null => {
	if (!isRecord(input)) return null;

	// Direct GameState
	if (Array.isArray(input.board) && isRecord(input.players)) {
		return input as unknown as MatchState;
	}

	// { game: GameState }
	if (
		isRecord(input.game) &&
		Array.isArray((input.game as Record<string, unknown>).board)
	) {
		return input.game as unknown as MatchState;
	}

	// { state: { game: GameState } } or { state: GameState }
	if (isRecord(input.state)) {
		const state = input.state as Record<string, unknown>;
		if (Array.isArray(state.board) && isRecord(state.players)) {
			return state as unknown as MatchState;
		}
		if (
			isRecord(state.game) &&
			Array.isArray((state.game as Record<string, unknown>).board)
		) {
			return state.game as unknown as MatchState;
		}
	}

	return null;
};

const main = async () => {
	const raw = await readStdin();
	if (!raw) {
		process.stdout.write(
			JSON.stringify({ error: "No input provided on stdin" }),
		);
		process.exit(1);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		process.stdout.write(JSON.stringify({ error: "Invalid JSON on stdin" }));
		process.exit(1);
	}

	const gameState = extractGameState(parsed);
	if (!gameState) {
		process.stdout.write(
			JSON.stringify({ error: "Could not extract game state from input" }),
		);
		process.exit(1);
	}

	const legalMoves = listLegalMoves(gameState);

	// Compact mode: group moves by unit to reduce output size (~80% smaller)
	// Instead of 139 individual move objects, produce grouped summaries.
	const compact = process.argv.includes("--compact");

	if (compact) {
		const grouped: Record<
			string,
			{
				moveTo?: string[];
				attackTargets?: string[];
				canFortify?: boolean;
				canUpgrade?: boolean;
			}
		> = {};
		const recruitOptions: Array<{ unitType: string; at: string }> = [];
		let hasEndTurn = false;
		let hasPass = false;

		const ensureGroup = (id: string) => {
			if (!grouped[id]) grouped[id] = {};
			return grouped[id];
		};

		for (const m of legalMoves) {
			switch (m.action) {
				case "move": {
					const g = ensureGroup(m.unitId);
					if (!g.moveTo) g.moveTo = [];
					g.moveTo.push(m.to);
					break;
				}
				case "attack": {
					const g = ensureGroup(m.unitId);
					if (!g.attackTargets) g.attackTargets = [];
					g.attackTargets.push(m.target);
					break;
				}
				case "fortify": {
					ensureGroup(m.unitId).canFortify = true;
					break;
				}
				case "upgrade": {
					ensureGroup(m.unitId).canUpgrade = true;
					break;
				}
				case "recruit":
					recruitOptions.push({ unitType: m.unitType, at: m.at });
					break;
				case "end_turn":
					hasEndTurn = true;
					break;
				case "pass":
					hasPass = true;
					break;
			}
		}

		const units = Object.entries(grouped).map(([unitId, opts]) => ({
			unitId,
			...opts,
		}));

		process.stdout.write(
			JSON.stringify({
				turn: gameState.turn,
				activePlayer: gameState.activePlayer,
				actionsRemaining: gameState.actionsRemaining,
				status: gameState.status,
				legalMoveCount: legalMoves.length,
				units,
				recruit: recruitOptions.length > 0 ? recruitOptions : undefined,
				endTurn: hasEndTurn || undefined,
				pass: hasPass || undefined,
			}),
		);
	} else {
		process.stdout.write(
			JSON.stringify({
				turn: gameState.turn,
				activePlayer: gameState.activePlayer,
				actionsRemaining: gameState.actionsRemaining,
				status: gameState.status,
				legalMoveCount: legalMoves.length,
				legalMoves,
			}),
		);
	}
};

void main();
