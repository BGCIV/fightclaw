import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

it("creates a DO instance and can fetch it", async () => {
	if (!("MATCH" in env)) return;

	// @ts-expect-error MATCH is dynamic unless in your Env type
	const id = env.MATCH.newUniqueId();
	// @ts-expect-error MATCH is dynamic unless in your Env type
	const stub = env.MATCH.get(id);

	const res = await stub.fetch("https://example.com");
	expect([200, 404, 405]).toContain(res.status);

	await runInDurableObject(stub, async (_instance: unknown, _state) => {
		return new Response("ok");
	});
});
