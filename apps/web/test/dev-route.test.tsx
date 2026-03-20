import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DevLayout } from "../src/routes/dev";

describe("Dev spectator lab route", () => {
	test("renders spectator-first controls and keeps advanced tooling available", () => {
		const markup = renderToStaticMarkup(<DevLayout />);

		expect(markup.match(/spectator-top-bar/g)?.length).toBe(1);
		expect(markup).toContain("Desktop");
		expect(markup).toContain("Live board");
		expect(markup).toContain("Layout presets");
		expect(markup).toContain("Action burst");
		expect(markup).toContain("Diagnostics");
		expect(markup).toContain("Advanced tools");
		expect(markup).toContain("Lab");
		expect(markup).toContain("Sandbox");
		expect(markup).toContain("Replay");
		expect(markup).toContain("Seed");
		expect(markup).toContain("Ticker");
		expect(markup).toContain("Board shrink");
		expect(markup).toContain("Stage shell");
		expect(markup).toContain("Board footprint");
		expect(markup).toContain("Summary");
		expect(markup).not.toContain("Final result");
	});

	test("switches the visible stage when advanced tool modes are selected", () => {
		const sandboxMarkup = renderToStaticMarkup(
			<DevLayout initialMode="sandbox" />,
		);
		const replayMarkup = renderToStaticMarkup(
			<DevLayout initialMode="replay" />,
		);

		expect(sandboxMarkup).toContain("Sandbox tools");
		expect(sandboxMarkup).toContain("seed:42");
		expect(replayMarkup).toContain("Replay tool is driving the visible stage.");
		expect(replayMarkup).toContain("no replay");
	});
});
