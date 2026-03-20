import { describe, expect, test } from "bun:test";
import { getUsageText } from "../src/cliUsage";

describe("sim cli usage", () => {
	test("only documents boardgameio as the supported harness", () => {
		const usage = getUsageText();

		expect(usage).toContain("boardgameio");
		expect(usage).not.toContain("legacy");
	});
});
