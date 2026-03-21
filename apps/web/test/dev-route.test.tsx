import { describe, expect, test } from "bun:test";
import { createInitialState } from "@fightclaw/engine";
import {
	DevLayout,
	projectAdvancedTickerItems,
	resolveAdvancedTerminalEvent,
} from "../src/routes/dev";
import { renderWithRouterToStaticMarkup } from "./render-with-router";

describe("Dev spectator lab route", () => {
	test("renders spectator-first controls and keeps advanced tooling available", async () => {
		const markup = await renderWithRouterToStaticMarkup("/", <DevLayout />);

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

	test("switches the visible stage when advanced tool modes are selected", async () => {
		const sandboxMarkup = await renderWithRouterToStaticMarkup(
			"/",
			<DevLayout initialMode="sandbox" />,
		);
		const replayMarkup = await renderWithRouterToStaticMarkup(
			"/",
			<DevLayout initialMode="replay" />,
		);

		expect(sandboxMarkup).toContain("Sandbox tools");
		expect(sandboxMarkup).toContain("seed:42");
		expect(replayMarkup).toContain("Replay tool is driving the visible stage.");
		expect(replayMarkup).toContain("no replay");
	});

	test("projects stable ticker metadata from action log entries", () => {
		const items = projectAdvancedTickerItems(
			[
				{
					id: "log-7",
					eventId: 7,
					ts: "2026-03-20T12:00:07.000Z",
					label: "sandbox: pass",
					player: "A",
					turn: 3,
					tone: "neutral",
				},
			],
			10,
		);

		expect(items).toEqual([
			{
				eventId: 7,
				ts: "2026-03-20T12:00:07.000Z",
				turn: 3,
				player: "A",
				text: "sandbox: pass",
				tone: "neutral",
			},
		]);
	});

	test("does not synthesize a replay terminal event before the replay board ends", () => {
		const activeState = createInitialState(1, { boardColumns: 17 }, [
			"Alpha",
			"Bravo",
		]);
		const terminalEvent = resolveAdvancedTerminalEvent({
			mode: "replay",
			boardState: activeState,
			selectedMatch: {
				id: "match-42",
				label: "Replay",
				scenario: null,
				seed: 1,
				engineConfig: null,
				participants: ["Alpha", "Bravo"],
				result: { winner: "Alpha", reason: "elimination" },
				initialState: createInitialState(1, { boardColumns: 17 }, [
					"Alpha",
					"Bravo",
				]),
				steps: [],
			},
		});

		expect(terminalEvent).toBeNull();
	});

	test("synthesizes a replay terminal event from the selected match result after the board ends", () => {
		const endedState = {
			...createInitialState(1, { boardColumns: 17 }, ["Alpha", "Bravo"]),
			status: "ended" as const,
		};
		const terminalEvent = resolveAdvancedTerminalEvent({
			mode: "replay",
			boardState: endedState,
			selectedMatch: {
				id: "match-42",
				label: "Replay",
				scenario: null,
				seed: 1,
				engineConfig: null,
				participants: ["Alpha", "Bravo"],
				result: { winner: "Alpha", reason: "elimination" },
				initialState: createInitialState(1, { boardColumns: 17 }, [
					"Alpha",
					"Bravo",
				]),
				steps: [],
			},
		});

		expect(terminalEvent).toMatchObject({
			matchId: "match-42",
			event: "match_ended",
			payload: {
				winnerAgentId: "Alpha",
				loserAgentId: "Bravo",
				reasonCode: "elimination",
			},
		});
	});
});
