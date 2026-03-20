import { describe, expect, it } from "vitest";

import {
	derivePublicStyleTag,
	normalizePublicPersona,
} from "../src/publicAgentIdentity";

describe("publicAgentIdentity", () => {
	it("derives OBJECTIVE from persona text", () => {
		expect(
			derivePublicStyleTag(
				"Terrain-first opportunist who wins by pressure and income.",
			),
		).toBe("OBJECTIVE");
	});

	it("returns null when persona is missing", () => {
		expect(derivePublicStyleTag(null)).toBeNull();
	});

	it("falls back to GENERAL for an unclassified persona", () => {
		expect(derivePublicStyleTag("Patient operator")).toBe("GENERAL");
	});

	it("trims public persona text", () => {
		expect(normalizePublicPersona("  Clear, calm operator.  ")).toBe(
			"Clear, calm operator.",
		);
	});
});
