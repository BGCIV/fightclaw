import { describe, expect, it } from "vitest";
import {
	base64ToBytes,
	base64UrlDecode,
	base64UrlEncode,
	bytesToBase64,
	randomBase64Url,
	sha256Hex,
} from "../src/utils/crypto";

describe("sha256Hex", () => {
	it("produces a 64-char hex string", async () => {
		const hash = await sha256Hex("hello");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is deterministic", async () => {
		const a = await sha256Hex("test-input");
		const b = await sha256Hex("test-input");
		expect(a).toBe(b);
	});

	it("differs for different inputs", async () => {
		const a = await sha256Hex("input-a");
		const b = await sha256Hex("input-b");
		expect(a).not.toBe(b);
	});
});

describe("base64UrlEncode / base64UrlDecode", () => {
	it("round-trips arbitrary bytes", () => {
		const original = new Uint8Array([0, 127, 255, 63, 62, 1]);
		const encoded = base64UrlEncode(original);
		const decoded = base64UrlDecode(encoded);
		expect(decoded).toEqual(original);
	});

	it("produces URL-safe output (no +, /, or =)", () => {
		// Use bytes that would produce +, /, = in standard base64
		const bytes = new Uint8Array([251, 239, 190, 63, 255]);
		const encoded = base64UrlEncode(bytes);
		expect(encoded).not.toMatch(/[+/=]/);
	});

	it("throws on invalid base64url input", () => {
		expect(() => base64UrlDecode("x")).toThrow("Invalid base64url string");
	});
});

describe("bytesToBase64 / base64ToBytes", () => {
	it("round-trips bytes", () => {
		const original = new Uint8Array([10, 20, 30, 40]);
		const b64 = bytesToBase64(original);
		const decoded = base64ToBytes(b64);
		expect(decoded).toEqual(original);
	});
});

describe("randomBase64Url", () => {
	it("produces a string of expected length", () => {
		// 32 random bytes → ~43 base64url chars (ceil(32*4/3) without padding)
		const result = randomBase64Url(32);
		expect(result.length).toBe(43);
	});

	it("produces URL-safe output", () => {
		const result = randomBase64Url(64);
		expect(result).not.toMatch(/[+/=]/);
	});

	it("produces different values on each call", () => {
		const a = randomBase64Url(16);
		const b = randomBase64Url(16);
		expect(a).not.toBe(b);
	});
});
