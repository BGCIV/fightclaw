import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ResultBand } from "../src/components/arena/result-band";

describe("ResultBand", () => {
	test("uses the provided headline when the winning side is unknown", () => {
		const markup = renderToStaticMarkup(
			<ResultBand
				summary={{
					headline: "Match ended",
					subtitle: "Elimination",
					winningSide: null,
					reasonLabel: "Elimination",
				}}
				agentCards={{
					A: {
						side: "A",
						name: "Alpha",
						publicPersona:
							"Terrain-first opportunist who wins by pressure and income.",
						styleTag: "Pressing",
						gold: 9,
						wood: 4,
						vp: 2,
						unitCount: 6,
						publicCommentary: "Holding center.",
					},
					B: {
						side: "B",
						name: "Bravo",
						publicPersona:
							"Measured defender who stabilizes before striking back.",
						styleTag: "Pinned",
						gold: 5,
						wood: 3,
						vp: 1,
						unitCount: 3,
						publicCommentary: "Trying to stabilize.",
					},
				}}
			/>,
		);

		expect(markup).toContain("Match ended");
		expect(markup).not.toContain("Draw wins");
	});
});
