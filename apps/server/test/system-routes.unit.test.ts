import { describe, expect, it } from "vitest";
import { systemRoutes } from "../src/routes/system";

describe("system routes", () => {
	it("responds to GET /health", async () => {
		const res = await systemRoutes.request("https://example.com/health");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("OK");
	});

	it("responds to GET /v1/system/version", async () => {
		const res = await systemRoutes.request(
			"https://example.com/v1/system/version",
			undefined,
			{
				CF_VERSION_METADATA: {
					gitSha: "abc123",
					buildTime: "2026-03-12T00:00:00Z",
				},
				SENTRY_ENVIRONMENT: "test",
			} as never,
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			contractsVersion?: unknown;
			protocolVersion?: unknown;
			engineVersion?: unknown;
			gitSha?: unknown;
			buildTime?: unknown;
			environment?: unknown;
		};
		expect(typeof json.contractsVersion).toBe("string");
		expect(typeof json.protocolVersion).toBe("number");
		expect(typeof json.engineVersion).toBe("string");
		expect(json.gitSha).toBe("abc123");
		expect(json.buildTime).toBe("2026-03-12T00:00:00Z");
		expect(json.environment).toBe("test");
	});
});
