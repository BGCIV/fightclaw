export const PUBLIC_IDENTITY_GAME_TYPE = "hex_conquest" as const;

export type PublicAgentIdentity = {
	agentId: string;
	agentName: string;
	publicPersona: string | null;
	styleTag: string | null;
};

type PublicAgentIdentityRow = {
	agent_id: string;
	agent_name: string;
	public_persona: string | null;
};

const STYLE_TAG_RULES: Array<{
	tag: string;
	terms: string[];
}> = [
	{
		tag: "OBJECTIVE",
		terms: ["terrain-first", "pressure", "income", "opportunist"],
	},
	{
		tag: "PRESSURE",
		terms: ["rushdown", "tempo", "initiative", "aggressive"],
	},
	{
		tag: "TEMPO",
		terms: ["calm", "disciplined", "steady", "measured"],
	},
	{
		tag: "DEFENSIVE",
		terms: ["defensive", "stabilize", "stabilising", "stabilizing", "hold"],
	},
	{
		tag: "SAFE",
		terms: ["safe", "safety", "careful", "cautious"],
	},
	{
		tag: "ATTRITION",
		terms: ["attrition", "grind", "endurance", "wear down"],
	},
];

export function normalizePublicPersona(
	publicPersona: string | null | undefined,
): string | null {
	if (typeof publicPersona !== "string") return null;
	const trimmed = publicPersona.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function derivePublicStyleTag(
	publicPersona: string | null | undefined,
): string | null {
	const normalized = normalizePublicPersona(publicPersona);
	if (!normalized) return null;

	const lower = normalized.toLowerCase();
	for (const rule of STYLE_TAG_RULES) {
		if (rule.terms.some((term) => lower.includes(term))) {
			return rule.tag;
		}
	}

	return "GENERAL";
}

export async function readPublicAgentIdentity(
	db: D1Database,
	agentId: string,
	gameType = PUBLIC_IDENTITY_GAME_TYPE,
): Promise<PublicAgentIdentity | null> {
	const identities = await readPublicAgentIdentities(db, [agentId], gameType);
	return identities[0] ?? null;
}

export async function readPublicAgentIdentities(
	db: D1Database,
	agentIds: readonly string[],
	gameType = PUBLIC_IDENTITY_GAME_TYPE,
): Promise<PublicAgentIdentity[]> {
	const normalizedIds = normalizeAgentIds(agentIds);
	if (normalizedIds.length === 0) return [];

	const placeholders = normalizedIds.map(() => "?").join(", ");
	const { results } = await db
		.prepare(
			[
				"SELECT",
				"a.id as agent_id,",
				"a.name as agent_name,",
				"p.public_persona as public_persona",
				"FROM agents a",
				"LEFT JOIN agent_prompt_active ap",
				"ON ap.agent_id = a.id AND ap.game_type = ?",
				"LEFT JOIN prompt_versions p",
				"ON p.id = ap.prompt_version_id",
				`WHERE a.id IN (${placeholders})`,
			].join(" "),
		)
		.bind(gameType, ...normalizedIds)
		.all<PublicAgentIdentityRow>();

	const byId = new Map<string, PublicAgentIdentity>();
	for (const row of results ?? []) {
		const publicPersona = normalizePublicPersona(row.public_persona);
		byId.set(row.agent_id, {
			agentId: row.agent_id,
			agentName: row.agent_name,
			publicPersona,
			styleTag: derivePublicStyleTag(publicPersona),
		});
	}

	return normalizedIds.flatMap((agentId) => {
		const identity = byId.get(agentId);
		return identity ? [identity] : [];
	});
}

function normalizeAgentIds(agentIds: readonly string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];

	for (const agentId of agentIds) {
		const value = typeof agentId === "string" ? agentId.trim() : "";
		if (!value || seen.has(value)) continue;
		seen.add(value);
		normalized.push(value);
	}

	return normalized;
}
