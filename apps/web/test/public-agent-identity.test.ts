import { describe, expect, test } from "bun:test";

import {
	buildParticipantIdentityRequest,
	buildPublicAgentIdentityMap,
	resolveBroadcastIdentity,
} from "../src/lib/public-agent-identity";

describe("public agent identity helper", () => {
	test("builds a stable participant identity request from agent ids", () => {
		expect(
			buildParticipantIdentityRequest({
				agentAId: "agent-a",
				agentBId: "agent-b",
			}),
		).toEqual({
			agentIds: ["agent-a", "agent-b"],
			identityKey: "agent-a|agent-b",
		});
	});

	test("returns an empty request when either participant id is missing", () => {
		expect(
			buildParticipantIdentityRequest({
				agentAId: "agent-a",
				agentBId: null,
			}),
		).toEqual({
			agentIds: [],
			identityKey: "",
		});
	});

	test("uses fetched public identity and falls back to live style when identity style is missing", () => {
		const publicIdentityById = buildPublicAgentIdentityMap([
			{
				agentId: "agent-a",
				agentName: "Kai",
				publicPersona:
					"Terrain-first opportunist who wins by pressure and income.",
				styleTag: null,
			},
		]);

		expect(
			resolveBroadcastIdentity({
				agentId: "agent-a",
				fallbackName: "Fallback Kai",
				fallbackStyleTag: "Pressing",
				publicIdentityById,
			}),
		).toEqual({
			name: "Kai",
			publicPersona:
				"Terrain-first opportunist who wins by pressure and income.",
			styleTag: "Pressing",
		});
	});

	test("falls back cleanly when no public identity exists", () => {
		expect(
			resolveBroadcastIdentity({
				agentId: "missing-agent",
				fallbackName: "Fallback Smith",
				fallbackStyleTag: "Balanced",
				publicIdentityById: {},
			}),
		).toEqual({
			name: "Fallback Smith",
			publicPersona: null,
			styleTag: "Balanced",
		});
	});
});
