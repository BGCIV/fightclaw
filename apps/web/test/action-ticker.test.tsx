import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ActionTicker } from "../src/components/arena/action-ticker";

describe("ActionTicker", () => {
	test("shows only the 8 most recent items", () => {
		const items = Array.from({ length: 10 }, (_, index) => ({
			eventId: index + 1,
			ts: `2026-03-19T12:${String(index).padStart(2, "0")}:00.000Z`,
			turn: index + 1,
			player: index % 2 === 0 ? ("A" as const) : ("B" as const),
			text: `evt-${String(index + 1).padStart(2, "0")}`,
			tone: "neutral" as const,
		}));

		const markup = renderToStaticMarkup(<ActionTicker items={items} />);

		expect(markup).toContain("evt-10");
		expect(markup).toContain("evt-03");
		expect(markup).not.toContain("evt-02");
		expect(markup).not.toContain("evt-01");
	});

	test("can expose more items when a dev-only limit override is supplied", () => {
		const items = Array.from({ length: 10 }, (_, index) => ({
			eventId: index + 1,
			ts: `2026-03-19T12:${String(index).padStart(2, "0")}:00.000Z`,
			turn: index + 1,
			player: index % 2 === 0 ? ("A" as const) : ("B" as const),
			text: `evt-${String(index + 1).padStart(2, "0")}`,
			tone: "neutral" as const,
		}));

		const markup = renderToStaticMarkup(
			<ActionTicker items={items} visibleItemLimit={10} />,
		);

		expect(markup).toContain("10 recent");
		expect(markup).toContain("evt-10");
		expect(markup).toContain("evt-01");
	});
});
