import { describe, expect, test } from "bun:test";
import { parseLlmResponse } from "../src/bots/llmBot";

describe("llmBot", () => {
	test("parseLlmResponse extracts commands and reasoning", () => {
		const text =
			"move A-1 E10\nattack A-4 F11\nend_turn\n---\nPushing forward.";
		const result = parseLlmResponse(text);
		expect(result.commands).toHaveLength(3);
		expect(result.commands[0]?.action).toBe("move");
		expect(result.reasoning).toBe("Pushing forward.");
	});

	test("parseLlmResponse handles commands only (no reasoning)", () => {
		const text = "recruit infantry B2\nend_turn";
		const result = parseLlmResponse(text);
		expect(result.commands).toHaveLength(2);
		expect(result.reasoning).toBeUndefined();
	});

	test("parseLlmResponse handles markdown code blocks", () => {
		const text = "```\nmove A-1 E10\nend_turn\n```\n---\nReason.";
		const result = parseLlmResponse(text);
		expect(result.commands).toHaveLength(2);
	});

	test("parseLlmResponse handles empty response", () => {
		const result = parseLlmResponse("");
		expect(result.commands).toHaveLength(0);
	});

	test("parseLlmResponse handles pass as end_turn", () => {
		const result = parseLlmResponse("pass");
		expect(result.commands).toHaveLength(1);
		expect(result.commands[0]?.action).toBe("end_turn");
	});
});
