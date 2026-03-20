import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VITEST_BASE_ARGS = [
	"./node_modules/vitest/vitest.mjs",
	"-c",
	"vitest.durable.config.ts",
	"--run",
];

const DURABLE_FILE_ARG_PATTERN = /\.durable\.test\.[cm]?[jt]sx?$/;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DURABLE_DIR = path.resolve(__dirname, "../test/durable");

const stripPnpmSeparator = (rawArgs = []) =>
	rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs.slice();

const isDurableFileArg = (arg) => DURABLE_FILE_ARG_PATTERN.test(arg);
const discoverDurableFiles = () =>
	readdirSync(DURABLE_DIR)
		.filter((entry) => DURABLE_FILE_ARG_PATTERN.test(entry))
		.sort()
		.map((entry) => `test/durable/${entry}`);

export const buildVitestRuns = (rawArgs = []) => {
	const forwardedArgs = stripPnpmSeparator(rawArgs);
	const durableFiles = forwardedArgs.filter(isDurableFileArg);
	const sharedArgs = forwardedArgs.filter((arg) => !isDurableFileArg(arg));
	const filesToRun =
		durableFiles.length > 0 ? durableFiles : discoverDurableFiles();

	return filesToRun.map((file) => ({
		args: [...VITEST_BASE_ARGS, ...sharedArgs],
		env: { VITEST_INCLUDE: file },
	}));
};
