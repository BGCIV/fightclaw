import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeader, createAgent, resetDb } from "../helpers";

describe("auth onboarding", () => {
	beforeEach(async () => {
		await resetDb();
	});

	describe("register", () => {
		it("returns apiKey and claimCode on register", async () => {
			const res = await SELF.fetch("https://example.com/v1/auth/register", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "TestAgent" }),
			});
			expect(res.status).toBe(201);
			const data = (await res.json()) as {
				ok: boolean;
				agent?: { id: string };
				apiKey?: string;
				claimCode?: string;
			};
			expect(data.ok).toBe(true);
			expect(data.apiKey).toBeDefined();
			expect(data.claimCode).toBeDefined();
			expect(data.agent?.id).toBeDefined();
		});

		it("requires name on register", async () => {
			const res = await SELF.fetch("https://example.com/v1/auth/register", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
		});
	});

	describe("verification gating", () => {
		it("unverified agent gets 403 on queue", async () => {
			const agent = await createAgent(
				"unverified",
				"unverified-key",
				undefined,
				{
					verified: false,
				},
			);
			const res = await SELF.fetch("https://example.com/v1/matches/queue", {
				method: "POST",
				headers: authHeader(agent.key),
			});
			expect(res.status).toBe(403);
		});

		it("verified agent can access queue", async () => {
			const agent = await createAgent("verified", "verified-key", undefined, {
				verified: true,
			});
			const res = await SELF.fetch("https://example.com/v1/matches/queue", {
				method: "POST",
				headers: authHeader(agent.key),
			});
			// Should not be 403 (may be 200 with waiting status)
			expect(res.status).not.toBe(403);
		});
	});

	describe("/v1/auth/me", () => {
		it("returns verified status for verified agent", async () => {
			const agent = await createAgent(
				"verified",
				"verified-key-me",
				undefined,
				{
					verified: true,
				},
			);
			const res = await SELF.fetch("https://example.com/v1/auth/me", {
				headers: authHeader(agent.key),
			});
			expect(res.status).toBe(200);
			const data = (await res.json()) as {
				ok: boolean;
				agent?: { verified: boolean };
			};
			expect(data.agent?.verified).toBe(true);
		});

		it("returns unverified status for unverified agent", async () => {
			const agent = await createAgent(
				"unverified",
				"unverified-key-me",
				undefined,
				{
					verified: false,
				},
			);
			const res = await SELF.fetch("https://example.com/v1/auth/me", {
				headers: authHeader(agent.key),
			});
			expect(res.status).toBe(200);
			const data = (await res.json()) as {
				ok: boolean;
				agent?: { verified: boolean };
			};
			expect(data.agent?.verified).toBe(false);
		});
	});

	describe("verify", () => {
		it("verifies agent with valid claim code", async () => {
			// Register a new agent to get a claim code
			const regRes = await SELF.fetch("https://example.com/v1/auth/register", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "VerifyMe" }),
			});
			const regData = (await regRes.json()) as {
				agent?: { id: string };
				claimCode?: string;
			};
			expect(regData.claimCode).toBeDefined();

			// Verify using admin key + claim code
			const verifyRes = await SELF.fetch("https://example.com/v1/auth/verify", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-admin-key": env.ADMIN_KEY,
				},
				body: JSON.stringify({ claimCode: regData.claimCode }),
			});
			expect(verifyRes.status).toBe(200);
			const verifyData = (await verifyRes.json()) as {
				ok: boolean;
				agentId?: string;
				verifiedAt?: string | null;
			};
			expect(verifyData.ok).toBe(true);
			expect(verifyData.agentId).toBe(regData.agent?.id);
			expect(verifyData.verifiedAt).not.toBeNull();
		});

		it("rejects invalid claim code", async () => {
			const res = await SELF.fetch("https://example.com/v1/auth/verify", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-admin-key": env.ADMIN_KEY,
				},
				body: JSON.stringify({ claimCode: "fc_claim_bogus" }),
			});
			expect(res.status).toBe(404);
		});

		it("rejects verify without admin key", async () => {
			const res = await SELF.fetch("https://example.com/v1/auth/verify", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ claimCode: "fc_claim_bogus" }),
			});
			expect(res.status).toBe(403);
		});
	});

	describe("api_keys table auth", () => {
		it("auth succeeds via api_keys table", async () => {
			const agent = await createAgent("apikey-agent", "apikey-agent-key");
			const res = await SELF.fetch("https://example.com/v1/auth/me", {
				headers: authHeader(agent.key),
			});
			expect(res.status).toBe(200);
		});

		it("revoked key returns 401", async () => {
			const agent = await createAgent("revoked-agent", "revoked-agent-key");
			// Revoke the key
			await env.DB.prepare(
				"UPDATE api_keys SET revoked_at = datetime('now') WHERE agent_id = ?",
			)
				.bind(agent.id)
				.run();

			const res = await SELF.fetch("https://example.com/v1/auth/me", {
				headers: authHeader(agent.key),
			});
			expect(res.status).toBe(401);
		});
	});
});
