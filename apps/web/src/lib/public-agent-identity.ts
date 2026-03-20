export type PublicAgentIdentity = {
	agentId: string;
	agentName: string;
	publicPersona: string | null;
	styleTag: string | null;
};

export type PublicAgentIdentityMap = Record<string, PublicAgentIdentity>;

type PublicAgentIdentityBatchResponse = {
	agents: PublicAgentIdentity[];
};

export function buildParticipantIdentityRequest(input: {
	agentAId: string | null | undefined;
	agentBId: string | null | undefined;
}): {
	agentIds: string[];
	identityKey: string;
} {
	const agentAId =
		typeof input.agentAId === "string" ? input.agentAId.trim() : "";
	const agentBId =
		typeof input.agentBId === "string" ? input.agentBId.trim() : "";

	if (!agentAId || !agentBId) {
		return { agentIds: [], identityKey: "" };
	}

	return {
		agentIds: [agentAId, agentBId],
		identityKey: `${agentAId}|${agentBId}`,
	};
}

export function buildPublicAgentIdentityMap(
	agents: readonly PublicAgentIdentity[],
): PublicAgentIdentityMap {
	return Object.fromEntries(
		agents.map((agent) => [agent.agentId, agent] as const),
	);
}

export function resolveBroadcastIdentity(input: {
	agentId: string | null | undefined;
	fallbackName: string;
	fallbackStyleTag: string;
	publicIdentityById: PublicAgentIdentityMap;
}): {
	name: string;
	publicPersona: string | null;
	styleTag: string;
} {
	const identity = input.agentId
		? input.publicIdentityById[input.agentId]
		: null;
	return {
		name: identity?.agentName ?? input.fallbackName,
		publicPersona: identity?.publicPersona ?? null,
		styleTag: identity?.styleTag ?? input.fallbackStyleTag,
	};
}

export async function fetchPublicAgentIdentityMap(
	input: {
		agentIds: readonly string[];
		baseUrl: string;
	},
	fetchImpl: typeof fetch = fetch,
): Promise<PublicAgentIdentityMap> {
	const normalizedAgentIds = Array.from(
		new Set(
			input.agentIds
				.map((agentId) => agentId.trim())
				.filter((agentId) => agentId.length > 0),
		),
	);
	if (normalizedAgentIds.length === 0) return {};

	const res = await fetchImpl(`${input.baseUrl}/v1/agents/public/batch`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ agentIds: normalizedAgentIds }),
	});
	if (!res.ok) {
		throw new Error(`Public identity request failed (${res.status})`);
	}

	const json = (await res.json()) as PublicAgentIdentityBatchResponse;
	return buildPublicAgentIdentityMap(json.agents ?? []);
}
