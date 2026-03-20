export type DevLayoutHealthSeverity = "clear" | "watch" | "risk";

export type DevLayoutHealthInput = {
	frameHeightPx?: number | null;
	boardHeightPx?: number | null;
	tickerHeightPx?: number | null;
	resultBandHeightPx?: number | null;
	viewportWidthPx?: number | null;
	viewportHeightPx?: number | null;
};

export type DevLayoutHealth = {
	severity: DevLayoutHealthSeverity;
	summary: string;
	frameHeightPx: number;
	boardHeightPx: number;
	tickerHeightPx: number;
	resultBandHeightPx: number;
	viewport: {
		widthPx: number | null;
		heightPx: number | null;
		aspectRatio: number | null;
	} | null;
	boardShare: number;
	tickerShare: number;
	resultBandShare: number;
	shares: {
		board: number;
		chrome: number;
		remaining: number;
		boardToAvailable: number;
	};
	percents: {
		board: number;
		chrome: number;
		remaining: number;
		boardToAvailable: number;
	};
};

const MIN_MEANINGFUL_FRAME_HEIGHT_PX = 1;

export function evaluateDevLayoutHealth(
	input: DevLayoutHealthInput,
): DevLayoutHealth {
	const frameHeightPx = normalizeMetric(input.frameHeightPx);
	const boardHeightPx = normalizeMetric(input.boardHeightPx);
	const tickerHeightPx = normalizeMetric(input.tickerHeightPx);
	const resultBandHeightPx = normalizeMetric(input.resultBandHeightPx);
	const viewport = buildViewport(input.viewportWidthPx, input.viewportHeightPx);

	if (frameHeightPx < MIN_MEANINGFUL_FRAME_HEIGHT_PX) {
		return {
			severity: "clear",
			summary: "No usable measurements yet for dev layout health.",
			frameHeightPx,
			boardHeightPx,
			tickerHeightPx,
			resultBandHeightPx,
			viewport,
			boardShare: 0,
			tickerShare: 0,
			resultBandShare: 0,
			shares: {
				board: 0,
				chrome: 0,
				remaining: 0,
				boardToAvailable: 0,
			},
			percents: {
				board: 0,
				chrome: 0,
				remaining: 0,
				boardToAvailable: 0,
			},
		};
	}

	const chromeHeightPx = tickerHeightPx + resultBandHeightPx;
	const availableBoardHeightPx = Math.max(frameHeightPx - chromeHeightPx, 0);

	const shares = {
		board: boardHeightPx / frameHeightPx,
		chrome: chromeHeightPx / frameHeightPx,
		remaining:
			Math.max(frameHeightPx - boardHeightPx - chromeHeightPx, 0) /
			frameHeightPx,
		boardToAvailable:
			availableBoardHeightPx > 0 ? boardHeightPx / availableBoardHeightPx : 0,
	};

	const severity = getSeverity(shares);

	return {
		severity,
		summary: buildSummary(severity, shares),
		frameHeightPx,
		boardHeightPx,
		tickerHeightPx,
		resultBandHeightPx,
		viewport,
		boardShare: shares.board,
		tickerShare: tickerHeightPx / frameHeightPx,
		resultBandShare: resultBandHeightPx / frameHeightPx,
		shares,
		percents: toPercents(shares),
	};
}

function getSeverity(
	shares: DevLayoutHealth["shares"],
): DevLayoutHealthSeverity {
	if (shares.board <= 0.5 || shares.chrome >= 0.35) {
		return "risk";
	}

	if (shares.board >= 0.7 && shares.chrome <= 0.25) {
		return "clear";
	}

	if (shares.board <= 0.65 || shares.chrome >= 0.18) {
		return "watch";
	}

	return "clear";
}

function buildSummary(
	severity: DevLayoutHealthSeverity,
	shares: DevLayoutHealth["shares"],
): string {
	const boardPct = Math.round(shares.board * 100);
	const chromePct = Math.round(shares.chrome * 100);
	const remainingPct = Math.round(shares.remaining * 100);
	const boardGapPct = Math.round((1 - shares.boardToAvailable) * 100);
	const base = `Board uses ${boardPct}% of the frame; chrome uses ${chromePct}% and leaves ${remainingPct}% free.`;

	if (severity === "risk") {
		return `Risk: the board looks compressed. ${base} Chrome pressure is leaving too little room for the board.`;
	}

	if (severity === "watch") {
		return `Watch: ticker/result chrome is starting to compress the board. ${base} Board is ${boardGapPct}% away from the available height.`;
	}

	return `Clear: the board still has healthy room. ${base}`;
}

function buildViewport(
	widthPx: number | null | undefined,
	heightPx: number | null | undefined,
): DevLayoutHealth["viewport"] {
	const normalizedWidthPx = normalizeOptionalMetric(widthPx);
	const normalizedHeightPx = normalizeOptionalMetric(heightPx);
	if (normalizedWidthPx === null && normalizedHeightPx === null) {
		return null;
	}

	return {
		widthPx: normalizedWidthPx,
		heightPx: normalizedHeightPx,
		aspectRatio:
			normalizedWidthPx !== null &&
			normalizedHeightPx !== null &&
			normalizedHeightPx > 0
				? normalizedWidthPx / normalizedHeightPx
				: null,
	};
}

function normalizeMetric(value: number | null | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return 0;
	}
	return value;
}

function normalizeOptionalMetric(
	value: number | null | undefined,
): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return null;
	}
	return value;
}

function toPercents(
	shares: DevLayoutHealth["shares"],
): DevLayoutHealth["percents"] {
	return {
		board: roundPercent(shares.board),
		chrome: roundPercent(shares.chrome),
		remaining: roundPercent(shares.remaining),
		boardToAvailable: roundPercent(shares.boardToAvailable),
	};
}

function roundPercent(value: number): number {
	return Math.round(value * 100);
}
