import {
	CONTRACTS_VERSION,
	ENGINE_VERSION,
	PROTOCOL_VERSION,
	type SystemVersionResponse,
} from "@fightclaw/protocol";
import { Hono } from "hono";
import { z } from "zod";

import type { AppBindings, AppVariables } from "../appTypes";
import {
	readPublicAgentIdentities,
	readPublicAgentIdentity,
} from "../publicAgentIdentity";
import { badRequest, internalServerError, notFound } from "../utils/httpErrors";
import { parseUuidParam } from "../utils/params";

export const systemRoutes = new Hono<{
	Bindings: AppBindings;
	Variables: AppVariables;
}>();

const publicAgentBatchSchema = z
	.object({
		agentIds: z.array(z.string().uuid()).max(100),
	})
	.strict();

systemRoutes.get("/", (c) => {
	return c.text("OK");
});

systemRoutes.get("/health", (c) => {
	return c.text("OK");
});

systemRoutes.get("/v1/leaderboard", async (c) => {
	const limitRaw = c.req.query("limit");
	const parsed = limitRaw ? Number.parseInt(limitRaw, 10) : 100;
	const limit =
		Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 100;
	try {
		const { results } = await c.env.DB.prepare(
			"SELECT agent_id, rating, wins, losses, games_played, updated_at FROM leaderboard ORDER BY rating DESC LIMIT ?",
		)
			.bind(limit)
			.all();
		const leaderboard = (results ?? []) as Array<{
			agent_id: string;
			rating: number;
			wins: number;
			losses: number;
			games_played: number;
			updated_at: string;
		}>;
		const publicIdentityById = new Map(
			(
				await readPublicAgentIdentities(
					c.env.DB,
					leaderboard.map((entry) => entry.agent_id),
				)
			).map((identity) => [identity.agentId, identity] as const),
		);
		return c.json({
			leaderboard: leaderboard.map((entry) => {
				const identity = publicIdentityById.get(entry.agent_id);
				return {
					...entry,
					agentName: identity?.agentName ?? null,
					publicPersona: identity?.publicPersona ?? null,
					styleTag: identity?.styleTag ?? null,
				};
			}),
		});
	} catch (error) {
		console.error("Failed to load leaderboard", error);
		return internalServerError(c, "Leaderboard unavailable");
	}
});

systemRoutes.get("/v1/agents/:id/public", async (c) => {
	const agentResult = parseUuidParam(c, "id", "Agent id");
	if (!agentResult.ok) return agentResult.response;

	try {
		const agent = await readPublicAgentIdentity(c.env.DB, agentResult.value);
		if (!agent) {
			return notFound(c, "Agent not found.");
		}
		return c.json({ agent });
	} catch (error) {
		console.error("Failed to load public agent identity", error);
		return internalServerError(c, "Public agent identity unavailable");
	}
});

systemRoutes.post("/v1/agents/public/batch", async (c) => {
	const json = await c.req.json().catch(() => null);
	const parsed = publicAgentBatchSchema.safeParse(json);
	if (!parsed.success) {
		return badRequest(c, "Invalid public agent batch payload.");
	}

	try {
		const agents = await readPublicAgentIdentities(
			c.env.DB,
			parsed.data.agentIds,
		);
		return c.json({ agents });
	} catch (error) {
		console.error("Failed to load public agent identities", error);
		return internalServerError(c, "Public agent identities unavailable");
	}
});

systemRoutes.get("/v1/system/version", (c) => {
	const metadata = c.env.CF_VERSION_METADATA;
	const record =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? (metadata as Record<string, unknown>)
			: null;
	const body: SystemVersionResponse = {
		gitSha:
			typeof record?.gitSha === "string"
				? record.gitSha
				: typeof record?.id === "string"
					? record.id
					: typeof record?.commitHash === "string"
						? record.commitHash
						: null,
		buildTime:
			typeof record?.buildTime === "string"
				? record.buildTime
				: typeof record?.timestamp === "string"
					? record.timestamp
					: null,
		contractsVersion: CONTRACTS_VERSION,
		protocolVersion: PROTOCOL_VERSION,
		engineVersion: ENGINE_VERSION,
		environment: c.env.SENTRY_ENVIRONMENT ?? null,
	};
	return c.json(body);
});

systemRoutes.get("/v1/agents/:id", async (c) => {
	const agentId = c.req.param("id");

	try {
		const agent = await c.env.DB.prepare(
			[
				"SELECT a.id, a.name, a.created_at, a.verified_at,",
				"l.rating, l.wins, l.losses, l.games_played, l.updated_at",
				"FROM agents a",
				"LEFT JOIN leaderboard l ON l.agent_id = a.id",
				"WHERE a.id = ?",
				"LIMIT 1",
			].join(" "),
		)
			.bind(agentId)
			.first<{
				id: string;
				name: string;
				created_at: string;
				verified_at: string | null;
				rating: number | null;
				wins: number | null;
				losses: number | null;
				games_played: number | null;
				updated_at: string | null;
			}>();
		if (!agent) return c.json({ ok: false, error: "Agent not found." }, 404);

		const { results: recent } = await c.env.DB.prepare(
			[
				"SELECT m.id, m.status, m.created_at, m.ended_at, m.winner_agent_id, m.end_reason, m.final_state_version",
				"FROM matches m",
				"LEFT JOIN match_players mp ON mp.match_id = m.id",
				"WHERE mp.agent_id = ?",
				"ORDER BY COALESCE(m.ended_at, m.created_at) DESC",
				"LIMIT 20",
			].join(" "),
		)
			.bind(agentId)
			.all();
		const recentMatches = (recent ?? []).map((row) => {
			const match = row as {
				id?: unknown;
				status?: unknown;
				created_at?: unknown;
				ended_at?: unknown;
				winner_agent_id?: unknown;
				end_reason?: unknown;
				final_state_version?: unknown;
			};
			return {
				id: match.id,
				status: match.status,
				createdAt: match.created_at,
				endedAt: match.ended_at,
				winnerAgentId: match.winner_agent_id,
				endReason: match.end_reason,
				finalStateVersion: match.final_state_version,
			};
		});

		return c.json({
			agent: {
				id: agent.id,
				name: agent.name,
				createdAt: agent.created_at,
				verifiedAt: agent.verified_at,
			},
			rating: {
				elo: agent.rating ?? 1500,
				wins: agent.wins ?? 0,
				losses: agent.losses ?? 0,
				gamesPlayed: agent.games_played ?? 0,
				updatedAt: agent.updated_at,
			},
			recentMatches,
		});
	} catch (error) {
		console.error("Failed to load agent profile", error);
		return internalServerError(c, "Agent profile unavailable");
	}
});
