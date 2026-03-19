import { describe, expect, test } from "bun:test";
import {
	getHexConquestBaselinePreset,
	listHexConquestBaselinePresets,
	resolveHexConquestBaselineCliBotConfig,
	resolveHexConquestBaselineSimConfig,
} from "../src/presets/hexConquestBaselines";

describe("hexConquest baseline presets", () => {
	test("exports a small fixed baseline set", () => {
		const presets = listHexConquestBaselinePresets();
		expect(presets).toHaveLength(5);
		expect(presets.map((preset) => preset.id)).toEqual([
			"balanced_beta",
			"aggressive_beta",
			"defensive_beta",
			"objective_beta",
			"safe_fallback_beta",
		]);

		for (const preset of presets) {
			expect(preset.gameType).toBe("hex_conquest");
			expect(preset.displayName.length).toBeGreaterThan(0);
			expect(preset.privateStrategy.length).toBeGreaterThan(0);
			expect(
				typeof preset.publicPersona === "string" ||
					preset.publicPersona === null,
			).toBe(true);
		}
	});

	test("resolves preset lookup and sim config", () => {
		const preset = getHexConquestBaselinePreset("balanced_beta");
		expect(preset?.id).toBe("balanced_beta");
		expect(preset?.sim.botType).toBe("mockllm");

		const simConfig = resolveHexConquestBaselineSimConfig("objective_beta");
		expect(simConfig).toEqual({
			botType: "mockllm",
			strategy: "greedy_macro",
			prompt:
				"Pressure objectives, keep income flowing, and convert resource edge into stronghold pressure.",
		});
	});

	test("returns null for unknown presets", () => {
		expect(getHexConquestBaselinePreset("unknown_beta")).toBeNull();
		expect(resolveHexConquestBaselineSimConfig("unknown_beta")).toBeNull();
	});

	test("explicit cli values override preset-derived sim config", () => {
		expect(
			resolveHexConquestBaselineCliBotConfig({
				presetId: "balanced_beta",
				explicitBotType: "llm",
				explicitPrompt: "Manual override prompt",
				explicitStrategy: "defensive",
				fallbackBotType: "greedy",
			}),
		).toEqual({
			botType: "llm",
			prompt: "Manual override prompt",
			strategy: "defensive",
		});

		expect(
			resolveHexConquestBaselineCliBotConfig({
				presetId: "objective_beta",
				fallbackBotType: "greedy",
			}),
		).toEqual({
			botType: "mockllm",
			strategy: "greedy_macro",
			prompt:
				"Pressure objectives, keep income flowing, and convert resource edge into stronghold pressure.",
		});

		expect(() =>
			resolveHexConquestBaselineCliBotConfig({
				presetId: "unknown_beta",
				fallbackBotType: "greedy",
			}),
		).toThrow("Unknown hex_conquest baseline preset");
	});
});
