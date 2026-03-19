import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const firstMock = vi.fn();
const runMock = vi.fn();
const prepareMock = vi.fn();

const mockEnv = {
	INTERNAL_RUNNER_KEY: "test-runner-key",
	DB: {
		prepare: prepareMock,
	},
};

const loadHelpers = async () => {
	vi.resetModules();
	vi.doMock("cloudflare:test", () => ({
		env: mockEnv,
		SELF: {
			fetch: fetchMock,
		},
	}));
	return await import("./helpers");
};

beforeEach(() => {
	vi.useRealTimers();
	fetchMock.mockReset();
	firstMock.mockReset();
	runMock.mockReset();
	prepareMock.mockReset();
	prepareMock.mockImplementation(() => ({
		first: firstMock,
		run: runMock,
	}));
	firstMock.mockResolvedValue({ count: 0 });
	runMock.mockResolvedValue({});
	mockEnv.INTERNAL_RUNNER_KEY = "test-runner-key";
});

afterEach(() => {
	vi.useRealTimers();
	vi.doUnmock("cloudflare:test");
});

describe("durable test helpers", () => {
	it("throws when durable objects never settle", async () => {
		firstMock.mockResolvedValue({ count: 1 });
		const { waitForDoSettle } = await loadHelpers();

		await expect(waitForDoSettle(10)).rejects.toThrow(
			/Timed out waiting for durable objects to settle/i,
		);
	});

	it("rethrows reset failures instead of swallowing them", async () => {
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		fetchMock.mockRejectedValue(new Error("reset failed"));
		const { ensureResetDb } = await loadHelpers();

		await expect(ensureResetDb()).rejects.toThrow("reset failed");
		consoleErrorSpy.mockRestore();
	});

	it("fails resetDb when the internal reset endpoint never succeeds", async () => {
		vi.useFakeTimers();
		fetchMock.mockResolvedValue({ ok: false, status: 503 });
		const { resetDb } = await loadHelpers();

		const resetExpectation = expect(resetDb()).rejects.toThrow(
			/Reset unavailable|503/,
		);
		await vi.runAllTimersAsync();

		await resetExpectation;
		expect(fetchMock).toHaveBeenCalledTimes(10);
	});
});
