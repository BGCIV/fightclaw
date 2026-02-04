import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("responds to GET /health", async () => {
	const res = await SELF.fetch("https://example.com/health");
	expect(res.status).toBe(200);
});
