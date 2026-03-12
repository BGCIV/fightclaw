import { describe, expect, it } from "vitest";
import {
	getMatchmakerShardCount,
	getMatchmakerShardCountForRequest,
	listMatchmakerShardNames,
	resolveMatchmakerShardName,
} from "../src/utils/matchmakerShards";

describe("matchmaker shard helpers", () => {
	it("parses shard count from env with safe defaults", () => {
		expect(getMatchmakerShardCount({})).toBe(1);
		expect(getMatchmakerShardCount({ MATCHMAKER_SHARDS: "1" })).toBe(1);
		expect(getMatchmakerShardCount({ MATCHMAKER_SHARDS: "8" })).toBe(8);
		expect(getMatchmakerShardCount({ MATCHMAKER_SHARDS: "0" })).toBe(1);
		expect(getMatchmakerShardCount({ MATCHMAKER_SHARDS: "-2" })).toBe(1);
		expect(getMatchmakerShardCount({ MATCHMAKER_SHARDS: "invalid" })).toBe(1);
		expect(getMatchmakerShardCount({ MATCHMAKER_SHARDS: "999" })).toBe(128);
	});

	it("allows test override only when TEST_MODE is enabled", () => {
		expect(
			getMatchmakerShardCountForRequest(
				{ MATCHMAKER_SHARDS: "1", TEST_MODE: "1" },
				"4",
			),
		).toBe(4);
		expect(
			getMatchmakerShardCountForRequest(
				{ MATCHMAKER_SHARDS: "1", TEST_MODE: undefined },
				"4",
			),
		).toBe(1);
	});

	it("lists shard names", () => {
		expect(listMatchmakerShardNames(1)).toEqual(["global"]);
		expect(listMatchmakerShardNames(3)).toEqual([
			"shard-0",
			"shard-1",
			"shard-2",
		]);
	});

	it("routes same agent id to same shard deterministically", () => {
		const agentId = "agent-123";
		const shardA = resolveMatchmakerShardName(agentId, 16);
		const shardB = resolveMatchmakerShardName(agentId, 16);
		expect(shardA).toBe(shardB);
	});

	it("uses global when only one shard is configured", () => {
		expect(resolveMatchmakerShardName("agent-123", 1)).toBe("global");
	});
});
