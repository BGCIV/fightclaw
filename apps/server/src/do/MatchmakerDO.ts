import { DurableObject } from "cloudflare:workers";
import {
	buildMatchFoundEvent,
	buildNoEventsEvent,
	type MatchFoundEvent,
	type NoEventsEvent,
} from "../protocol/events";

const LATEST_MATCH_KEY = "latestMatchId";
const PENDING_MATCH_KEY = "pendingMatchId";
const PENDING_AGENT_KEY = "pendingAgentId";
const EVENT_BUFFER_PREFIX = "events:";
const EVENT_BUFFER_MAX = 25;
const ELO_START = 1500;

type MatchmakerEnv = {
	DB: D1Database;
	MATCH: DurableObjectNamespace;
};

type QueueResponse = { matchId: string; status: "waiting" | "ready" };
type MatchmakerEvent = MatchFoundEvent | NoEventsEvent;

export class MatchmakerDO extends DurableObject<MatchmakerEnv> {
	private waiters = new Map<string, Set<(event: MatchmakerEvent) => void>>();

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "POST" && url.pathname === "/queue") {
			const agentId = request.headers.get("x-agent-id");
			if (!agentId) {
				return Response.json(
					{ error: "Agent id is required." },
					{ status: 400 },
				);
			}

			const pendingMatchId =
				await this.ctx.storage.get<string>(PENDING_MATCH_KEY);
			const pendingAgentId =
				await this.ctx.storage.get<string>(PENDING_AGENT_KEY);

			if (pendingMatchId && pendingAgentId) {
				if (pendingAgentId === agentId) {
					const response: QueueResponse = {
						matchId: pendingMatchId,
						status: "waiting",
					};
					return Response.json(response);
				}

				await this.ctx.storage.delete(PENDING_MATCH_KEY);
				await this.ctx.storage.delete(PENDING_AGENT_KEY);
				await this.ctx.storage.put(LATEST_MATCH_KEY, pendingMatchId);

				const players = [pendingAgentId, agentId];
				const id = this.env.MATCH.idFromName(pendingMatchId);
				const stub = this.env.MATCH.get(id);
				await stub.fetch("https://do/init", {
					method: "POST",
					body: JSON.stringify({
						players,
						seed: Math.floor(Math.random() * 1_000_000),
					}),
					headers: {
						"content-type": "application/json",
					},
				});

				await this.recordMatchPlayers(pendingMatchId, players);
				await this.enqueueEvent(
					pendingAgentId,
					buildMatchFoundEvent(pendingMatchId, agentId),
				);
				await this.enqueueEvent(
					agentId,
					buildMatchFoundEvent(pendingMatchId, pendingAgentId),
				);

				const response: QueueResponse = {
					matchId: pendingMatchId,
					status: "ready",
				};
				return Response.json(response);
			}

			const matchId = crypto.randomUUID();
			await this.ctx.storage.put(PENDING_MATCH_KEY, matchId);
			await this.ctx.storage.put(PENDING_AGENT_KEY, agentId);
			await this.ctx.storage.put(LATEST_MATCH_KEY, matchId);
			await this.recordMatch(matchId);

			const response: QueueResponse = { matchId, status: "waiting" };
			return Response.json(response);
		}

		if (request.method === "GET" && url.pathname === "/events/wait") {
			const agentId = request.headers.get("x-agent-id");
			if (!agentId) {
				return Response.json(
					{ error: "Agent id is required." },
					{ status: 400 },
				);
			}

			const timeoutParam = url.searchParams.get("timeout");
			const timeoutSeconds = timeoutParam
				? Number.parseInt(timeoutParam, 10)
				: 30;
			const event = await this.waitForEvent(
				agentId,
				Number.isNaN(timeoutSeconds) ? 30 : timeoutSeconds,
			);
			return Response.json({ events: [event] });
		}

		if (request.method === "GET" && url.pathname === "/live") {
			const matchId = await this.ctx.storage.get<string>(LATEST_MATCH_KEY);
			if (!matchId) {
				return Response.json({ matchId: null, state: null });
			}

			const id = this.env.MATCH.idFromName(matchId);
			const stub = this.env.MATCH.get(id);
			const resp = await stub.fetch("https://do/state");
			if (!resp.ok) {
				return Response.json({ matchId, state: null });
			}

			const payload = (await resp.json()) as { state?: unknown };
			return Response.json({ matchId, state: payload.state ?? null });
		}

		return new Response("Not found", { status: 404 });
	}

	private async recordMatch(matchId: string) {
		try {
			await this.env.DB.prepare(
				"INSERT INTO matches(id, status, created_at) VALUES (?, 'active', datetime('now'))",
			)
				.bind(matchId)
				.run();
		} catch (error) {
			console.error("Failed to record match", error);
		}
	}

	private async recordMatchPlayers(matchId: string, players: string[]) {
		try {
			const ratings = await Promise.all(
				players.map((agentId) => this.getRating(agentId)),
			);
			await this.env.DB.batch([
				this.env.DB.prepare(
					"INSERT OR IGNORE INTO match_players(match_id, agent_id, seat, starting_rating, prompt_version_id) VALUES (?, ?, ?, ?, NULL)",
				).bind(matchId, players[0], 0, ratings[0]),
				this.env.DB.prepare(
					"INSERT OR IGNORE INTO match_players(match_id, agent_id, seat, starting_rating, prompt_version_id) VALUES (?, ?, ?, ?, NULL)",
				).bind(matchId, players[1], 1, ratings[1]),
			]);
		} catch (error) {
			console.error("Failed to record match players", error);
		}
	}

	private async getRating(agentId: string) {
		const row = await this.env.DB.prepare(
			"SELECT rating FROM leaderboard WHERE agent_id = ?",
		)
			.bind(agentId)
			.first<{ rating: number }>();
		return typeof row?.rating === "number" ? row.rating : ELO_START;
	}

	private async enqueueEvent(agentId: string, event: MatchmakerEvent) {
		const waiters = this.waiters.get(agentId);
		if (waiters && waiters.size > 0) {
			const [first] = waiters;
			if (first) {
				this.removeWaiter(agentId, first);
				first(event);
				return;
			}
		}

		const key = `${EVENT_BUFFER_PREFIX}${agentId}`;
		const events = (await this.ctx.storage.get<MatchmakerEvent[]>(key)) ?? [];
		events.push(event);
		if (events.length > EVENT_BUFFER_MAX) {
			events.splice(0, events.length - EVENT_BUFFER_MAX);
		}
		await this.ctx.storage.put(key, events);
	}

	private async waitForEvent(
		agentId: string,
		timeoutSeconds: number,
	): Promise<MatchmakerEvent> {
		const key = `${EVENT_BUFFER_PREFIX}${agentId}`;
		const events = (await this.ctx.storage.get<MatchmakerEvent[]>(key)) ?? [];
		if (events.length > 0) {
			const [next, ...rest] = events;
			await this.ctx.storage.put(key, rest);
			return next;
		}

		return new Promise((resolve) => {
			const timeoutMs = Math.max(timeoutSeconds, 0) * 1000;
			let resolver: (event: MatchmakerEvent) => void;
			const timer = setTimeout(() => {
				this.removeWaiter(agentId, resolver);
				resolve(buildNoEventsEvent());
			}, timeoutMs);

			resolver = (event: MatchmakerEvent) => {
				clearTimeout(timer);
				this.removeWaiter(agentId, resolver);
				resolve(event);
			};

			const waiters = this.waiters.get(agentId) ?? new Set();
			waiters.add(resolver);
			this.waiters.set(agentId, waiters);
		});
	}

	private removeWaiter(
		agentId: string,
		resolver: (event: MatchmakerEvent) => void,
	) {
		const waiters = this.waiters.get(agentId);
		if (!waiters) return;
		waiters.delete(resolver);
		if (waiters.size === 0) {
			this.waiters.delete(agentId);
		}
	}
}
