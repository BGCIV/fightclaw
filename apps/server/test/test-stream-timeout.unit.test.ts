import { describe, expect, it } from "vitest";
import { getTestStreamMaxLifetimeMs } from "../src/utils/testStreamTimeout";

describe("getTestStreamMaxLifetimeMs", () => {
	it("uses a short default for test streams", () => {
		expect(getTestStreamMaxLifetimeMs({})).toBe(2000);
	});

	it("accepts a positive override", () => {
		expect(
			getTestStreamMaxLifetimeMs({
				TEST_STREAM_MAX_LIFETIME_MS: "750",
			}),
		).toBe(750);
	});

	it("falls back to the default for invalid values", () => {
		expect(
			getTestStreamMaxLifetimeMs({
				TEST_STREAM_MAX_LIFETIME_MS: "0",
			}),
		).toBe(2000);
		expect(
			getTestStreamMaxLifetimeMs({
				TEST_STREAM_MAX_LIFETIME_MS: "invalid",
			}),
		).toBe(2000);
	});
});
