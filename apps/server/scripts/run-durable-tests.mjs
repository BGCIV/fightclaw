import net from "node:net";
import { buildVitestRuns } from "./run-durable-tests-lib.mjs";
import {
	formatDurableRunSummary,
	runVitestRuns,
} from "./run-durable-tests-runner.mjs";

const canListen = async () => {
	return await new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", (err) => {
			server.close(() => resolve({ ok: false, err }));
		});
		server.listen(0, "127.0.0.1", () => {
			server.close(() => resolve({ ok: true, err: null }));
		});
	});
};

const requireNet = process.env.REQUIRE_DURABLE_NET === "1";

const probe = await canListen();
if (!probe.ok) {
	const message = [
		"Durable test lane cannot start because this environment forbids opening listening sockets.",
		`Root error: ${probe.err?.message || "unknown"}`,
		"",
		"Set REQUIRE_DURABLE_NET=1 to fail hard instead of skipping.",
	].join("\n");

	if (requireNet) {
		console.error(message);
		process.exit(1);
	}

	console.log(`${message}\nSkipping durable tests.`);
	process.exit(0);
}

const summary = await runVitestRuns(buildVitestRuns(process.argv.slice(2)), {
	timeoutMs: process.env.DURABLE_TEST_TIMEOUT_MS,
	write: console.log,
});

console.log(formatDurableRunSummary(summary));
process.exit(summary.exitCode);
