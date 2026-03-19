const VITEST_BASE_ARGS = [
	"./node_modules/vitest/vitest.mjs",
	"-c",
	"vitest.durable.config.ts",
	"--run",
];

const DURABLE_FILE_ARG_PATTERN = /\.durable\.test\.[cm]?[jt]sx?$/;

const stripPnpmSeparator = (rawArgs = []) =>
	rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs.slice();

const isDurableFileArg = (arg) => DURABLE_FILE_ARG_PATTERN.test(arg);

export const buildVitestRuns = (rawArgs = []) => {
	const forwardedArgs = stripPnpmSeparator(rawArgs);
	const durableFiles = forwardedArgs.filter(isDurableFileArg);
	const sharedArgs = forwardedArgs.filter((arg) => !isDurableFileArg(arg));

	if (durableFiles.length === 0) {
		return [
			{
				args: [...VITEST_BASE_ARGS, ...sharedArgs],
				env: {},
			},
		];
	}

	return durableFiles.map((file) => ({
		args: [...VITEST_BASE_ARGS, ...sharedArgs],
		env: { VITEST_INCLUDE: file },
	}));
};
