import { describe, expect, test } from "bun:test";

import { evaluateDevLayoutHealth } from "../src/lib/dev-layout-health";

describe("evaluateDevLayoutHealth", () => {
	test("reports clear when the board still owns most of the frame", () => {
		const result = evaluateDevLayoutHealth({
			frameHeightPx: 1000,
			boardHeightPx: 720,
			tickerHeightPx: 80,
			resultBandHeightPx: 0,
			viewportWidthPx: 1440,
			viewportHeightPx: 900,
		});

		expect(result.severity).toBe("clear");
		expect(result.summary).toContain("Clear");
		expect(result.shares.board).toBe(0.72);
		expect(result.shares.chrome).toBe(0.08);
		expect(result.percents.board).toBe(72);
		expect(result.viewport?.widthPx).toBe(1440);
	});

	test("reports watch when ticker and result chrome start compressing the board", () => {
		const result = evaluateDevLayoutHealth({
			frameHeightPx: 1000,
			boardHeightPx: 560,
			tickerHeightPx: 150,
			resultBandHeightPx: 70,
			viewportWidthPx: 900,
			viewportHeightPx: 1280,
		});

		expect(result.severity).toBe("watch");
		expect(result.summary).toContain("Watch");
		expect(result.summary).toContain("compress");
		expect(result.shares.board).toBe(0.56);
		expect(result.shares.chrome).toBe(0.22);
		expect(result.shares.remaining).toBe(0.22);
	});

	test("reports risk when feed pressure meaningfully compresses the board", () => {
		const result = evaluateDevLayoutHealth({
			frameHeightPx: 1000,
			boardHeightPx: 420,
			tickerHeightPx: 260,
			resultBandHeightPx: 110,
			viewportWidthPx: 1280,
			viewportHeightPx: 800,
		});

		expect(result.severity).toBe("risk");
		expect(result.summary).toContain("Risk");
		expect(result.summary).toContain("compressed");
		expect(result.shares.board).toBe(0.42);
		expect(result.shares.chrome).toBe(0.37);
		expect(result.shares.remaining).toBe(0.21);
	});

	test("falls back cleanly when measurements are not ready yet", () => {
		const result = evaluateDevLayoutHealth({
			frameHeightPx: 0,
			boardHeightPx: null,
			tickerHeightPx: undefined,
			resultBandHeightPx: 0,
		});

		expect(result.severity).toBe("clear");
		expect(result.summary).toContain("No usable measurements");
		expect(result.shares.board).toBe(0);
		expect(result.shares.chrome).toBe(0);
		expect(result.shares.remaining).toBe(0);
		expect(result.percents.board).toBe(0);
	});
});
