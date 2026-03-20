import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createInitialState, listLegalMoves } from "@fightclaw/engine";
import {
	loadKaiGatewayFixtures,
	materializeKaiGatewayFixtureInput,
	runKaiGatewayFixtureProbe,
} from "../scripts/kai-gateway-probe";
import { probeKaiGatewayOutcome } from "../src/kaiGatewayProbe";

const players = ["P1", "P2"] as const;

const buildInput = () => {
	const state = createInitialState(0, undefined, [...players]);
	return {
		agentId: "agent-1",
		agentName: "Kai",
		matchId: "match-1",
		stateVersion: state.stateVersion,
		state,
	};
};

describe("kaiGatewayProbe", () => {
	test("classifies parse failure", async () => {
		const report = await probeKaiGatewayOutcome(buildInput(), async () => ({
			rawGatewayOutput:
				'{"result":{"payloads":[{"text":"not valid json reply"}]}}',
		}));

		assert.equal(report.failureClass, "parse_failure");
		assert.equal(report.parseOutcome, "unparseable_text_reply");
		assert.equal(report.chosenMove, null);
		assert.notEqual(report.fallbackMove, null);
		assert.notEqual(report.fallbackMove?.action, "end_turn");
		assert.equal(report.latencyMs >= 0, true);
	});

	test("classifies invalid move selection", async () => {
		const report = await probeKaiGatewayOutcome(buildInput(), async () => ({
			rawGatewayOutput:
				'{"result":{"payloads":[{"text":"{\\"move\\":{\\"action\\":\\"move\\",\\"unitId\\":\\"nope\\",\\"to\\":\\"B5\\"},\\"publicThought\\":\\"oops\\"}"}]}}',
		}));

		assert.equal(report.failureClass, "invalid_move_selection");
		assert.equal(report.parseOutcome, "parsed_json");
		assert.equal(report.chosenMove, null);
		assert.notEqual(report.fallbackMove, null);
		assert.equal(report.latencyMs >= 0, true);
	});

	test("classifies provider invocation failure", async () => {
		const report = await probeKaiGatewayOutcome(buildInput(), async () => {
			throw new Error("provider offline");
		});

		assert.equal(report.failureClass, "provider_invocation_failure");
		assert.equal(report.parseOutcome, "provider_error");
		assert.equal(report.chosenMove, null);
		assert.notEqual(report.fallbackMove, null);
		assert.equal(report.latencyMs >= 0, true);
	});

	test("classifies successful legal move emission", async () => {
		const state = createInitialState(0, undefined, [...players]);
		const legalMove = listLegalMoves(state).find(
			(move) => move.action !== "end_turn",
		);
		assert.notEqual(legalMove, undefined);
		if (!legalMove) return;
		const textPayload = JSON.stringify({
			move: legalMove,
			publicThought: "advancing",
		});

		const report = await probeKaiGatewayOutcome(
			{
				agentId: "agent-1",
				agentName: "Kai",
				matchId: "match-1",
				stateVersion: state.stateVersion,
				state,
			},
			async () => ({
				rawGatewayOutput: JSON.stringify({
					result: {
						payloads: [{ text: textPayload }],
					},
				}),
			}),
		);

		assert.equal(report.failureClass, "none");
		assert.equal(report.parseOutcome, "parsed_json");
		assert.deepEqual(report.chosenMove, legalMove);
		assert.equal(report.fallbackMove, null);
		assert.equal(report.publicThought, "advancing");
		assert.equal(report.latencyMs >= 0, true);
	});

	test("loads curated fixture inputs and produces well-formed reports", async () => {
		const fixtures = await loadKaiGatewayFixtures();
		assert.deepEqual(
			fixtures.map((fixture) => fixture.name),
			["opening", "follow-up", "attack-pressure"],
		);

		for (const fixture of fixtures) {
			const input = materializeKaiGatewayFixtureInput(fixture);
			const legalMoves = listLegalMoves(input.state);
			assert.equal(legalMoves.length > 0, true);
			if (fixture.name === "attack-pressure") {
				assert.equal(
					legalMoves.some((move) => move.action === "attack"),
					true,
				);
			}

			const move =
				legalMoves.find((candidate) => candidate.action !== "end_turn") ??
				legalMoves[0];
			assert.notEqual(move, undefined);
			if (!move) continue;

			const probe = await runKaiGatewayFixtureProbe(fixture, async () => ({
				rawGatewayOutput: JSON.stringify({
					result: {
						payloads: [
							{
								text: JSON.stringify({
									move,
									publicThought: `fixture:${fixture.name}`,
								}),
							},
						],
					},
				}),
			}));
			const report = probe.report;

			assert.equal(probe.fixture, fixture.name);
			assert.equal(probe.legalMoveCount, legalMoves.length);
			assert.equal(report.failureClass, "none");
			assert.equal(report.parseOutcome, "parsed_json");
			assert.deepEqual(report.chosenMove, move);
			assert.equal(report.fallbackMove, null);
			assert.equal(report.publicThought, `fixture:${fixture.name}`);
			assert.equal(report.latencyMs >= 0, true);
		}
	});

	test("reports provider failures through the fixture probe wrapper", async () => {
		const [opening] = await loadKaiGatewayFixtures();
		assert.notEqual(opening, undefined);
		if (!opening) return;

		const probe = await runKaiGatewayFixtureProbe(opening, async () => {
			throw new Error("provider offline");
		});

		assert.equal(probe.fixture, "opening");
		assert.equal(probe.legalMoveCount > 0, true);
		assert.equal(probe.attackAvailable, false);
		assert.equal(probe.report.failureClass, "provider_invocation_failure");
		assert.equal(probe.report.parseOutcome, "provider_error");
		assert.equal(probe.report.move, probe.report.fallbackMove);
		assert.notEqual(probe.report.fallbackMove, null);
		assert.equal(probe.report.latencyMs >= 0, true);
	});
});
