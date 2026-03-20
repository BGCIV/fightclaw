import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyMove,
	createInitialState,
	listLegalMoves,
	type Move,
} from "@fightclaw/engine";
import {
	createBetaMoveProvider,
	formatBetaProgressEvent,
	resolveBetaStrategySelection,
	resolveHouseOpponentCommandOptions,
	runTesterBetaJourney,
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

test("defaults the house opponent flow to the safe_fallback_beta preset", () => {
	const resolved = resolveHouseOpponentCommandOptions({
		baseUrl: "https://example.com",
		adminKey: "admin-key",
		runnerKey: "runner-key",
		runnerId: "runner-1",
	});

	assert.equal(resolved.selection.source.kind, "preset");
	if (resolved.selection.source.kind !== "preset") {
		throw new Error("Expected preset strategy selection.");
	}
	assert.equal(resolved.selection.source.presetId, "safe_fallback_beta");
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

test("tester beta journey prints the final match summary with URLs", async () => {
	const progress: string[] = [];
	const calls: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input, _init) => {
		const url = String(input);
		calls.push(url);

		if (url.endsWith("/v1/auth/register")) {
			return new Response(
				JSON.stringify({
					agent: {
						id: "agent-789",
						name: "BetaTester",
						verified: false,
					},
					apiKey: "agent-key-789",
					claimCode: "CODE-1234",
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}

		if (url.endsWith("/v1/auth/me")) {
			return new Response(
				JSON.stringify({
					agent: {
						id: "agent-789",
						name: "BetaTester",
						verified: true,
					},
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

		if (url.endsWith("/v1/internal/runners/agents/bind")) {
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}

		if (url.endsWith("/v1/queue/join")) {
			return new Response(
				JSON.stringify({
					status: "ready",
					matchId: "match-789",
					opponentId: "house-1",
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
		const result = await runTesterBetaJourney({
			baseUrl: "https://api.fightclaw.com",
			name: "BetaTester",
			selection: resolveBetaStrategySelection({
				side: "A",
			}),
			adminKey: "admin-key",
			runnerKey: "runner-key",
			runnerId: "runner-1",
			gatewayCmd: "pnpm exec tsx scripts/gateway-move.ts",
			moveTimeoutMs: 4000,
			onProgress: (line) => progress.push(line),
			runMatchImpl: async (_client, options) => {
				assert.ok(options.session);
				const started = await options.session.start();
				assert.equal(started.matchId, "match-789");
				return {
					matchId: "match-789",
					transport: "sse",
					reason: "match_ended",
					winnerAgentId: "agent-789",
					loserAgentId: "house-1",
				};
			},
		});

		assert.equal(result.agentId, "agent-789");
		assert.equal(result.matchId, "match-789");
		assert.equal(result.homepageUrl, "https://fightclaw.com/");
		assert.equal(
			result.matchUrl,
			"https://fightclaw.com/?replayMatchId=match-789",
		);
		assert.equal(result.finalStatus, "match_ended");
		assert.deepEqual(progress, [
			"registered",
			"agentId: agent-789",
			"claimCode: CODE-1234",
			"waiting for operator verification",
			"verified",
			"publishing preset",
			"joining queue",
			"matched",
			"matchId: match-789",
			"match URL: https://fightclaw.com/?replayMatchId=match-789",
			"homepage URL: https://fightclaw.com/",
			"final status: match_ended",
		]);
		assert.equal(
			calls.filter((url) => url.endsWith("/v1/internal/runners/agents/bind"))
				.length,
			1,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("beta move provider caps a player-turn at three actions before forcing end_turn", async () => {
	let game = createInitialState(7, undefined, ["agent-a", "agent-b"]);
	let stateVersion = 1;

	const provider = createBetaMoveProvider(
		{
			getMatchState: async () => ({
				state: {
					stateVersion,
					status: "active",
					game,
				},
			}),
		} as never,
		"agent-a",
		"Kai",
		"gateway-cmd",
		{
			maxActionsPerTurn: 3,
			invokeGatewayImpl: async () => {
				const nextMove =
					listLegalMoves(game).find(
						(move) => move.action !== "end_turn" && move.action !== "pass",
					) ?? ({ action: "end_turn" } as Move);
				return {
					move: nextMove,
					publicThought: `step ${stateVersion}`,
				};
			},
		},
	);

	const observed: Move[] = [];
	for (let index = 0; index < 4; index++) {
		const move = await provider.nextMove({
			agentId: "agent-a",
			matchId: "match-1",
			stateVersion,
		});
		observed.push(move);

		if (move.action === "end_turn" || move.action === "pass") {
			continue;
		}

		const applied = applyMove(game, move);
		assert.equal(applied.ok, true);
		if (!applied.ok) {
			throw new Error("Expected beta provider move to stay legal.");
		}
		game = applied.state;
		stateVersion += 1;
	}

	assert.equal(observed.length, 4);
	assert.notEqual(observed[0]?.action, "end_turn");
	assert.notEqual(observed[1]?.action, "end_turn");
	assert.notEqual(observed[2]?.action, "end_turn");
	assert.equal(observed[3]?.action, "end_turn");
	assert.match(observed[3]?.reasoning ?? "", /bounded action budget/i);
});

test("beta move provider ends the turn safely after a mid-turn gateway failure", async () => {
	let game = createInitialState(11, undefined, ["agent-a", "agent-b"]);
	let stateVersion = 1;
	let gatewayCalls = 0;

	const provider = createBetaMoveProvider(
		{
			getMatchState: async () => ({
				state: {
					stateVersion,
					status: "active",
					game,
				},
			}),
		} as never,
		"agent-a",
		"Kai",
		"gateway-cmd",
		{
			maxActionsPerTurn: 3,
			invokeGatewayImpl: async () => {
				gatewayCalls += 1;
				if (gatewayCalls === 2) {
					throw new Error("gateway failed");
				}
				const nextMove =
					listLegalMoves(game).find(
						(move) => move.action !== "end_turn" && move.action !== "pass",
					) ?? ({ action: "end_turn" } as Move);
				return {
					move: nextMove,
					publicThought: "Continuing pressure.",
				};
			},
		},
	);

	const firstMove = await provider.nextMove({
		agentId: "agent-a",
		matchId: "match-2",
		stateVersion,
	});
	assert.notEqual(firstMove.action, "end_turn");
	const applied = applyMove(game, firstMove);
	assert.equal(applied.ok, true);
	if (!applied.ok) {
		throw new Error("Expected first beta move to stay legal.");
	}
	game = applied.state;
	stateVersion += 1;

	const secondMove = await provider.nextMove({
		agentId: "agent-a",
		matchId: "match-2",
		stateVersion,
	});
	assert.equal(secondMove.action, "end_turn");
	assert.match(
		secondMove.reasoning ?? "",
		/closing turn after provider failure/i,
	);
});
