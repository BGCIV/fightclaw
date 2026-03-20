import { describe, expect, test } from "bun:test";

import {
	buildDevSpectatorLabModel,
	DEV_LAB_LAYOUT_PRESETS,
	DEV_LAB_SCENARIOS,
} from "../src/lib/dev-spectator-lab";

describe("dev spectator lab model", () => {
	test("exposes the core layout presets and scenarios", () => {
		expect(DEV_LAB_LAYOUT_PRESETS.map((preset) => preset.id)).toEqual([
			"desktop",
			"laptop",
			"portrait",
			"ultrawide",
		]);
		expect(DEV_LAB_SCENARIOS.map((scenario) => scenario.id)).toEqual([
			"live-board",
			"action-burst",
			"ticker-stress",
			"replay-snapshot",
			"terminal-board",
		]);
	});

	test("builds a long-content stress model with board-shrink diagnostics", () => {
		const model = buildDevSpectatorLabModel({
			layoutPreset: "portrait",
			scenarioId: "ticker-stress",
			tickerCount: 12,
			longNames: true,
			longPersona: true,
			longCommentary: true,
			resultBandVisible: true,
			seed: 7,
		});

		expect(model.layout.preset.id).toBe("portrait");
		expect(model.featuredDesk.status).toBe("live");
		expect(model.board.columns).toBe(17);
		expect(model.tickerItems).toHaveLength(12);
		expect(model.tickerItems[0]?.text).toContain("Action");
		expect(model.agentCards.A.name.length).toBeGreaterThan(12);
		expect(model.agentCards.A.publicPersona?.length ?? 0).toBeGreaterThan(80);
		expect(model.agentCards.A.publicCommentary.length).toBeGreaterThan(80);
		expect(model.resultSummary?.headline).toBe("A wins");
		expect(model.diagnostics.boardShrinkRisk).toBe(true);
		expect(model.diagnostics.overflowRisk).toBe(true);
		expect(model.diagnostics.resultBandVisible).toBe(true);
	});

	test("builds a stable replay-ready snapshot", () => {
		const model = buildDevSpectatorLabModel({
			layoutPreset: "desktop",
			scenarioId: "replay-snapshot",
			seed: 42,
		});

		expect(model.scenario.id).toBe("replay-snapshot");
		expect(model.layout.width).toBeGreaterThan(model.layout.height);
		expect(model.featuredDesk.status).toBe("replay");
		expect(model.board.isFrozen).toBe(true);
		expect(model.tickerItems).toHaveLength(4);
		expect(model.diagnostics.boardShrinkRisk).toBe(false);
		expect(model.agentCards.B.agentId).toBe("dev-b");
	});

	test("gives action-burst its own default feed pressure", () => {
		const model = buildDevSpectatorLabModel({
			scenarioId: "action-burst",
		});

		expect(model.scenario.id).toBe("action-burst");
		expect(model.tickerItems).toHaveLength(10);
		expect(model.resultSummary).toBeNull();
	});
});
