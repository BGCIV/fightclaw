import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveMatchmakerShardName } from "../../src/utils/matchmakerShards";
import { authHeader, createAgent, ensureResetDb, resetDb } from "../helpers";

const readInfoLogs = (spy: ReturnType<typeof vi.spyOn>) => {
	return spy.mock.calls
		.map(([message]) => {
			if (typeof message !== "string") return null;
			try {
				return JSON.parse(message) as Record<string, unknown>;
			} catch {
				return null;
			}
		})
		.filter((entry): entry is Record<string, unknown> => entry !== null);
};

beforeEach(async () => {
	await resetDb();
});

afterEach(async () => {
	try {
		await resetDb();
	} finally {
		await ensureResetDb();
	}
});

it("pairs two agents into one match", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");

	const first = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const firstJson = (await first.json()) as { matchId: string; status: string };
	expect(firstJson.status).toBe("waiting");

	const second = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const secondJson = (await second.json()) as {
		matchId: string;
		status: string;
	};
	expect(secondJson.status).toBe("ready");
	expect(secondJson.matchId).toBe(firstJson.matchId);
});

it("supports join/status/leave", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");

	const join = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	expect(join.status).toBe(200);
	const joinJson = (await join.json()) as { matchId: string; status: string };
	expect(joinJson.status).toBe("waiting");

	const statusWaiting = await SELF.fetch(
		"https://example.com/v1/queue/status",
		{
			headers: authHeader(agentA.key),
		},
	);
	expect(statusWaiting.status).toBe(200);
	const statusWaitingJson = (await statusWaiting.json()) as {
		status: string;
		matchId?: string;
	};
	expect(statusWaitingJson.status).toBe("waiting");
	expect(statusWaitingJson.matchId).toBe(joinJson.matchId);

	const leave = await SELF.fetch("https://example.com/v1/queue/leave", {
		method: "DELETE",
		headers: authHeader(agentA.key),
	});
	expect(leave.status).toBe(200);
	const leaveJson = (await leave.json()) as { ok: boolean };
	expect(leaveJson.ok).toBe(true);

	const statusIdle = await SELF.fetch("https://example.com/v1/queue/status", {
		headers: authHeader(agentA.key),
	});
	expect(statusIdle.status).toBe(200);
	const statusIdleJson = (await statusIdle.json()) as { status: string };
	expect(statusIdleJson.status).toBe("idle");
});

it("rejects unsupported queue modes", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");

	const join = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: {
			...authHeader(agentA.key),
			"content-type": "application/json",
		},
		body: JSON.stringify({ mode: "casual" }),
	});
	expect(join.status).toBe(400);
	const payload = (await join.json()) as { error?: string };
	expect(payload.error).toContain("ranked");
});

it("enforces ELO range for matchmaking", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");
	const agentC = await createAgent("Gamma", "gamma-key");

	await env.DB.batch([
		env.DB.prepare(
			"INSERT OR IGNORE INTO leaderboard(agent_id, rating, wins, losses, games_played) VALUES (?, ?, 0, 0, 0)",
		).bind(agentB.id, 1700),
		env.DB.prepare(
			"INSERT OR IGNORE INTO leaderboard(agent_id, rating, wins, losses, games_played) VALUES (?, ?, 0, 0, 0)",
		).bind(agentC.id, 2000),
		env.DB.prepare("UPDATE leaderboard SET rating=? WHERE agent_id=?").bind(
			1700,
			agentB.id,
		),
		env.DB.prepare("UPDATE leaderboard SET rating=? WHERE agent_id=?").bind(
			2000,
			agentC.id,
		),
	]);

	const first = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const firstJson = (await first.json()) as { matchId: string; status: string };
	expect(firstJson.status).toBe("waiting");

	const second = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentC.key),
	});
	const secondJson = (await second.json()) as {
		matchId: string;
		status: string;
	};
	expect(secondJson.status).toBe("waiting");

	const third = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const thirdJson = (await third.json()) as {
		matchId: string;
		status: string;
		opponentId?: string;
	};
	expect(thirdJson.status).toBe("ready");
	expect(thirdJson.matchId).toBe(firstJson.matchId);
	expect(thirdJson.opponentId).toBe(agentA.id);

	const cStatus = await SELF.fetch("https://example.com/v1/queue/status", {
		headers: authHeader(agentC.key),
	});
	const cStatusJson = (await cStatus.json()) as {
		status: string;
		matchId?: string;
	};
	expect(cStatusJson.status).toBe("waiting");
	expect(cStatusJson.matchId).toBe(secondJson.matchId);
});

it("avoids immediate rematches when alternatives exist", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");
	const agentC = await createAgent("Gamma", "gamma-key");

	await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const second = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const secondJson = (await second.json()) as {
		matchId: string;
		status: string;
	};
	expect(secondJson.status).toBe("ready");

	await SELF.fetch(
		`https://example.com/v1/matches/${secondJson.matchId}/finish`,
		{
			method: "POST",
			headers: {
				...authHeader(agentA.key),
				"content-type": "application/json",
				"x-admin-key": env.ADMIN_KEY,
			},
			body: JSON.stringify({ reason: "forfeit" }),
		},
	);

	// Seed ratings so B and C cannot match each other, but A can match both.
	await env.DB.batch([
		env.DB.prepare(
			"INSERT OR IGNORE INTO leaderboard(agent_id, rating, wins, losses, games_played) VALUES (?, ?, 0, 0, 0)",
		).bind(agentC.id, 1900),
		env.DB.prepare("UPDATE leaderboard SET rating=? WHERE agent_id=?").bind(
			1700,
			agentA.id,
		),
		env.DB.prepare("UPDATE leaderboard SET rating=? WHERE agent_id=?").bind(
			1500,
			agentB.id,
		),
		env.DB.prepare("UPDATE leaderboard SET rating=? WHERE agent_id=?").bind(
			1900,
			agentC.id,
		),
	]);

	const bJoin = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const bJoinJson = (await bJoin.json()) as { matchId: string; status: string };
	expect(bJoinJson.status).toBe("waiting");

	const cJoin = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentC.key),
	});
	const cJoinJson = (await cJoin.json()) as { matchId: string; status: string };
	expect(cJoinJson.status).toBe("waiting");

	const aJoin = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const aJoinJson = (await aJoin.json()) as {
		matchId: string;
		status: string;
		opponentId?: string;
	};
	expect(aJoinJson.status).toBe("ready");
	expect(aJoinJson.matchId).toBe(cJoinJson.matchId);
	expect(aJoinJson.opponentId).toBe(agentC.id);

	const bStatus = await SELF.fetch("https://example.com/v1/queue/status", {
		headers: authHeader(agentB.key),
	});
	const bStatusJson = (await bStatus.json()) as {
		status: string;
		matchId?: string;
	};
	expect(bStatusJson.status).toBe("waiting");
	expect(bStatusJson.matchId).toBe(bJoinJson.matchId);
});

it("blocks disabled agents and prunes their waiting queue entries", async () => {
	const disabled = await createAgent("OldKai", "old-kai-key");
	const agentB = await createAgent("AgentSmith", "agent-smith-key");
	const agentC = await createAgent("Neo", "neo-key");

	const disabledJoin = await SELF.fetch(
		"https://example.com/v1/matches/queue",
		{
			method: "POST",
			headers: authHeader(disabled.key),
		},
	);
	const disabledJoinJson = (await disabledJoin.json()) as {
		status: string;
		matchId: string;
	};
	expect(disabledJoinJson.status).toBe("waiting");

	const disableRes = await SELF.fetch(
		`https://example.com/v1/admin/agents/${disabled.id}/disable`,
		{
			method: "POST",
			headers: {
				"x-admin-key": env.ADMIN_KEY,
			},
		},
	);
	expect(disableRes.status).toBe(200);

	const blockedJoin = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(disabled.key),
	});
	expect(blockedJoin.status).toBe(403);
	const blockedBody = (await blockedJoin.json()) as { code?: string };
	expect(blockedBody.code).toBe("agent_disabled");

	const bJoin = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const bJoinJson = (await bJoin.json()) as { status: string; matchId: string };
	expect(bJoinJson.status).toBe("waiting");

	const cJoin = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentC.key),
	});
	const cJoinJson = (await cJoin.json()) as {
		status: string;
		matchId: string;
		opponentId?: string;
	};
	expect(cJoinJson.status).toBe("ready");
	expect(cJoinJson.matchId).toBe(bJoinJson.matchId);
	expect(cJoinJson.opponentId).toBe(agentB.id);
	expect(cJoinJson.matchId).not.toBe(disabledJoinJson.matchId);
});

it("keeps agents in separate queue shards from matching each other", async () => {
	const shardOverrideHeader = { "x-fc-test-matchmaker-shards": "2" };
	const idA = "00000000-0000-4000-8000-000000000001";
	let idB = "00000000-0000-4000-8000-000000000002";
	if (
		resolveMatchmakerShardName(idA, 2) === resolveMatchmakerShardName(idB, 2)
	) {
		idB = "00000000-0000-4000-8000-000000000003";
	}
	expect(resolveMatchmakerShardName(idA, 2)).not.toBe(
		resolveMatchmakerShardName(idB, 2),
	);

	const agentA = await createAgent("ShardAlpha", "shard-alpha-key", idA);
	const agentB = await createAgent("ShardBeta", "shard-beta-key", idB);

	const first = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: {
			...authHeader(agentA.key),
			...shardOverrideHeader,
		},
	});
	const firstJson = (await first.json()) as { status: string; matchId: string };
	expect(firstJson.status).toBe("waiting");

	const second = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: {
			...authHeader(agentB.key),
			...shardOverrideHeader,
		},
	});
	const secondJson = (await second.json()) as {
		status: string;
		matchId: string;
		opponentId?: string;
	};
	expect(secondJson.status).toBe("waiting");
	expect(secondJson.matchId).not.toBe(firstJson.matchId);
	expect(secondJson.opponentId).toBeUndefined();

	try {
		await SELF.fetch("https://example.com/v1/internal/__test__/reset", {
			method: "POST",
			headers: {
				"x-runner-key": env.INTERNAL_RUNNER_KEY ?? "",
				"x-runner-id": "test-runner",
				...shardOverrideHeader,
			},
		});
	} finally {
		await ensureResetDb();
	}
});

it("returns buffered events immediately without blocking", async () => {
	const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
	try {
		const agentA = await createAgent("BufferedAlpha", "buffered-alpha-key");
		const agentB = await createAgent("BufferedBeta", "buffered-beta-key");

		await SELF.fetch("https://example.com/v1/matches/queue", {
			method: "POST",
			headers: authHeader(agentA.key),
		});
		await SELF.fetch("https://example.com/v1/matches/queue", {
			method: "POST",
			headers: authHeader(agentB.key),
		});

		const waitRes = await SELF.fetch("https://example.com/v1/events/wait", {
			headers: authHeader(agentA.key),
		});
		expect(waitRes.status).toBe(200);
		const payload = (await waitRes.json()) as {
			events: Array<{ event: string }>;
		};
		expect(payload.events[0]?.event).toBe("match_found");
		expect(payload.events).toHaveLength(1);

		const logs = readInfoLogs(infoSpy);
		expect(
			logs.some((entry) => entry.message === "runner_queue_wait_started"),
		).toBe(false);
		expect(
			logs.some((entry) => entry.message === "runner_queue_wait_resolved"),
		).toBe(false);
	} finally {
		infoSpy.mockRestore();
	}
});

it("blocks until a match is found when no buffered event exists", async () => {
	const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
	try {
		const agentA = await createAgent("BlockingAlpha", "blocking-alpha-key");
		const agentB = await createAgent("BlockingBeta", "blocking-beta-key");

		const firstJoin = await SELF.fetch("https://example.com/v1/matches/queue", {
			method: "POST",
			headers: authHeader(agentA.key),
		});
		expect(firstJoin.ok).toBe(true);

		const waitPromise = SELF.fetch(
			"https://example.com/v1/events/wait?timeout=2",
			{
				headers: authHeader(agentA.key),
			},
		);

		await new Promise((resolve) => setTimeout(resolve, 25));

		const joinRes = await SELF.fetch("https://example.com/v1/matches/queue", {
			method: "POST",
			headers: authHeader(agentB.key),
		});
		expect(joinRes.ok).toBe(true);

		const waitRes = await waitPromise;
		expect(waitRes.status).toBe(200);
		const payload = (await waitRes.json()) as {
			events: Array<{ event: string; matchId?: string }>;
		};
		expect(payload.events.some((event) => event.event === "match_found")).toBe(
			true,
		);
		expect(payload.events).toHaveLength(1);

		const logs = readInfoLogs(infoSpy);
		const started = logs.find(
			(entry) => entry.message === "runner_queue_wait_started",
		);
		const resolved = logs.find(
			(entry) => entry.message === "runner_queue_wait_resolved",
		);
		expect(started).toMatchObject({
			event: "runner_queue_wait_started",
			route: "/v1/events/wait",
			agentId: agentA.id,
			timeoutSeconds: 2,
		});
		expect(resolved).toMatchObject({
			event: "runner_queue_wait_resolved",
			route: "/v1/events/wait",
			agentId: agentA.id,
			resolution: "match_found",
		});
		expect(
			typeof resolved?.waitMs === "number" &&
				Number.isFinite(resolved.waitMs as number),
		).toBe(true);
	} finally {
		infoSpy.mockRestore();
	}
});

it("returns no_events immediately for timeout=0 without wait logs", async () => {
	const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
	try {
		const agentA = await createAgent("TimeoutAlpha", "timeout-alpha-key");

		const waitRes = await SELF.fetch(
			"https://example.com/v1/events/wait?timeout=0",
			{
				headers: authHeader(agentA.key),
			},
		);
		expect(waitRes.status).toBe(200);
		const payload = (await waitRes.json()) as {
			events: Array<{ event: string }>;
		};
		expect(payload.events[0]?.event).toBe("no_events");
		expect(payload.events).toHaveLength(1);

		const logs = readInfoLogs(infoSpy);
		expect(
			logs.some((entry) => entry.message === "runner_queue_wait_started"),
		).toBe(false);
		expect(
			logs.some((entry) => entry.message === "runner_queue_wait_resolved"),
		).toBe(false);
	} finally {
		infoSpy.mockRestore();
	}
});

it("logs timeout resolution when a blocking wait expires without a match", async () => {
	const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
	try {
		const agentA = await createAgent("TimeoutBeta", "timeout-beta-key");

		const waitRes = await SELF.fetch(
			"https://example.com/v1/events/wait?timeout=1",
			{
				headers: authHeader(agentA.key),
			},
		);
		expect(waitRes.status).toBe(200);
		const payload = (await waitRes.json()) as {
			events: Array<{ event: string }>;
		};
		expect(payload.events[0]?.event).toBe("no_events");
		expect(payload.events).toHaveLength(1);

		const logs = readInfoLogs(infoSpy);
		const started = logs.find(
			(entry) => entry.message === "runner_queue_wait_started",
		);
		const resolved = logs.find(
			(entry) => entry.message === "runner_queue_wait_resolved",
		);
		expect(started).toMatchObject({
			event: "runner_queue_wait_started",
			route: "/v1/events/wait",
			agentId: agentA.id,
			timeoutSeconds: 1,
		});
		expect(resolved).toMatchObject({
			event: "runner_queue_wait_resolved",
			route: "/v1/events/wait",
			agentId: agentA.id,
			resolution: "timeout",
		});
		expect(
			typeof resolved?.waitMs === "number" &&
				Number.isFinite(resolved.waitMs as number) &&
				(resolved.waitMs as number) >= 1000,
		).toBe(true);
	} finally {
		infoSpy.mockRestore();
	}
});
