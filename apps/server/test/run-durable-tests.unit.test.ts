import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildVitestRuns } from "../scripts/run-durable-tests-lib.mjs";

const DURABLE_DIR = path.resolve(import.meta.dirname, "durable");
const DURABLE_FILE_PATTERN = /\.durable\.test\.[cm]?[jt]sx?$/;
const EXPECTED_DURABLE_FILES = readdirSync(DURABLE_DIR)
	.filter((entry) => DURABLE_FILE_PATTERN.test(entry))
	.sort()
	.map((entry) => `test/durable/${entry}`);

describe("buildVitestRuns", () => {
	it("discovers durable files by default and isolates each file run", () => {
		expect(buildVitestRuns([])).toEqual(
			EXPECTED_DURABLE_FILES.map((file) => ({
				command: process.execPath,
				args: [
					"./node_modules/vitest/vitest.mjs",
					"-c",
					"vitest.durable.config.ts",
					"--run",
				],
				env: {
					VITEST_INCLUDE: file,
				},
			})),
		);
	});

	it("runs a single durable file through VITEST_INCLUDE", () => {
		expect(buildVitestRuns(["--", "test/durable/log.durable.test.ts"])).toEqual(
			[
				{
					command: process.execPath,
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
				command: process.execPath,
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
				command: process.execPath,
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
