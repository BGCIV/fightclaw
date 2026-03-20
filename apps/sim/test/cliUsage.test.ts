import { describe, expect, test } from "bun:test";
import { getUsageText } from "../src/cliUsage";

describe("sim cli usage", () => {
	test("does not document the removed harness flag", () => {
		const usage = getUsageText();

		expect(usage).not.toContain("--harness");
		expect(usage).not.toContain("legacy");
	});
});
