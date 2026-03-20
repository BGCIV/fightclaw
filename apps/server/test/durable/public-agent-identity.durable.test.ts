import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createAgent, resetDb } from "../helpers";

const seedActivePublicPersona = async (
	agentId: string,
	publicPersona: string | null,
) => {
	const promptId = crypto.randomUUID();
	await env.DB.batch([
		env.DB.prepare(
			[
				"INSERT INTO prompt_versions",
				"(id, agent_id, game_type, version, public_persona, private_strategy_ciphertext, private_strategy_iv)",
				"VALUES (?, ?, 'hex_conquest', 1, ?, 'ciphertext', 'iv')",
			].join(" "),
		).bind(promptId, agentId, publicPersona),
		env.DB.prepare(
			[
				"INSERT INTO agent_prompt_active",
				"(agent_id, game_type, prompt_version_id, activated_at)",
				"VALUES (?, 'hex_conquest', ?, datetime('now'))",
			].join(" "),
		).bind(agentId, promptId),
	]);
};

describe("public agent identity", () => {
	beforeEach(async () => {
		await resetDb();
	});

	it("returns public identity for a single agent", async () => {
		const agent = await createAgent("Kai", "kai-key");
		await seedActivePublicPersona(
			agent.id,
			"Terrain-first opportunist who wins by pressure and income.",
		);

		const res = await SELF.fetch(
			`https://example.com/v1/agents/${agent.id}/public`,
		);

		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			agent: {
				agentId: string;
				agentName: string;
				publicPersona: string | null;
				styleTag: string | null;
			};
		};
		expect(data.agent).toEqual({
			agentId: agent.id,
			agentName: "Kai",
			publicPersona:
				"Terrain-first opportunist who wins by pressure and income.",
			styleTag: "OBJECTIVE",
		});
	});

	it("returns null identity fields when no active public persona exists", async () => {
		const agent = await createAgent("PlainAgent", "plain-key");

		const res = await SELF.fetch(
			`https://example.com/v1/agents/${agent.id}/public`,
		);

		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			agent: {
				agentId: string;
				agentName: string;
				publicPersona: string | null;
				styleTag: string | null;
			};
		};
		expect(data.agent).toEqual({
			agentId: agent.id,
			agentName: "PlainAgent",
			publicPersona: null,
			styleTag: null,
		});
	});

	it("returns public identities in request order for batch lookup", async () => {
		const agentA = await createAgent("Kai", "kai-batch-key");
		const agentB = await createAgent("Smith", "smith-batch-key");
		await seedActivePublicPersona(
			agentA.id,
			"Terrain-first opportunist who wins by pressure and income.",
		);

		const res = await SELF.fetch("https://example.com/v1/agents/public/batch", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentIds: [agentB.id, agentA.id],
			}),
		});

		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			agents: Array<{
				agentId: string;
				agentName: string;
				publicPersona: string | null;
				styleTag: string | null;
			}>;
		};
		expect(data.agents).toEqual([
			{
				agentId: agentB.id,
				agentName: "Smith",
				publicPersona: null,
				styleTag: null,
			},
			{
				agentId: agentA.id,
				agentName: "Kai",
				publicPersona:
					"Terrain-first opportunist who wins by pressure and income.",
				styleTag: "OBJECTIVE",
			},
		]);
	});
});
