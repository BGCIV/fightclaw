import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_HOUSE_GATEWAY_CMD,
	resolveHouseOpponentCommandOptions,
	runHouseOpponent,
} from "../src/beta";

test("defaults the house opponent command to safe_fallback_beta and the gateway move script", () => {
	const resolved = resolveHouseOpponentCommandOptions({
		baseUrl: "https://example.com",
		name: "HouseOpponent",
		adminKey: "admin-key",
		runnerKey: "runner-key",
		runnerId: "runner-1",
	});

	assert.equal(resolved.gatewayCmd, DEFAULT_HOUSE_GATEWAY_CMD);
	assert.equal(resolved.selection.source.kind, "preset");
	if (resolved.selection.source.kind !== "preset") {
		throw new Error("Expected preset strategy selection.");
	}
	assert.equal(resolved.selection.source.presetId, "safe_fallback_beta");
});

test("allows explicit house opponent preset overrides while preserving preset resolution", () => {
	const safeFallback = resolveHouseOpponentCommandOptions({
		baseUrl: "https://example.com",
		adminKey: "admin-key",
		runnerKey: "runner-key",
		runnerId: "runner-1",
		strategyPreset: "safe_fallback_beta",
	});
	assert.equal(safeFallback.selection.source.kind, "preset");
	if (safeFallback.selection.source.kind !== "preset") {
		throw new Error("Expected preset strategy selection.");
	}
	assert.equal(safeFallback.selection.source.presetId, "safe_fallback_beta");

	const objective = resolveHouseOpponentCommandOptions({
		baseUrl: "https://example.com",
		adminKey: "admin-key",
		runnerKey: "runner-key",
		runnerId: "runner-1",
		strategyPreset: "objective_beta",
	});
	assert.equal(objective.selection.source.kind, "preset");
	if (objective.selection.source.kind !== "preset") {
		throw new Error("Expected preset strategy selection.");
	}
	assert.equal(objective.selection.source.presetId, "objective_beta");
});

test("house opponent registers one agent, verifies it, publishes the preset, binds runner ownership, and runs until terminal", async () => {
	const calls: string[] = [];
	const expectedSelection = resolveHouseOpponentCommandOptions({
		baseUrl: "https://example.com",
		name: "HouseOpponent",
		adminKey: "admin-key",
		runnerKey: "runner-key",
		runnerId: "runner-1",
	}).selection;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		calls.push(url);

		if (url.endsWith("/v1/auth/register")) {
			return new Response(
				JSON.stringify({
					agent: {
						id: "house-123",
						name: "HouseOpponent",
						verified: false,
					},
					apiKey: "house-key",
					claimCode: "HOUSE-CLAIM",
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}

		if (url.endsWith("/v1/auth/verify")) {
			assert.equal(init?.method, "POST");
			assert.equal(new Headers(init?.headers).get("x-admin-key"), "admin-key");
			return new Response(
				JSON.stringify({
					agentId: "house-123",
					verifiedAt: "2026-03-19T17:00:00.000Z",
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}

		if (url.endsWith("/v1/internal/runners/agents/bind")) {
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}

		if (url.endsWith("/v1/agents/me/strategy/hex_conquest")) {
			assert.equal(init?.method, "POST");
			const payload = JSON.parse(
				String((init?.body as string | undefined) ?? "{}"),
			) as Record<string, unknown>;
			assert.equal(payload.publicPersona, expectedSelection.publicPersona);
			assert.equal(payload.privateStrategy, expectedSelection.privateStrategy);
			return new Response(JSON.stringify({ created: { version: 1 } }), {
				status: 201,
				headers: { "content-type": "application/json" },
			});
		}

		if (url.endsWith("/v1/auth/me")) {
			return new Response(
				JSON.stringify({
					agent: {
						id: "house-123",
						name: "HouseOpponent",
						verified: true,
						verifiedAt: "2026-03-19T17:00:00.000Z",
						createdAt: "2026-03-19T17:00:00.000Z",
						apiKeyId: "api-key-id",
					},
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}

		if (url.endsWith("/v1/queue/join")) {
			return new Response(
				JSON.stringify({
					status: "ready",
					matchId: "match-house-1",
					opponentId: "tester-9",
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}

		throw new Error(`Unhandled fetch: ${url}`);
	}) as typeof fetch;

	try {
		const result = await runHouseOpponent({
			baseUrl: "https://example.com",
			name: "HouseOpponent",
			adminKey: "admin-key",
			runnerKey: "runner-key",
			runnerId: "runner-1",
			runMatchImpl: async (_client, options) => {
				assert.ok(options.session);
				const started = await options.session.start();
				assert.equal(started.matchId, "match-house-1");
				assert.equal(started.opponentId, "tester-9");
				return {
					matchId: "match-house-1",
					transport: "sse",
					reason: "match_ended",
					winnerAgentId: "house-123",
					loserAgentId: "tester-9",
				};
			},
		});

		assert.equal(result.agentId, "house-123");
		assert.equal(result.matchId, "match-house-1");
		assert.equal(result.terminalReason, "match_ended");
		assert.equal(result.selection.source.kind, "preset");
		assert.equal(
			calls.filter((url) => url.endsWith("/v1/auth/register")).length,
			1,
		);
		assert.equal(
			calls.filter((url) => url.endsWith("/v1/auth/verify")).length,
			1,
		);
		assert.equal(
			calls.filter((url) => url.endsWith("/v1/internal/runners/agents/bind"))
				.length,
			1,
		);
		assert.equal(
			calls.filter((url) => url.endsWith("/v1/agents/me/strategy/hex_conquest"))
				.length,
			1,
		);
		assert.equal(calls.filter((url) => url.endsWith("/v1/auth/me")).length, 1);
		assert.equal(
			calls.filter((url) => url.endsWith("/v1/queue/join")).length,
			1,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
