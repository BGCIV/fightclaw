import { describe, expect, it } from "vitest";
import { createIdentity } from "../src/appContext";

describe("createIdentity", () => {
	it("sets agentVerified true when verifiedAt is provided", () => {
		const id = createIdentity({
			agentId: "agent-1",
			verifiedAt: "2026-01-01T00:00:00Z",
		});
		expect(id.agentVerified).toBe(true);
		expect(id.verifiedAt).toBe("2026-01-01T00:00:00Z");
	});

	it("sets agentVerified false when verifiedAt is null", () => {
		const id = createIdentity({ agentId: "agent-2", verifiedAt: null });
		expect(id.agentVerified).toBe(false);
		expect(id.verifiedAt).toBeNull();
	});

	it("defaults verifiedAt to null and isAdmin to false", () => {
		const id = createIdentity({ agentId: "agent-3" });
		expect(id.verifiedAt).toBeNull();
		expect(id.agentVerified).toBe(false);
		expect(id.isAdmin).toBe(false);
	});

	it("passes through agentId and apiKeyId", () => {
		const id = createIdentity({
			agentId: "a",
			apiKeyId: "k",
			verifiedAt: null,
		});
		expect(id.agentId).toBe("a");
		expect(id.apiKeyId).toBe("k");
	});

	it("sets isAdmin when explicitly true", () => {
		const id = createIdentity({ agentId: "admin", isAdmin: true });
		expect(id.isAdmin).toBe(true);
	});
});

describe("claim validation", () => {
	const twitterHandlePattern = /^[A-Za-z0-9_]{1,15}$/;
	const tweetUrlPattern = /^https:\/\/(x\.com|twitter\.com)\//;

	function normalizeHandle(raw: string): string {
		return raw.startsWith("@") ? raw.slice(1) : raw;
	}

	describe("twitter handle normalization", () => {
		it("strips leading @ from handle", () => {
			expect(normalizeHandle("@fightclaw")).toBe("fightclaw");
		});

		it("leaves handle without @ unchanged", () => {
			expect(normalizeHandle("fightclaw")).toBe("fightclaw");
		});
	});

	describe("twitter handle pattern", () => {
		it.each([
			"a",
			"Agent_01",
			"A1b2C3d4E5f6G7h",
			"_underscores_",
		])("accepts valid handle: %s", (handle) => {
			expect(twitterHandlePattern.test(handle)).toBe(true);
		});

		it.each([
			"",
			"has spaces",
			"too-long-handle-name!",
			"a".repeat(16),
			"special!char",
		])("rejects invalid handle: %s", (handle) => {
			expect(twitterHandlePattern.test(handle)).toBe(false);
		});
	});

	describe("tweet URL pattern", () => {
		it.each([
			"https://x.com/user/status/123",
			"https://twitter.com/user/status/456",
		])("accepts valid tweet URL: %s", (url) => {
			expect(tweetUrlPattern.test(url)).toBe(true);
		});

		it.each([
			"http://x.com/user/status/123",
			"https://facebook.com/post/123",
			"https://nottwitter.com/status",
			"ftp://x.com/user",
		])("rejects invalid tweet URL: %s", (url) => {
			expect(tweetUrlPattern.test(url)).toBe(false);
		});
	});
});
