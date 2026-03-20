import { describe, expect, it } from "vitest";
import { createTestRuntimeDiagnostics } from "../src/utils/testRuntimeDiagnostics";

describe("test runtime diagnostics", () => {
	it("tracks bounded events and waitUntil lifecycle", async () => {
		const diagnostics = createTestRuntimeDiagnostics({
			enabled: true,
			kind: "match",
			getId: () => "match-1",
			maxEvents: 3,
		});

		diagnostics.noteRequestStart("GET", "/state");
		diagnostics.noteRequestEnd(200);
		diagnostics.noteAlarmSet(123);
		const pending = diagnostics.trackWaitUntil(
			"persist_finalization",
			Promise.resolve(),
		);

		expect(diagnostics.snapshot()).toMatchObject({
			kind: "match",
			id: "match-1",
			hasAlarm: true,
			pendingWaitUntilTasks: 1,
			lastRequest: {
				method: "GET",
				path: "/state",
				status: 200,
			},
		});

		await pending;
		diagnostics.noteResetStart();
		diagnostics.noteResetEnd();

		expect(diagnostics.snapshot()).toMatchObject({
			hasAlarm: true,
			pendingWaitUntilTasks: 0,
			resetCount: 1,
		});
		expect(
			diagnostics.snapshot().recentEvents.map((entry) => entry.type),
		).toEqual(["wait_until_fulfilled", "reset_start", "reset_end"]);
	});

	it("stays dormant when disabled", async () => {
		const diagnostics = createTestRuntimeDiagnostics({
			enabled: false,
			kind: "matchmaker",
			getId: () => "global",
		});

		const tracked = diagnostics.trackWaitUntil("noop", Promise.resolve());
		diagnostics.noteRequestStart("GET", "/queue/status");
		diagnostics.noteRequestEnd(200);
		diagnostics.noteAlarmSet(456);
		diagnostics.noteResetStart();
		diagnostics.noteResetEnd();
		await tracked;

		expect(diagnostics.snapshot()).toEqual({
			kind: "matchmaker",
			id: "global",
			hasAlarm: false,
			lastAlarmAtMs: null,
			lastRequest: null,
			pendingWaitUntilTasks: 0,
			recentEvents: [],
			resetCount: 0,
		});
	});
});
