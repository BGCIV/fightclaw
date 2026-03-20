export type TestRuntimeKind = "match" | "matchmaker";

export type TestRuntimeRequestSummary = {
	method: string;
	path: string;
	status: number | null;
};

export type TestRuntimeEvent = {
	type: string;
	ts: number;
	[key: string]: unknown;
};

export type TestRuntimeSnapshot = {
	kind: TestRuntimeKind;
	id: string | null;
	hasAlarm: boolean;
	lastAlarmAtMs: number | null;
	lastRequest: TestRuntimeRequestSummary | null;
	pendingWaitUntilTasks: number;
	resetCount: number;
	recentEvents: TestRuntimeEvent[];
};

type CreateTestRuntimeDiagnosticsOptions = {
	enabled: boolean;
	kind: TestRuntimeKind;
	getId: () => string | null;
	maxEvents?: number;
};

const DEFAULT_MAX_EVENTS = 25;

export const createTestRuntimeDiagnostics = (
	options: CreateTestRuntimeDiagnosticsOptions,
) => {
	const enabled = options.enabled;
	const maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_MAX_EVENTS);
	let hasAlarm = false;
	let lastAlarmAtMs: number | null = null;
	let lastRequest: TestRuntimeRequestSummary | null = null;
	let pendingWaitUntilTasks = 0;
	let resetCount = 0;
	const recentEvents: TestRuntimeEvent[] = [];

	const record = (type: string, details?: Record<string, unknown>): void => {
		if (!enabled) return;
		recentEvents.push({
			type,
			ts: Date.now(),
			...(details ?? {}),
		});
		if (recentEvents.length > maxEvents) {
			recentEvents.splice(0, recentEvents.length - maxEvents);
		}
	};

	const snapshot = <T extends Record<string, unknown> = Record<string, never>>(
		extra?: T,
	): TestRuntimeSnapshot & T => {
		return {
			kind: options.kind,
			id: options.getId(),
			hasAlarm,
			lastAlarmAtMs,
			lastRequest: lastRequest ? { ...lastRequest } : null,
			pendingWaitUntilTasks,
			resetCount,
			recentEvents: recentEvents.map((entry) => ({ ...entry })),
			...(extra ?? ({} as T)),
		};
	};

	return {
		record,
		noteRequestStart(method: string, path: string) {
			if (!enabled) return;
			lastRequest = { method, path, status: null };
			record("request_start", { method, path });
		},
		noteRequestEnd(status: number) {
			if (!enabled) return;
			if (lastRequest) {
				lastRequest = { ...lastRequest, status };
			} else {
				lastRequest = { method: "UNKNOWN", path: "UNKNOWN", status };
			}
			record("request_end", { status });
		},
		noteAlarmSet(atMs: number) {
			if (!enabled) return;
			hasAlarm = true;
			lastAlarmAtMs = atMs;
			record("alarm_set", { atMs });
		},
		noteAlarmDeleted(reason?: string) {
			if (!enabled) return;
			hasAlarm = false;
			record("alarm_deleted", reason ? { reason } : undefined);
		},
		noteResetStart() {
			record("reset_start");
		},
		noteResetEnd() {
			if (!enabled) return;
			resetCount += 1;
			record("reset_end");
		},
		trackWaitUntil<T>(label: string, promise: Promise<T>) {
			if (!enabled) return promise;
			pendingWaitUntilTasks += 1;
			record("wait_until_scheduled", { label });
			return promise.then(
				(value) => {
					pendingWaitUntilTasks = Math.max(0, pendingWaitUntilTasks - 1);
					record("wait_until_fulfilled", { label });
					return value;
				},
				(error) => {
					pendingWaitUntilTasks = Math.max(0, pendingWaitUntilTasks - 1);
					record("wait_until_rejected", {
						label,
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				},
			);
		},
		snapshot,
	};
};
