import assert from "node:assert/strict";
import { test } from "node:test";
import {
	loadHexConquestPreset,
	publishAgentStrategy,
	resolveStrategySelection,
} from "../src/presets";

test("loads the checked-in objective beta preset artifact", () => {
	const preset = loadHexConquestPreset("objective_beta");
	assert.equal(preset.id, "objective_beta");
	assert.equal(preset.gameType, "hex_conquest");
	assert.equal(
		preset.publicPersona,
		"Terrain-first opportunist who wins by pressure and income.",
	);
	assert.match(preset.privateStrategy, /Contest crowns and income nodes early/);
});

test("throws for unknown preset names", () => {
	assert.throws(
		() => loadHexConquestPreset("missing_beta"),
		/Unknown hex_conquest preset/,
	);
});

test("requires exactly one strategy input per side", () => {
	assert.deepEqual(
		resolveStrategySelection({
			side: "A",
			rawStrategy: "Play safely.",
		}),
		{
			publicPersona: null,
			privateStrategy: "Play safely.",
			source: {
				kind: "inline",
			},
		},
	);

	assert.equal(
		resolveStrategySelection({
			side: "B",
			presetName: "objective_beta",
		}).source.kind,
		"preset",
	);

	assert.throws(
		() =>
			resolveStrategySelection({
				side: "A",
				rawStrategy: "Play safely.",
				presetName: "objective_beta",
			}),
		/Exactly one of --strategyA or --strategyPresetA is required/,
	);

	assert.throws(
		() =>
			resolveStrategySelection({
				side: "B",
			}),
		/Exactly one of --strategyB or --strategyPresetB is required/,
	);
});

test("publishes a preset strategy payload through the existing endpoint", async () => {
	const calls: Array<{
		url: string;
		method: string;
		headers: HeadersInit;
		body: string;
	}> = [];

	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			headers: init?.headers ?? {},
			body: String(init?.body ?? ""),
		});
		return new Response(JSON.stringify({ created: { version: 1 } }), {
			status: 201,
			headers: {
				"content-type": "application/json",
			},
		});
	}) as typeof fetch;

	try {
		await publishAgentStrategy({
			baseUrl: "https://example.com",
			apiKey: "agent-key",
			selection: resolveStrategySelection({
				side: "A",
				presetName: "objective_beta",
			}),
		});
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.equal(calls.length, 1);
	assert.equal(
		calls[0]?.url,
		"https://example.com/v1/agents/me/strategy/hex_conquest",
	);
	assert.equal(calls[0]?.method, "POST");

	const payload = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
	assert.equal(payload.activate, true);
	assert.equal(
		payload.publicPersona,
		"Terrain-first opportunist who wins by pressure and income.",
	);
	assert.match(
		String(payload.privateStrategy ?? ""),
		/Contest crowns and income nodes early/,
	);
});
