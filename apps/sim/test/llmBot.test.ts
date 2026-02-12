import { describe, expect, test } from "bun:test";
import { parseLlmJsonish } from "../src/bots/llmBot";

describe("llmBot", () => {
	test("parses JSON-only response", () => {
		const res = parseLlmJsonish('{"moveIndex": 12, "reasoning": "foo"}');
		expect(res.moveIndex).toBe(12);
		expect(res.reasoning).toBe("foo");
	});

	test("parses moveIndex from mixed text", () => {
		const res = parseLlmJsonish(
			'Here you go: { "moveIndex": 3, "reasoning": "bar" } thanks',
		);
		expect(res.moveIndex).toBe(3);
	});

	test("parses moveIndex from moveIndex token even without JSON", () => {
		const res = parseLlmJsonish("moveIndex=7\nreasoning: because");
		expect(res.moveIndex).toBe(7);
	});
});
