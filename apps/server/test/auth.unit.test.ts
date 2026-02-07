import { describe, expect, it } from "vitest";
import { createIdentity } from "../src/appContext";

describe("createIdentity", () => {
	it("sets agentVerified true when verifiedAt is provided", () => {
		const id = createIdentity({
			agentId: "agent-1",
			verifiedAt: "2026-01-01T00:00:00Z",
		});
		expect(id.agentVerified).toBe(true);
		expect(id.verifiedAt).toBe("2026-01-01T00:00:00Z");
	});

	it("sets agentVerified false when verifiedAt is null", () => {
		const id = createIdentity({ agentId: "agent-2", verifiedAt: null });
		expect(id.agentVerified).toBe(false);
		expect(id.verifiedAt).toBeNull();
	});

	it("defaults verifiedAt to null and isAdmin to false", () => {
		const id = createIdentity({ agentId: "agent-3" });
		expect(id.verifiedAt).toBeNull();
		expect(id.agentVerified).toBe(false);
		expect(id.isAdmin).toBe(false);
	});

	it("passes through agentId and apiKeyId", () => {
		const id = createIdentity({
			agentId: "a",
			apiKeyId: "k",
			verifiedAt: null,
		});
		expect(id.agentId).toBe("a");
		expect(id.apiKeyId).toBe("k");
	});

	it("sets isAdmin when explicitly true", () => {
		const id = createIdentity({ agentId: "admin", isAdmin: true });
		expect(id.isAdmin).toBe(true);
	});
});
