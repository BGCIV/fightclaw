import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings, AppVariables } from "../appTypes";
import { requireAdminKey, requireAgentAuth } from "../middleware/auth";
import { randomBase64Url, sha256Hex } from "../utils/crypto";
import {
	badRequest,
	conflict,
	internalServerError,
	notFound,
	serviceUnavailable,
	unauthorized,
} from "../utils/httpErrors";
import { created, success } from "../utils/httpSuccess";

const namePattern = /^[A-Za-z0-9_-]{1,64}$/;
const gameTypePattern = /^[a-z0-9_]{1,50}$/;

const registerSchema = z
	.object({
		name: z.string().min(1).max(64),
	})
	.strict();

const verifySchema = z
	.object({
		claimCode: z.string().min(1).max(200),
	})
	.strict();

export const authRoutes = new Hono<{
	Bindings: AppBindings;
	Variables: AppVariables;
}>();

authRoutes.post("/register", async (c) => {
	const json = await c.req.json().catch(() => null);
	const parsed = registerSchema.safeParse(json);
	if (!parsed.success) {
		return badRequest(c, "Invalid register payload.");
	}

	const trimmedName = parsed.data.name.trim();
	if (!namePattern.test(trimmedName)) {
		return badRequest(
			c,
			"Agent name must be 1-64 characters: letters, numbers, _ or - only.",
		);
	}

	const existing = await c.env.DB.prepare(
		"SELECT 1 as ok FROM agents WHERE name = ? LIMIT 1",
	)
		.bind(trimmedName)
		.first<{ ok: number }>();
	if (existing?.ok) {
		return conflict(c, "Agent name already in use.");
	}

	const pepper = c.env.API_KEY_PEPPER;
	if (!pepper) return internalServerError(c, "Auth not configured.");

	const agentId = crypto.randomUUID();
	const apiKeyId = crypto.randomUUID();
	const apiKey = `fc_sk_${randomBase64Url(32)}`;
	const apiKeyPrefix = apiKey.slice("fc_sk_".length, "fc_sk_".length + 8);
	const claimCode = `fc_claim_${randomBase64Url(9)}`;

	const apiKeyHash = await sha256Hex(`${pepper}${apiKey}`);
	const claimCodeHash = await sha256Hex(`${pepper}${claimCode}`);

	try {
		await c.env.DB.batch([
			c.env.DB.prepare(
				"INSERT INTO agents (id, name, api_key_hash, claim_code_hash, verified_at) VALUES (?, ?, ?, ?, NULL)",
			).bind(agentId, trimmedName, apiKeyHash, claimCodeHash),
			c.env.DB.prepare(
				"INSERT INTO api_keys (id, agent_id, key_hash, key_prefix) VALUES (?, ?, ?, ?)",
			).bind(apiKeyId, agentId, apiKeyHash, apiKeyPrefix),
		]);
	} catch (error) {
		console.error("Failed to register agent", error);
		return serviceUnavailable(c, "Registration unavailable.");
	}

	return created(c, {
		agent: { id: agentId, name: trimmedName, verified: false },
		apiKeyId,
		apiKey,
		apiKeyPrefix,
		claimCode,
	});
});

authRoutes.post("/verify", requireAdminKey, async (c) => {
	const json = await c.req.json().catch(() => null);
	const parsed = verifySchema.safeParse(json);
	if (!parsed.success) {
		return badRequest(c, "Invalid verify payload.");
	}

	const pepper = c.env.API_KEY_PEPPER;
	if (!pepper) return internalServerError(c, "Auth not configured.");

	const claimCode = parsed.data.claimCode.trim();
	const claimHash = await sha256Hex(`${pepper}${claimCode}`);

	const row = await c.env.DB.prepare(
		"SELECT id, verified_at FROM agents WHERE claim_code_hash = ? LIMIT 1",
	)
		.bind(claimHash)
		.first<{ id: string; verified_at: string | null }>();

	if (!row?.id) {
		return notFound(c, "Claim code not found.");
	}
	if (row.verified_at) {
		return conflict(c, "Agent already verified.");
	}

	await c.env.DB.prepare(
		"UPDATE agents SET verified_at = datetime('now') WHERE id = ? AND verified_at IS NULL",
	)
		.bind(row.id)
		.run();

	const verified = await c.env.DB.prepare(
		"SELECT verified_at FROM agents WHERE id = ? LIMIT 1",
	)
		.bind(row.id)
		.first<{ verified_at: string | null }>();

	return success(c, {
		agentId: row.id,
		verifiedAt: verified?.verified_at ?? null,
	});
});

authRoutes.get("/me", requireAgentAuth, async (c) => {
	const auth = c.get("auth");
	if (!auth) return unauthorized(c);

	const row = await c.env.DB.prepare(
		"SELECT id, name, created_at, verified_at FROM agents WHERE id = ? LIMIT 1",
	)
		.bind(auth.agentId)
		.first<{
			id: string;
			name: string;
			created_at: string;
			verified_at: string | null;
		}>();

	if (!row?.id) return unauthorized(c);

	return success(c, {
		agent: {
			id: row.id,
			name: row.name,
			verified: Boolean(row.verified_at),
			verifiedAt: row.verified_at ?? null,
			createdAt: row.created_at,
			apiKeyId: auth.apiKeyId ?? null,
		},
	});
});

// Exported for reuse in prompt routes validation.
export const validateGameType = (value: string) => gameTypePattern.test(value);
