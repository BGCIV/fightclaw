const DEFAULT_MATCHMAKER_SHARDS = 1;
const MAX_MATCHMAKER_SHARDS = 128;

const fnv1a32 = (value: string) => {
	let hash = 0x811c9dc5;
	for (let idx = 0; idx < value.length; idx += 1) {
		hash ^= value.charCodeAt(idx);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
};

const parseMatchmakerShardCount = (raw?: string) => {
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed <= 0) {
		return DEFAULT_MATCHMAKER_SHARDS;
	}
	return Math.min(parsed, MAX_MATCHMAKER_SHARDS);
};

export const getMatchmakerShardCount = (env: {
	MATCHMAKER_SHARDS?: string;
}) => {
	return parseMatchmakerShardCount(env.MATCHMAKER_SHARDS);
};

export const getMatchmakerShardCountForRequest = (
	env: {
		MATCHMAKER_SHARDS?: string;
		TEST_MODE?: string;
	},
	testHeaderOverride?: string,
) => {
	if (env.TEST_MODE && testHeaderOverride) {
		return parseMatchmakerShardCount(testHeaderOverride);
	}
	return parseMatchmakerShardCount(env.MATCHMAKER_SHARDS);
};

export const listMatchmakerShardNames = (shardCount: number) => {
	if (!Number.isFinite(shardCount) || shardCount <= 1) return ["global"];
	return Array.from({ length: shardCount }, (_, idx) => `shard-${idx}`);
};

export const resolveMatchmakerShardName = (
	agentId: string,
	shardCount: number,
) => {
	if (!Number.isFinite(shardCount) || shardCount <= 1) {
		return "global";
	}
	const index = fnv1a32(agentId) % shardCount;
	return `shard-${index}`;
};
