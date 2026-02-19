import { describe, expect, it } from "vitest";
import { redactHeaders, redactRecord, redactValue } from "../src/obs/redact";

describe("redaction", () => {
	it("redacts sensitive keys in objects", () => {
		const payload = redactRecord({
			authorization: "Bearer secret",
			xAdminKey: "admin-secret",
			token: "abc123",
			regularField: "visible",
		});
		expect(payload.authorization).toBe("<redacted>");
		expect(payload.xAdminKey).toBe("<redacted>");
		expect(payload.token).toBe("<redacted>");
		expect(payload.regularField).toBe("visible");
	});

	it("redacts sensitive keys in headers", () => {
		const headers = new Headers({
			authorization: "Bearer secret",
			"x-runner-key": "runner-secret",
			"x-request-id": "req-1",
		});
		const redacted = redactHeaders(headers);
		expect(redacted.authorization).toBe("<redacted>");
		expect(redacted["x-runner-key"]).toBe("<redacted>");
		expect(redacted["x-request-id"]).toBe("req-1");
	});

	it("marks auth-like keys as redacted", () => {
		expect(redactValue("apiKey", "fc_sk_value")).toBe("<redacted>");
		expect(redactValue("secret", "value")).toBe("<redacted>");
		expect(redactValue("normal", "value")).toBe("value");
	});
});
