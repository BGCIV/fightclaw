import { describe, expect, test } from "bun:test";

import { shouldProbeServerVersion } from "../src/lib/version-check";

describe("shouldProbeServerVersion", () => {
	test("skips only local-to-local cross-origin version probes in dev", () => {
		expect(
			shouldProbeServerVersion(
				"http://127.0.0.1:3000",
				"http://127.0.0.1:3101",
				true,
			),
		).toBe(false);
	});

	test("allows same-origin version probes in dev", () => {
		expect(
			shouldProbeServerVersion(
				"http://127.0.0.1:3101",
				"http://127.0.0.1:3101",
				true,
			),
		).toBe(true);
	});

	test("keeps remote cross-origin probes enabled in dev", () => {
		expect(
			shouldProbeServerVersion(
				"https://api.fightclaw.com",
				"http://127.0.0.1:3101",
				true,
			),
		).toBe(true);
	});

	test("keeps version probes enabled outside dev", () => {
		expect(
			shouldProbeServerVersion(
				"https://api.fightclaw.com",
				"https://fightclaw.com",
				false,
			),
		).toBe(true);
	});
});
