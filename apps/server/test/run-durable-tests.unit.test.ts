import { describe, expect, it } from "vitest";
import { buildVitestRuns } from "../scripts/run-durable-tests-lib.mjs";

describe("buildVitestRuns", () => {
	it("runs a single durable file through VITEST_INCLUDE", () => {
		expect(buildVitestRuns(["--", "test/durable/log.durable.test.ts"])).toEqual(
			[
				{
					args: [
						"./node_modules/vitest/vitest.mjs",
						"-c",
						"vitest.durable.config.ts",
						"--run",
					],
					env: {
						VITEST_INCLUDE: "test/durable/log.durable.test.ts",
					},
				},
			],
		);
	});

	it("splits multiple durable files into isolated runs and preserves flags", () => {
		expect(
			buildVitestRuns([
				"--",
				"--silent",
				"test/durable/log.durable.test.ts",
				"test/durable/timeout.durable.test.ts",
			]),
		).toEqual([
			{
				args: [
					"./node_modules/vitest/vitest.mjs",
					"-c",
					"vitest.durable.config.ts",
					"--run",
					"--silent",
				],
				env: {
					VITEST_INCLUDE: "test/durable/log.durable.test.ts",
				},
			},
			{
				args: [
					"./node_modules/vitest/vitest.mjs",
					"-c",
					"vitest.durable.config.ts",
					"--run",
					"--silent",
				],
				env: {
					VITEST_INCLUDE: "test/durable/timeout.durable.test.ts",
				},
			},
		]);
	});
});
