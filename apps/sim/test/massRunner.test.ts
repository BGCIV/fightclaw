import { describe, expect, test } from "bun:test";
import { makeMockLlmBot } from "../src/bots/mockLlmBot";
import { resolveHexConquestBaselineSimConfig } from "../src/presets/hexConquestBaselines";
import { serializeBotConfig } from "../src/runner/massRunner";

describe("mass runner bot serialization", () => {
	test("preserves preset-backed mock LLM strategy and prompt for forked workers", () => {
		const simConfig = resolveHexConquestBaselineSimConfig("objective_beta");
		if (!simConfig) {
			throw new Error("Expected objective_beta preset config.");
		}

		const bot = makeMockLlmBot("P1", {
			strategy: simConfig.strategy,
			inline: simConfig.prompt,
		});
		const serialized = serializeBotConfig(bot);

		expect(serialized.type).toBe("mockllm");
		expect(serialized.llmConfig?.strategy).toBe("greedy_macro");
		expect(serialized.llmConfig?.inline).toContain("Pressure objectives");
	});

	test("preserves canonical id and name over serialized config overrides", () => {
		const bot = {
			id: "canonical-id",
			name: "Canonical Name",
			serializedConfig: {
				id: "wrong-id",
				name: "Wrong Name",
				type: "random" as const,
			},
		};

		const serialized = serializeBotConfig(
			bot as Parameters<typeof serializeBotConfig>[0],
		);

		expect(serialized.id).toBe("canonical-id");
		expect(serialized.name).toBe("Canonical Name");
		expect(serialized.type).toBe("random");
	});
});
