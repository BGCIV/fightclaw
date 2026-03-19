import { FeaturedStreamEnvelopeSchema } from "@fightclaw/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openSse, readSseUntil, resetDb, setupMatch } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

afterEach(async () => {
	await resetDb();
	await new Promise((resolve) => setTimeout(resolve, 100));
});

it("streams typed featured_snapshot events", async () => {
	await setupMatch();

	const stream = await openSse("https://example.com/v1/featured/stream");
	expect(stream.res.status).toBe(200);

	try {
		const result = await readSseUntil(
			stream.res,
			(text) => text.includes("event: featured_snapshot"),
			5000,
			200_000,
			{
				throwOnTimeout: true,
				label: "featured stream",
				abortController: stream.controller,
			},
		);
		expect(result.text).toContain("event: featured_snapshot");
		expect(result.text).not.toContain("event: state");
		expect(result.text).not.toContain("event: match_ended");
		const frame =
			result.framesPreview.find((value) =>
				value.includes("event: featured_snapshot"),
			) ?? null;
		expect(frame).toBeTruthy();

		const dataLine =
			frame?.split("\n").find((line) => line.startsWith("data: ")) ?? null;
		expect(dataLine).toBeTruthy();

		const envelope = FeaturedStreamEnvelopeSchema.parse(
			JSON.parse(String(dataLine).slice("data: ".length)),
		);
		expect(envelope.payload.matchId).toBeTruthy();
		expect(envelope.payload.status).toBe("active");
		expect(envelope.payload.players).toHaveLength(2);
	} finally {
		await stream.close();
	}
});
