import assert from "node:assert/strict";
import { test } from "node:test";
import {
	formatBetaProgressEvent,
	resolveBetaStrategySelection,
	runTesterBetaOnboarding,
	shouldUseLocalOperatorVerify,
} from "../src/beta";

test("formats tester beta progress events in the expected human-readable phases", () => {
	assert.equal(formatBetaProgressEvent({ phase: "registered" }), "registered");
	assert.equal(
		formatBetaProgressEvent({
			phase: "agent_id",
			agentId: "agent-123",
		}),
		"agentId: agent-123",
	);
	assert.equal(
		formatBetaProgressEvent({
			phase: "claim_code",
			claimCode: "ABCD-EFGH",
		}),
		"claimCode: ABCD-EFGH",
	);
	assert.equal(
		formatBetaProgressEvent({ phase: "waiting_for_operator_verification" }),
		"waiting for operator verification",
	);
	assert.equal(formatBetaProgressEvent({ phase: "verified" }), "verified");
	assert.equal(
		formatBetaProgressEvent({ phase: "publishing_preset" }),
		"publishing preset",
	);
	assert.equal(
		formatBetaProgressEvent({ phase: "joining_queue" }),
		"joining queue",
	);
});

test("defaults the tester beta flow to the objective_beta preset", () => {
	const selection = resolveBetaStrategySelection({
		side: "A",
	});

	assert.equal(selection.source.kind, "preset");
	if (selection.source.kind !== "preset") {
		throw new Error("Expected preset strategy selection.");
	}
	assert.equal(selection.source.presetId, "objective_beta");
	assert.equal(
		selection.publicPersona,
		"Terrain-first opportunist who wins by pressure and income.",
	);
	assert.match(
		selection.privateStrategy,
		/Contest crowns and income nodes early/,
	);
});

test("allows explicit inline or preset overrides for the beta flow", () => {
	const inlineSelection = resolveBetaStrategySelection({
		side: "A",
		rawStrategy: "Play the long economy game.",
	});
	assert.equal(inlineSelection.source.kind, "inline");
	assert.equal(inlineSelection.privateStrategy, "Play the long economy game.");

	const presetSelection = resolveBetaStrategySelection({
		side: "A",
		presetName: "objective_beta",
	});
	assert.equal(presetSelection.source.kind, "preset");
});

test("rejects ambiguous strategy inputs in the beta flow", () => {
	assert.throws(
		() =>
			resolveBetaStrategySelection({
				side: "A",
				rawStrategy: "Play safely.",
				presetName: "objective_beta",
			}),
		/Exactly one of --strategy or --strategyPreset may be provided/,
	);
});

test("only uses local operator verification when explicitly requested", () => {
	assert.equal(
		shouldUseLocalOperatorVerify({
			localOperatorVerify: false,
		}),
		false,
	);
	assert.equal(
		shouldUseLocalOperatorVerify({
			localOperatorVerify: true,
		}),
		true,
	);
	assert.equal(
		shouldUseLocalOperatorVerify({
			adminKey: "admin-key",
		}),
		false,
	);
});

test("tester beta onboarding verifies, publishes the preset, and joins queue", async () => {
	const calls: Array<{
		url: string;
		method: string;
		headers: HeadersInit;
		body: string;
	}> = [];
	const progress: string[] = [];

	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input, _init) => {
		calls.push({
			url: String(input),
			method: _init?.method ?? "GET",
			headers: _init?.headers ?? {},
			body: String(_init?.body ?? ""),
		});

		const url = String(input);
		if (url.endsWith("/v1/auth/register")) {
			return new Response(
				JSON.stringify({
					agent: {
						id: "agent-123",
						name: "BetaTester",
						verified: false,
					},
					apiKey: "agent-key",
					claimCode: "ABCD-EFGH",
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}

		if (url.endsWith("/v1/auth/verify")) {
			return new Response(
				JSON.stringify({
					agentId: "agent-123",
					verifiedAt: "2026-03-19T16:00:00.000Z",
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}

		if (url.endsWith("/v1/agents/me/strategy/hex_conquest")) {
			return new Response(JSON.stringify({ created: { version: 1 } }), {
				status: 201,
				headers: { "content-type": "application/json" },
			});
		}

		if (url.endsWith("/v1/queue/join")) {
			return new Response(
				JSON.stringify({
					status: "waiting",
					matchId: "match-123",
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
		const result = await runTesterBetaOnboarding({
			baseUrl: "https://example.com",
			name: "BetaTester",
			selection: resolveBetaStrategySelection({
				side: "A",
			}),
			adminKey: "admin-key",
			localOperatorVerify: true,
			onProgress: (line) => progress.push(line),
		});

		assert.equal(result.agentId, "agent-123");
		assert.equal(result.claimCode, "ABCD-EFGH");
		assert.equal(result.queuedMatchId, "match-123");
		assert.equal(result.queueStatus, "waiting");
		assert.deepEqual(progress, [
			"registered",
			"agentId: agent-123",
			"claimCode: ABCD-EFGH",
			"waiting for operator verification",
			"verified",
			"publishing preset",
			"joining queue",
		]);
		assert.equal(
			calls.map((call) => call.url).at(-1),
			"https://example.com/v1/queue/join",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("tester beta onboarding polls for manual verification before publish and queue join", async () => {
	const calls: Array<string> = [];
	let meCalls = 0;

	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input, _init) => {
		const url = String(input);
		calls.push(url);

		if (url.endsWith("/v1/auth/register")) {
			return new Response(
				JSON.stringify({
					agent: {
						id: "agent-456",
						name: "ManualTester",
						verified: false,
					},
					apiKey: "agent-key-2",
					claimCode: "WXYZ-1234",
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}

		if (url.endsWith("/v1/auth/me")) {
			meCalls += 1;
			return new Response(
				JSON.stringify({
					agent: {
						id: "agent-456",
						name: "ManualTester",
						verified: meCalls >= 2,
					},
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}

		if (url.endsWith("/v1/agents/me/strategy/hex_conquest")) {
			assert.equal(meCalls >= 2, true);
			return new Response(JSON.stringify({ created: { version: 1 } }), {
				status: 201,
				headers: { "content-type": "application/json" },
			});
		}

		if (url.endsWith("/v1/queue/join")) {
			assert.equal(meCalls >= 2, true);
			return new Response(
				JSON.stringify({
					status: "waiting",
					matchId: "match-manual",
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
		const result = await runTesterBetaOnboarding({
			baseUrl: "https://example.com",
			name: "ManualTester",
			selection: resolveBetaStrategySelection({
				side: "A",
			}),
			verifyPollMs: 0,
			onProgress: () => {},
		});

		assert.equal(result.agentId, "agent-456");
		assert.equal(result.queuedMatchId, "match-manual");
		assert.equal(meCalls, 2);
		assert.equal(calls.includes("https://example.com/v1/auth/verify"), false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
