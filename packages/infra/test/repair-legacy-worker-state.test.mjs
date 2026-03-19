import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	repairLegacyWorkerState,
	repairLegacyWorkerStates,
} from "../scripts/repair-legacy-worker-state.mjs";

const tempDirs = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const writeJson = (filePath, value) => {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

describe("repairLegacyWorkerState", () => {
	it("repairs stale fightclaw-server output names and removes the legacy workers.dev child state", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "fightclaw-alchemy-state-"));
		tempDirs.push(dir);

		const stateDir = path.join(dir, "fightclaw", "bgciv");
		const serverChildDir = path.join(stateDir, "server");
		mkdirSync(serverChildDir, { recursive: true });

		const serverFile = path.join(stateDir, "server.json");
		const urlFile = path.join(serverChildDir, "url.json");

		writeJson(serverFile, {
			output: {
				name: "fightclaw-server",
				bindings: {
					MATCHMAKER: { scriptName: "fightclaw-server" },
					MATCH: { scriptName: "fightclaw-server" },
				},
			},
			props: {
				name: "fightclaw-server-production",
			},
		});

		writeJson(urlFile, {
			props: {
				scriptName: "fightclaw-server",
			},
			output: {
				url: "https://fightclaw-server.iambgc4.workers.dev",
			},
		});

		const result = repairLegacyWorkerState({
			stateDir,
			legacyWorkerName: "fightclaw-server",
		});

		assert.equal(result.repaired, true);
		assert.equal(result.removedLegacyUrlState, true);
		assert.deepEqual(result.changedFiles.sort(), [serverFile, urlFile].sort());

		const repairedServer = JSON.parse(readFileSync(serverFile, "utf8"));
		assert.equal(repairedServer.output.name, "fightclaw-server-production");
		assert.equal(
			repairedServer.output.bindings.MATCH.scriptName,
			"fightclaw-server-production",
		);
		assert.equal(
			repairedServer.output.bindings.MATCHMAKER.scriptName,
			"fightclaw-server-production",
		);
		assert.equal(readFileSync(serverFile, "utf8").endsWith("\n"), true);
		assert.throws(() => readFileSync(urlFile, "utf8"));
	});

	it("is a no-op when the worker state is already canonical", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "fightclaw-alchemy-state-"));
		tempDirs.push(dir);

		const stateDir = path.join(dir, "fightclaw", "bgciv");
		mkdirSync(stateDir, { recursive: true });
		const serverFile = path.join(stateDir, "server.json");

		writeJson(serverFile, {
			output: {
				name: "fightclaw-server-production",
				bindings: {
					MATCHMAKER: { scriptName: "fightclaw-server-production" },
					MATCH: { scriptName: "fightclaw-server-production" },
				},
			},
			props: {
				name: "fightclaw-server-production",
			},
		});

		const result = repairLegacyWorkerState({
			stateDir,
			legacyWorkerName: "fightclaw-server",
		});

		assert.equal(result.repaired, false);
		assert.equal(result.removedLegacyUrlState, false);
		assert.deepEqual(result.changedFiles, []);
	});
});

describe("repairLegacyWorkerStates", () => {
	it("discovers and repairs every legacy server state under the alchemy root", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "fightclaw-alchemy-root-"));
		tempDirs.push(dir);

		const productionStateDir = path.join(dir, "fightclaw", "bgciv");
		const stagingStateDir = path.join(dir, "fightclaw-staging", "bgciv");
		const outDir = path.join(dir, "out", "fightclaw-server");

		mkdirSync(path.join(productionStateDir, "server"), { recursive: true });
		mkdirSync(path.join(stagingStateDir, "server"), { recursive: true });
		mkdirSync(outDir, { recursive: true });

		const productionServerFile = path.join(productionStateDir, "server.json");
		const stagingServerFile = path.join(stagingStateDir, "server.json");
		const productionUrlFile = path.join(
			productionStateDir,
			"server",
			"url.json",
		);
		const stagingUrlFile = path.join(stagingStateDir, "server", "url.json");

		writeJson(productionServerFile, {
			output: {
				name: "fightclaw-server",
				bindings: {
					MATCH: { scriptName: "fightclaw-server" },
				},
			},
			props: {
				name: "fightclaw-server-production",
			},
		});

		writeJson(stagingServerFile, {
			output: {
				name: "fightclaw-server",
				bindings: {
					MATCHMAKER: { scriptName: "fightclaw-server" },
				},
			},
			props: {
				name: "fightclaw-server-staging",
			},
		});

		writeJson(productionUrlFile, {
			props: {
				scriptName: "fightclaw-server",
			},
			output: {
				url: "https://fightclaw-server.example.workers.dev",
			},
		});

		writeJson(stagingUrlFile, {
			props: {
				scriptName: "fightclaw-server",
			},
			output: {
				url: "https://fightclaw-server.example.workers.dev",
			},
		});

		const result = repairLegacyWorkerStates({
			stateRoot: dir,
			legacyWorkerName: "fightclaw-server",
		});

		assert.equal(result.repaired, true);
		assert.equal(result.results.length, 2);
		assert.deepEqual(
			result.changedFiles.sort(),
			[
				productionServerFile,
				productionUrlFile,
				stagingServerFile,
				stagingUrlFile,
			].sort(),
		);

		const repairedProduction = JSON.parse(
			readFileSync(productionServerFile, "utf8"),
		);
		const repairedStaging = JSON.parse(readFileSync(stagingServerFile, "utf8"));

		assert.equal(repairedProduction.output.name, "fightclaw-server-production");
		assert.equal(repairedStaging.output.name, "fightclaw-server-staging");
		assert.throws(() => readFileSync(productionUrlFile, "utf8"));
		assert.throws(() => readFileSync(stagingUrlFile, "utf8"));
	});
});
