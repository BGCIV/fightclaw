import { type Context, Hono } from "hono";

import type { AppBindings, AppVariables } from "../appTypes";
import { doFetchWithRetry } from "../utils/durable";
import { unauthorized } from "../utils/httpErrors";
import { adaptDoErrorEnvelope } from "../utils/responseAdapters";

const getMatchmakerStub = (c: { env: AppBindings }) => {
	const id = c.env.MATCHMAKER.idFromName("global");
	return c.env.MATCHMAKER.get(id);
};

type AppContext = Context<{ Bindings: AppBindings; Variables: AppVariables }>;

const queueJoin = async (c: AppContext) => {
	const agentId = c.get("agentId");
	if (!agentId) return unauthorized(c);

	const stub = getMatchmakerStub(c);
	const response = await doFetchWithRetry(stub, "https://do/queue/join", {
		method: "POST",
		headers: {
			"x-agent-id": agentId,
			"x-request-id": c.get("requestId"),
		},
	});
	return adaptDoErrorEnvelope(response);
};

const queueStatus = async (c: AppContext) => {
	const agentId = c.get("agentId");
	if (!agentId) return unauthorized(c);

	const stub = getMatchmakerStub(c);
	const response = await doFetchWithRetry(stub, "https://do/queue/status", {
		headers: {
			"x-agent-id": agentId,
			"x-request-id": c.get("requestId"),
		},
	});
	return adaptDoErrorEnvelope(response);
};

const queueLeave = async (c: AppContext) => {
	const agentId = c.get("agentId");
	if (!agentId) return unauthorized(c);

	const stub = getMatchmakerStub(c);
	const response = await doFetchWithRetry(stub, "https://do/queue/leave", {
		method: "DELETE",
		headers: {
			"x-agent-id": agentId,
			"x-request-id": c.get("requestId"),
		},
	});
	return adaptDoErrorEnvelope(response);
};

export const queueRoutes = new Hono<{
	Bindings: AppBindings;
	Variables: AppVariables;
}>();

queueRoutes.post("/v1/queue/join", async (c) => {
	return queueJoin(c);
});

queueRoutes.get("/v1/queue/status", async (c) => {
	return queueStatus(c);
});

queueRoutes.delete("/v1/queue/leave", async (c) => {
	return queueLeave(c);
});

queueRoutes.post("/v1/matches/queue", async (c) => {
	return queueJoin(c);
});

queueRoutes.get("/v1/matches/queue/status", async (c) => {
	return queueStatus(c);
});

queueRoutes.post("/v1/matches/queue/leave", async (c) => {
	return queueLeave(c);
});

queueRoutes.get("/v1/events/wait", async (c) => {
	const agentId = c.get("agentId");
	if (!agentId) return unauthorized(c);

	const stub = getMatchmakerStub(c);
	const timeout = c.req.query("timeout");
	const qs = timeout ? `?timeout=${encodeURIComponent(timeout)}` : "";
	const response = await doFetchWithRetry(stub, `https://do/events/wait${qs}`, {
		headers: {
			"x-agent-id": agentId,
			"x-request-id": c.get("requestId"),
		},
	});
	return adaptDoErrorEnvelope(response);
});

queueRoutes.get("/v1/featured", async (c) => {
	const stub = getMatchmakerStub(c);
	const response = await doFetchWithRetry(stub, "https://do/featured", {
		headers: {
			"x-request-id": c.get("requestId"),
		},
	});
	return adaptDoErrorEnvelope(response);
});

queueRoutes.get("/v1/live", async (c) => {
	const stub = getMatchmakerStub(c);
	const response = await doFetchWithRetry(stub, "https://do/live", {
		headers: {
			"x-request-id": c.get("requestId"),
		},
	});
	return adaptDoErrorEnvelope(response);
});
