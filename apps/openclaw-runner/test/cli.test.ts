import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createInitialState,
	listLegalMoves,
	type Move,
} from "@fightclaw/engine";
import { createMoveProvider, runExistingDuel } from "../src/cli";

const createTestClient = () => {
	const game = createInitialState(1, undefined, ["agent-a", "agent-b"]);
	return {
		getMatchState: async () => ({
			state: {
				game,
			},
		}),
	} as never;
};

const createStateResponse = (args?: {
	game?: ReturnType<typeof createInitialState>;
	turnExpiresAtMs?: number;
}) => ({
	state: {
		game:
			args?.game ?? createInitialState(1, undefined, ["agent-a", "agent-b"]),
	},
	...(typeof args?.turnExpiresAtMs === "number"
		? { turnExpiresAtMs: args.turnExpiresAtMs }
		: {}),
});

const createTestContextStore = () =>
	({
		buildTurnContext: async () => undefined,
	}) as never;

test("cli move provider falls back when the gateway returns an illegal move", async () => {
	const provider = createMoveProvider(
		createTestClient(),
		"agent-a",
		"Agent A",
		"Finish strong.",
		createTestContextStore(),
		"fake-gateway",
		{
			invokeGatewayImpl: async () => ({
				move: { action: "attack", unitId: "A-1", target: "Z99" } as Move,
				publicThought: "Illegal attack.",
			}),
		},
	);

	const move = await provider.nextMove({
		matchId: "match-1",
		stateVersion: 1,
	});

	assert.notEqual(move.action, "pass");
	assert.notEqual(move.action, "end_turn");
	assert.equal(
		move.reasoning,
		"Public-safe fallback: selected a clearly legal move.",
	);
});

test("cli move provider counts a fallback action before honoring a later end_turn", async () => {
	let callCount = 0;
	const provider = createMoveProvider(
		createTestClient(),
		"agent-a",
		"Agent A",
		"Finish strong.",
		createTestContextStore(),
		"fake-gateway",
		{
			invokeGatewayImpl: async () => {
				callCount += 1;
				if (callCount === 1) {
					throw new Error("Gateway timeout");
				}
				return {
					move: { action: "end_turn" },
					publicThought: "Closing turn.",
				};
			},
		},
	);

	const firstMove = await provider.nextMove({
		matchId: "match-1",
		stateVersion: 1,
	});
	const secondMove = await provider.nextMove({
		matchId: "match-1",
		stateVersion: 2,
	});

	assert.notEqual(firstMove.action, "end_turn");
	assert.equal(secondMove.action, "end_turn");
	assert.equal(secondMove.reasoning, "Closing turn.");
});

test("cli move provider sharply reduces the follow-up gateway budget when the live turn budget is low", async () => {
	const game = createInitialState(1, undefined, ["agent-a", "agent-b"]);
	const legalMoves = listLegalMoves(game);
	const openingMove = legalMoves.find((move) => move.action === "move");
	assert.ok(openingMove);
	let callCount = 0;
	const client = {
		getMatchState: async () => {
			callCount += 1;
			if (callCount === 1) {
				return createStateResponse({
					game,
					turnExpiresAtMs: Date.now() + 60_000,
				});
			}
			return createStateResponse({
				game,
				turnExpiresAtMs: Date.now() + 20_000,
			});
		},
	} as never;
	const observedTimeouts: number[] = [];
	const provider = createMoveProvider(
		client,
		"agent-a",
		"Agent A",
		"Finish strong.",
		createTestContextStore(),
		"fake-gateway",
		{
			gatewayTimeoutMs: 44_750,
			invokeGatewayImpl: async (_command, _input, timeoutMs) => {
				observedTimeouts.push(timeoutMs);
				if (observedTimeouts.length === 1) {
					return {
						move: openingMove,
						publicThought: "Gateway move.",
					};
				}
				throw new Error("late follow-up timeout");
			},
		},
	);

	const firstMove = await provider.nextMove({
		matchId: "match-1",
		stateVersion: 1,
	});
	const secondMove = await provider.nextMove({
		matchId: "match-1",
		stateVersion: 2,
	});

	assert.equal(firstMove.action, openingMove.action);
	assert.deepEqual(observedTimeouts, [44_750, 5_000]);
	assert.notEqual(secondMove.action, "end_turn");
	assert.notEqual(secondMove.action, "pass");
	assert.equal(
		secondMove.reasoning,
		"Public-safe fallback: selected a clearly legal move.",
	);
});

test("cli move provider falls back locally when no safe gateway budget remains", async () => {
	const game = createInitialState(1, undefined, ["agent-a", "agent-b"]);
	const legalMoves = listLegalMoves(game);
	const openingMove = legalMoves.find((move) => move.action === "move");
	assert.ok(openingMove);
	let callCount = 0;
	const client = {
		getMatchState: async () => {
			callCount += 1;
			if (callCount === 1) {
				return createStateResponse({
					game,
					turnExpiresAtMs: Date.now() + 60_000,
				});
			}
			return createStateResponse({
				game,
				turnExpiresAtMs: Date.now() + 2_000,
			});
		},
	} as never;
	let gatewayCalls = 0;
	const provider = createMoveProvider(
		client,
		"agent-a",
		"Agent A",
		"Finish strong.",
		createTestContextStore(),
		"fake-gateway",
		{
			gatewayTimeoutMs: 44_750,
			invokeGatewayImpl: async () => {
				gatewayCalls += 1;
				return {
					move: openingMove,
					publicThought: "Gateway move.",
				};
			},
		},
	);

	const firstMove = await provider.nextMove({
		matchId: "match-1",
		stateVersion: 1,
	});
	const secondMove = await provider.nextMove({
		matchId: "match-1",
		stateVersion: 2,
	});

	assert.equal(firstMove.action, openingMove.action);
	assert.equal(gatewayCalls, 1);
	assert.notEqual(secondMove.action, "end_turn");
	assert.notEqual(secondMove.action, "pass");
	assert.equal(
		secondMove.reasoning,
		"Public-safe fallback: selected a clearly legal move.",
	);
});

test("existing-agent duel uses API keys without fresh registration", async () => {
	const calls: string[] = [];
	const observedReasonings: string[] = [];
	const initialGame = createInitialState(7, undefined, ["agent-a", "agent-b"]);
	const legalMove = listLegalMoves(initialGame)[0];
	assert.ok(legalMove);
	const gatewayScript = [
		"let input = '';",
		"process.stdin.on('data', (chunk) => { input += chunk; });",
		"process.stdin.on('end', () => {",
		"  const parsed = JSON.parse(input);",
		`  const move = ${JSON.stringify(legalMove)};`,
		"  process.stdout.write(JSON.stringify({ move, publicThought: parsed.strategyPrompt }));",
		"});",
	].join(" ");
	const gatewayCmd = `${process.execPath} -e ${JSON.stringify(gatewayScript)}`;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		calls.push(url);
		const headers = new Headers(init?.headers);
		const auth = headers.get("authorization");

		if (url.endsWith("/v1/auth/me")) {
			if (auth === "Bearer key-a") {
				return new Response(
					JSON.stringify({
						agent: {
							id: "agent-a",
							name: "Kai",
							verified: true,
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (auth === "Bearer key-b") {
				return new Response(
					JSON.stringify({
						agent: {
							id: "agent-b",
							name: "MrSmith",
							verified: true,
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
		}

		if (url.endsWith("/v1/internal/runners/agents/bind")) {
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}

		if (url.endsWith("/v1/agents/me/strategy/hex_conquest")) {
			if (auth === "Bearer key-a") {
				return new Response(
					JSON.stringify({
						active: {
							privateStrategy: "Kai active strategy",
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (auth === "Bearer key-b") {
				return new Response(
					JSON.stringify({
						active: {
							privateStrategy: "MrSmith active strategy",
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
		}

		if (url.endsWith("/v1/queue/join")) {
			const matchId = "match-existing-1";
			const opponentId = auth === "Bearer key-a" ? "agent-b" : "agent-a";
			return new Response(
				JSON.stringify({
					status: "ready",
					matchId,
					opponentId,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}

		if (url.endsWith("/v1/matches/match-existing-1/state")) {
			return new Response(
				JSON.stringify({
					state: {
						stateVersion: 1,
						status: "active",
						game: initialGame,
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}

		throw new Error(`Unhandled fetch: ${url}`);
	}) as typeof fetch;

	try {
		const result = await runExistingDuel({
			baseUrl: "https://example.com",
			adminKey: "admin-key",
			runnerKey: "runner-key",
			runnerId: "runner-1",
			apiKeyA: "key-a",
			apiKeyB: "key-b",
			gatewayCmdA: gatewayCmd,
			gatewayCmdB: gatewayCmd,
			runMatchImpl: async (_client, options) => {
				assert.ok(options.session);
				const move = await options.moveProvider.nextMove({
					matchId: "match-existing-1",
					stateVersion: 1,
				});
				observedReasonings.push(String(move.reasoning ?? ""));
				return {
					matchId: "match-existing-1",
					transport: "sse",
					reason: "match_ended",
					winnerAgentId: "agent-a",
					loserAgentId: "agent-b",
				};
			},
		});

		assert.equal(result.matchId, "match-existing-1");
		assert.deepEqual(result.agents, [
			{ id: "agent-a", name: "Kai" },
			{ id: "agent-b", name: "MrSmith" },
		]);
		assert.equal(
			calls.filter((url) => url.endsWith("/v1/auth/register")).length,
			0,
		);
		assert.equal(
			calls.filter((url) => url.endsWith("/v1/internal/runners/agents/bind"))
				.length,
			2,
		);
		assert.equal(
			calls.filter((url) => url.endsWith("/v1/agents/me/strategy/hex_conquest"))
				.length,
			2,
		);
		assert.equal(
			calls.filter((url) => url.endsWith("/v1/queue/join")).length,
			2,
		);
		assert.deepEqual(
			[...observedReasonings].sort(),
			["Kai active strategy", "MrSmith active strategy"].sort(),
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("existing-agent duel does not bind runner ownership before active strategy validation succeeds", async () => {
	const calls: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		calls.push(url);
		const headers = new Headers(init?.headers);
		const auth = headers.get("authorization");

		if (url.endsWith("/v1/auth/me")) {
			if (auth === "Bearer key-a") {
				return new Response(
					JSON.stringify({
						agent: {
							id: "agent-a",
							name: "Kai",
							verified: true,
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (auth === "Bearer key-b") {
				return new Response(
					JSON.stringify({
						agent: {
							id: "agent-b",
							name: "MrSmith",
							verified: true,
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
		}

		if (url.endsWith("/v1/agents/me/strategy/hex_conquest")) {
			if (auth === "Bearer key-a") {
				return new Response(
					JSON.stringify({
						active: {
							privateStrategy: "Kai active strategy",
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (auth === "Bearer key-b") {
				return new Response(JSON.stringify({ active: {} }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
		}

		if (url.endsWith("/v1/internal/runners/agents/bind")) {
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}

		throw new Error(`Unhandled fetch: ${url}`);
	}) as typeof fetch;

	try {
		await assert.rejects(
			() =>
				runExistingDuel({
					baseUrl: "https://example.com",
					adminKey: "admin-key",
					runnerKey: "runner-key",
					runnerId: "runner-1",
					apiKeyA: "key-a",
					apiKeyB: "key-b",
				}),
			/Active strategy prompt is missing privateStrategy/,
		);
		assert.equal(
			calls.filter((url) => url.endsWith("/v1/internal/runners/agents/bind"))
				.length,
			0,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("existing-agent duel revokes the first runner binding if the second bind fails", async () => {
	const calls: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		calls.push(url);
		const headers = new Headers(init?.headers);
		const auth = headers.get("authorization");

		if (url.endsWith("/v1/auth/me")) {
			if (auth === "Bearer key-a") {
				return new Response(
					JSON.stringify({
						agent: {
							id: "agent-a",
							name: "Kai",
							verified: true,
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (auth === "Bearer key-b") {
				return new Response(
					JSON.stringify({
						agent: {
							id: "agent-b",
							name: "MrSmith",
							verified: true,
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
		}

		if (url.endsWith("/v1/agents/me/strategy/hex_conquest")) {
			return new Response(
				JSON.stringify({
					active: {
						privateStrategy:
							auth === "Bearer key-a" ? "Kai strategy" : "MrSmith strategy",
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}

		if (url.endsWith("/v1/internal/runners/agents/bind")) {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				agentId?: string;
			};
			if (body.agentId === "agent-a") {
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("bind failed", { status: 500 });
		}

		if (url.endsWith("/v1/internal/runners/agents/agent-a/revoke")) {
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}

		throw new Error(`Unhandled fetch: ${url}`);
	}) as typeof fetch;

	try {
		await assert.rejects(
			() =>
				runExistingDuel({
					baseUrl: "https://example.com",
					adminKey: "admin-key",
					runnerKey: "runner-key",
					runnerId: "runner-1",
					apiKeyA: "key-a",
					apiKeyB: "key-b",
				}),
			/Failed binding runner->agent/,
		);
		assert.equal(
			calls.filter((url) => url.endsWith("/v1/internal/runners/agents/bind"))
				.length,
			2,
		);
		assert.equal(
			calls.filter((url) =>
				url.endsWith("/v1/internal/runners/agents/agent-a/revoke"),
			).length,
			1,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("existing-agent duel revokes both bindings if post-bind validation fails", async () => {
	const calls: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		calls.push(url);
		const headers = new Headers(init?.headers);
		const auth = headers.get("authorization");

		if (url.endsWith("/v1/auth/me")) {
			if (auth === "Bearer key-a") {
				return new Response(
					JSON.stringify({
						agent: {
							id: "agent-a",
							name: "Kai",
							verified: true,
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (auth === "Bearer key-b") {
				return new Response(
					JSON.stringify({
						agent: {
							id: "agent-b",
							name: "MrSmith",
							verified: true,
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
		}

		if (url.endsWith("/v1/agents/me/strategy/hex_conquest")) {
			return new Response(
				JSON.stringify({
					active: {
						privateStrategy:
							auth === "Bearer key-a" ? "Kai strategy" : "MrSmith strategy",
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
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
					matchId: "match-existing-1",
					opponentId: auth === "Bearer key-a" ? "agent-b" : "agent-a",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}

		if (
			url.endsWith("/v1/internal/runners/agents/agent-a/revoke") ||
			url.endsWith("/v1/internal/runners/agents/agent-b/revoke")
		) {
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}

		throw new Error(`Unhandled fetch: ${url}`);
	}) as typeof fetch;

	try {
		await assert.rejects(
			() =>
				runExistingDuel({
					baseUrl: "https://example.com",
					adminKey: "admin-key",
					runnerKey: "runner-key",
					runnerId: "runner-1",
					apiKeyA: "key-a",
					apiKeyB: "key-b",
					runMatchImpl: async () => {
						throw new Error("post-bind failure");
					},
				}),
			/post-bind failure/,
		);
		assert.equal(
			calls.filter((url) => url.endsWith("/v1/internal/runners/agents/bind"))
				.length,
			2,
		);
		assert.equal(
			calls.filter((url) =>
				url.endsWith("/v1/internal/runners/agents/agent-a/revoke"),
			).length,
			1,
		);
		assert.equal(
			calls.filter((url) =>
				url.endsWith("/v1/internal/runners/agents/agent-b/revoke"),
			).length,
			1,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
