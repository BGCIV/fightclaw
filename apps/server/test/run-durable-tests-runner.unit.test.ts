import { describe, expect, it, vi } from "vitest";
import {
	formatDurableRunSummary,
	runVitestRuns,
} from "../scripts/run-durable-tests-runner.mjs";

type CompletionResult = {
	exitCode: number;
	signal: string | null;
};

const createRun = (file) => ({
	args: [
		"./node_modules/vitest/vitest.mjs",
		"-c",
		"vitest.durable.config.ts",
		"--run",
	],
	env: {
		VITEST_INCLUDE: file,
	},
});

const createHandle = () => {
	let resolveCompletion:
		| ((value: CompletionResult | PromiseLike<CompletionResult>) => void)
		| undefined;
	let rejectCompletion: ((reason?: unknown) => void) | undefined;
	const completion = new Promise<CompletionResult>((resolve, reject) => {
		resolveCompletion = resolve;
		rejectCompletion = reject;
	});

	return {
		completion,
		resolveCompletion,
		rejectCompletion,
		terminate: vi.fn(async () => {}),
	};
};

describe("runVitestRuns", () => {
	it("records passed and failed runs separately", async () => {
		const first = createHandle();
		const second = createHandle();
		const spawnRun = vi
			.fn()
			.mockReturnValueOnce(first)
			.mockReturnValueOnce(second);
		const write = vi.fn();

		const runPromise = runVitestRuns(
			[
				createRun("test/durable/sse.durable.test.ts"),
				createRun("test/durable/queue.durable.test.ts"),
			],
			{
				spawnRun,
				timeoutMs: 5_000,
				write,
			},
		);

		await vi.waitFor(() => expect(spawnRun).toHaveBeenCalledTimes(1));
		first.resolveCompletion({ exitCode: 0, signal: null });
		await vi.waitFor(() => expect(spawnRun).toHaveBeenCalledTimes(2));
		second.resolveCompletion({ exitCode: 2, signal: null });

		const summary = await runPromise;

		expect(summary.passed).toHaveLength(1);
		expect(summary.failed).toHaveLength(1);
		expect(summary.timedOut).toHaveLength(0);
		expect(summary.passed[0]?.file).toBe("test/durable/sse.durable.test.ts");
		expect(summary.failed[0]?.file).toBe("test/durable/queue.durable.test.ts");
		expect(summary.exitCode).toBe(1);
		expect(write).toHaveBeenCalled();
	});

	it("kills a timed out child and records the timeout", async () => {
		vi.useFakeTimers();
		const hung = createHandle();
		const spawnRun = vi.fn().mockReturnValue(hung);

		const runPromise = runVitestRuns(
			[createRun("test/durable/observability.safety.durable.test.ts")],
			{
				spawnRun,
				timeoutMs: 250,
				write: vi.fn(),
			},
		);

		await vi.waitFor(() => expect(spawnRun).toHaveBeenCalledTimes(1));
		await vi.advanceTimersByTimeAsync(250);

		const summary = await runPromise;

		expect(hung.terminate).toHaveBeenCalledWith("SIGKILL");
		expect(summary.passed).toHaveLength(0);
		expect(summary.failed).toHaveLength(0);
		expect(summary.timedOut).toHaveLength(1);
		expect(summary.timedOut[0]?.file).toBe(
			"test/durable/observability.safety.durable.test.ts",
		);
		expect(summary.exitCode).toBe(1);

		vi.useRealTimers();
	});

	it("keeps a killed child in the timed out bucket even if completion resolves after termination", async () => {
		vi.useFakeTimers();
		const hung = createHandle();
		hung.terminate.mockImplementation(async () => {
			hung.resolveCompletion({ exitCode: 1, signal: "SIGKILL" });
		});
		const spawnRun = vi.fn().mockReturnValue(hung);

		const runPromise = runVitestRuns(
			[createRun("test/durable/ws.durable.test.ts")],
			{
				spawnRun,
				timeoutMs: 250,
				write: vi.fn(),
			},
		);

		expect(spawnRun).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(250);

		const summary = await runPromise;

		expect(summary.failed).toHaveLength(0);
		expect(summary.timedOut).toHaveLength(1);
		expect(summary.timedOut[0]?.file).toBe("test/durable/ws.durable.test.ts");

		vi.useRealTimers();
	});

	it("waits for timeout cleanup before starting the next run", async () => {
		vi.useFakeTimers();
		const first = createHandle();
		let resolveCleanup: (() => void) | undefined;
		first.terminate.mockReturnValue(
			new Promise((resolve) => {
				resolveCleanup = resolve;
			}),
		);
		const second = createHandle();
		const spawnRun = vi
			.fn()
			.mockReturnValueOnce(first)
			.mockImplementationOnce(() => {
				queueMicrotask(() => {
					second.resolveCompletion({ exitCode: 0, signal: null });
				});
				return second;
			});

		const runPromise = runVitestRuns(
			[
				createRun("test/durable/ws.durable.test.ts"),
				createRun("test/durable/queue.durable.test.ts"),
			],
			{
				spawnRun,
				timeoutMs: 250,
				write: vi.fn(),
			},
		);

		expect(spawnRun).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(250);
		expect(spawnRun).toHaveBeenCalledTimes(1);

		resolveCleanup?.();
		await vi.waitFor(() => expect(spawnRun).toHaveBeenCalledTimes(2));

		const summary = await runPromise;

		expect(summary.timedOut).toHaveLength(1);
		expect(summary.passed).toHaveLength(1);

		vi.useRealTimers();
	});
});

describe("formatDurableRunSummary", () => {
	it("prints bucketed pass, fail, and timeout counts", () => {
		const summary = {
			totalRuns: 3,
			durationMs: 1_250,
			exitCode: 1,
			passed: [{ file: "test/durable/sse.durable.test.ts", durationMs: 500 }],
			failed: [
				{
					file: "test/durable/queue.durable.test.ts",
					durationMs: 400,
					exitCode: 2,
					signal: null,
					error: null,
				},
			],
			timedOut: [
				{
					file: "test/durable/observability.safety.durable.test.ts",
					durationMs: 350,
					timeoutMs: 250,
				},
			],
		};

		expect(formatDurableRunSummary(summary)).toContain("Passed: 1");
		expect(formatDurableRunSummary(summary)).toContain("Failed: 1");
		expect(formatDurableRunSummary(summary)).toContain("Timed out: 1");
	});
});
