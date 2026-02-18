import type { Move } from "../types";

/**
 * Discriminated union of parsed CLI-style commands from LLM output.
 * These use a flat "target" field; matchCommand maps them to the
 * engine's Move shape (which uses "to", "target", or "at" depending
 * on the action).
 */
export type ParsedCommand =
	| { action: "move"; unitId: string; target: string }
	| { action: "attack"; unitId: string; target: string }
	| { action: "recruit"; unitType: string; target: string }
	| { action: "fortify"; unitId: string }
	| { action: "upgrade"; unitId: string }
	| { action: "end_turn" };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse CLI-style command text and return the commands found in the command section.
 *
 * The parser removes surrounding Markdown code fences, stops at the first line containing `---` (the remainder is treated as optional reasoning and ignored), skips blank lines and lines starting with `#`, treats action names case-insensitively, and accepts `pass`/`end` as `end_turn`.
 *
 * @returns An array of ParsedCommand objects parsed from the command portion of `text`
 */
export function parseCommands(text: string): ParsedCommand[] {
	const cleaned = stripCodeFences(text);
	const commandSection = splitAtSeparator(cleaned).commands;
	return parseLines(commandSection);
}

/**
 * Parse a block of CLI-style commands and also extract optional reasoning found after the first `---` separator.
 *
 * @param text - Raw input text that may include code fences, commands, and an optional reasoning section.
 * @returns An object containing `commands`, the parsed array of commands, and `reasoning`, the trimmed text after the `---` separator or `undefined` if no reasoning section exists.
 */
export function parseCommandsWithReasoning(text: string): {
	commands: ParsedCommand[];
	reasoning: string | undefined;
} {
	const cleaned = stripCodeFences(text);
	const { commands: commandSection, reasoning } = splitAtSeparator(cleaned);
	return {
		commands: parseLines(commandSection),
		reasoning,
	};
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Find the first legal Move that corresponds to a parsed CLI command.
 *
 * Attempts to match the parsed command to a Move in `legalMoves` by comparing
 * the action and the fields relevant to that action (see field mapping).
 *
 * Field mapping:
 *   - `move`:  `ParsedCommand.target` -> `Move.to`  (also matches `unitId`)
 *   - `attack`: `ParsedCommand.target` -> `Move.target`  (also matches `unitId`)
 *   - `recruit`: `ParsedCommand.target` -> `Move.at`  (also matches `unitType`)
 *   - `fortify` / `upgrade`: `ParsedCommand.unitId` -> `Move.unitId`
 *   - `end_turn`: matches any `end_turn` Move
 *
 * @param cmd - The parsed command to match
 * @param legalMoves - List of permitted Move objects to search
 * @returns The matching `Move` if found, `null` otherwise
 */
export function matchCommand(
	cmd: ParsedCommand,
	legalMoves: Move[],
): Move | null {
	for (const move of legalMoves) {
		if (move.action !== cmd.action) continue;

		switch (cmd.action) {
			case "move": {
				const m = move as Extract<Move, { action: "move" }>;
				if (m.unitId === cmd.unitId && m.to === cmd.target) return move;
				break;
			}
			case "attack": {
				const m = move as Extract<Move, { action: "attack" }>;
				if (m.unitId === cmd.unitId && m.target === cmd.target) return move;
				break;
			}
			case "recruit": {
				const m = move as Extract<Move, { action: "recruit" }>;
				if (m.unitType === cmd.unitType && m.at === cmd.target) return move;
				break;
			}
			case "fortify": {
				const m = move as Extract<Move, { action: "fortify" }>;
				if (m.unitId === cmd.unitId) return move;
				break;
			}
			case "upgrade": {
				const m = move as Extract<Move, { action: "upgrade" }>;
				if (m.unitId === cmd.unitId) return move;
				break;
			}
			case "end_turn": {
				return move;
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Removes Markdown fenced code block delimiters (``` and ```lang) from the text and trims whitespace.
 *
 * @returns The input string with code-fence lines removed and surrounding whitespace trimmed.
 */
function stripCodeFences(text: string): string {
	return text.replace(/^```[a-z]*\s*$/gm, "").trim();
}

/**
 * Split input text at the first line that contains only `---` and return the text before it as commands and the trimmed text after it as optional reasoning.
 *
 * @returns An object with `commands` set to the portion before the separator, and `reasoning` set to the trimmed portion after the separator or `undefined` if no non-empty reasoning exists.
 */
function splitAtSeparator(text: string): {
	commands: string;
	reasoning: string | undefined;
} {
	const idx = text.indexOf("\n---");
	if (idx === -1) {
		return { commands: text, reasoning: undefined };
	}
	const commands = text.slice(0, idx);
	// Reasoning starts after "---\n"
	const afterSep = text.slice(idx + 1); // includes "---\n..."
	const reasoningStart = afterSep.indexOf("\n");
	if (reasoningStart === -1) {
		return { commands, reasoning: undefined };
	}
	const reasoning = afterSep.slice(reasoningStart + 1).trim();
	return {
		commands,
		reasoning: reasoning.length > 0 ? reasoning : undefined,
	};
}

/** Parse individual lines into ParsedCommands, skipping blanks/comments. */
function parseLines(text: string): ParsedCommand[] {
	const results: ParsedCommand[] = [];
	const lines = text.split("\n");

	for (const raw of lines) {
		const line = normalizeCommandLine(raw);
		// Skip blank lines and comments
		if (line === "" || line.startsWith("#")) continue;

		const parts = line.split(/\s+/);
		const action = (parts[0] ?? "").toLowerCase();

		switch (action) {
			case "move": {
				const unitId = cleanToken(parts[1]);
				const target = cleanToken(parts[2]);
				if (unitId && target) {
					results.push({ action: "move", unitId, target });
				}
				break;
			}
			case "attack": {
				const unitId = cleanToken(parts[1]);
				const target = cleanToken(parts[2]);
				if (unitId && target) {
					results.push({ action: "attack", unitId, target });
				}
				break;
			}
			case "recruit": {
				const unitType = cleanToken(parts[1]);
				const target = cleanToken(parts[2]);
				if (unitType && target) {
					results.push({ action: "recruit", unitType, target });
				}
				break;
			}
			case "fortify": {
				const unitId = cleanToken(parts[1]);
				if (unitId) {
					results.push({ action: "fortify", unitId });
				}
				break;
			}
			case "upgrade": {
				const unitId = cleanToken(parts[1]);
				if (unitId) {
					results.push({ action: "upgrade", unitId });
				}
				break;
			}
			case "end": {
				const maybeTurn = (parts[1] ?? "").toLowerCase();
				if (maybeTurn === "turn") {
					results.push({ action: "end_turn" });
				}
				break;
			}
			case "end_turn":
			case "pass": {
				results.push({ action: "end_turn" });
				break;
			}
			// Unknown actions are silently skipped
		}
	}

	return results;
}

/**
 * Normalize a single command-line string by removing common list/numbering prefixes and surrounding backticks.
 *
 * @param raw - The raw input line to normalize
 * @returns The cleaned command line with leading numbering (e.g., "1.", "2)"), bullet markers ("-", "*"), and surrounding backticks removed
 */
function normalizeCommandLine(raw: string): string {
	return raw
		.trim()
		.replace(/^\d+[).:-]?\s+/, "")
		.replace(/^[-*]\s+/, "")
		.replace(/^`+|`+$/g, "");
}

/**
 * Sanitize a token by removing all characters except letters, digits, underscores, and dashes.
 *
 * @param token - The input string to clean; may be undefined
 * @returns The cleaned token containing only `A-Z`, `a-z`, `0-9`, `_`, and `-`, or `undefined` if the input is falsy or the result is empty
 */
function cleanToken(token: string | undefined): string | undefined {
	if (!token) return undefined;
	const cleaned = token.replace(/[^A-Za-z0-9_-]/g, "");
	return cleaned.length > 0 ? cleaned : undefined;
}