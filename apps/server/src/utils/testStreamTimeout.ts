const DEFAULT_TEST_STREAM_MAX_LIFETIME_MS = 2000;

type TestStreamTimeoutEnv = {
	TEST_STREAM_MAX_LIFETIME_MS?: string;
};

export const getTestStreamMaxLifetimeMs = (env: TestStreamTimeoutEnv) => {
	const raw = env.TEST_STREAM_MAX_LIFETIME_MS;
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_TEST_STREAM_MAX_LIFETIME_MS;
	}
	return parsed;
};
