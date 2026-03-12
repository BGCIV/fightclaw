import { afterEach, beforeEach, expect, it } from "vitest";
import { openSse, readSseUntil, resetDb, setupMatch } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

afterEach(async () => {
	await resetDb();
	await new Promise((resolve) => setTimeout(resolve, 100));
});

it("streams featured_changed and state events", async () => {
	await setupMatch();

	const stream = await openSse("https://example.com/v1/featured/stream");
	expect(stream.res.status).toBe(200);

	try {
		const result = await readSseUntil(
			stream.res,
			(text) =>
				text.includes("event: featured_changed") &&
				text.includes("event: state"),
			5000,
			200_000,
			{
				throwOnTimeout: true,
				label: "featured stream",
				abortController: stream.controller,
			},
		);
		expect(result.text).toContain("event: featured_changed");
		expect(result.text).toContain("event: state");
	} finally {
		await stream.close();
	}
});
