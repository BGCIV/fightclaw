import { describe, expect, test } from "bun:test";
import { createInitialState } from "@fightclaw/engine";
import { renderToStaticMarkup } from "react-dom/server";

import { SpectatorArena } from "../src/components/arena/spectator-arena";

describe("SpectatorArena broadcast desk", () => {
	test("renders featured status, broadcast cards, ticker items, and a result band", () => {
		const state = createInitialState(11, undefined, ["Alpha", "Bravo"]);

		const markup = renderToStaticMarkup(
			<SpectatorArena
				statusBadge="LIVE"
				state={state}
				featuredDesk={{
					matchId: "match-42",
					label: "Featured live",
					status: "live",
					playersLabel: "Alpha vs Bravo",
				}}
				agentCards={{
					A: {
						side: "A",
						agentId: "agent-alpha",
						name: "Alpha",
						publicPersona:
							"Terrain-first opportunist who wins by pressure and income.",
						styleTag: "Pressing",
						gold: 9,
						wood: 5,
						vp: 2,
						unitCount: 6,
						publicCommentary: "Hold center and recruit on tempo.",
					},
					B: {
						side: "B",
						agentId: "agent-bravo",
						name: "Bravo",
						publicPersona: "Patient attrition player with a steady tempo.",
						styleTag: "Balanced",
						gold: 7,
						wood: 4,
						vp: 1,
						unitCount: 5,
						publicCommentary: "Stabilizing the right flank.",
					},
				}}
				tickerItems={[
					{
						eventId: 8,
						ts: "2026-03-19T12:10:00.000Z",
						turn: 4,
						player: "A",
						text: "A advanced u_a_1 to B2",
						tone: "neutral",
					},
				]}
				resultSummary={{
					headline: "A wins",
					subtitle: "Elimination · B falls",
					winningSide: "A",
					reasonLabel: "Elimination",
				}}
				effects={[]}
				unitAnimStates={new Map()}
				dyingUnitIds={new Set()}
				damageNumbers={[]}
				lungeTargets={new Map()}
			/>,
		);

		expect(markup).toContain("Featured live");
		expect(markup).toContain("Alpha vs Bravo");
		expect(markup).toContain(
			"Terrain-first opportunist who wins by pressure and income.",
		);
		expect(markup).toContain("Patient attrition player with a steady tempo.");
		expect(markup).toContain("Hold center and recruit on tempo.");
		expect(markup).toContain("Stabilizing the right flank.");
		expect(markup).toContain('href="/agents/agent-alpha"');
		expect(markup).toContain('href="/agents/agent-bravo"');
		expect(markup).toContain("A advanced u_a_1 to B2");
		expect(markup).toContain("Alpha wins");
		expect(markup).toContain("Elimination");
		expect(markup).toContain("spectator-stage-body");
		expect(markup).toContain("spectator-stage-ticker");
	});
});
