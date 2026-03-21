import { describe, expect, test } from "bun:test";
import { makeAggressiveBot } from "../src/bots/aggressiveBot";
import { playMatch } from "../src/match";

describe("structural diagnostics", () => {
	test("midfield aggressive-vs-aggressive match records structural diagnostics", async () => {
		const result = await playMatch({
			seed: 42,
			players: [makeAggressiveBot("P1"), makeAggressiveBot("P2")],
			maxTurns: 600,
			record: true,
			scenario: "midfield",
			engineConfig: { turnLimit: 40, actionsPerTurn: 7 },
		});

		expect(result.structuralDiagnostics).toBeDefined();
		const diagnostics = result.structuralDiagnostics;
		expect(diagnostics?.terminalReason).toBe(result.reason);

		const assertNumberOrNull = (value: unknown): boolean =>
			value === null || Number.isInteger(value);
		expect(assertNumberOrNull(diagnostics?.firstContactTurn)).toBe(true);
		expect(assertNumberOrNull(diagnostics?.firstDamageTurn)).toBe(true);
		expect(assertNumberOrNull(diagnostics?.firstKillTurn)).toBe(true);
	});
});
