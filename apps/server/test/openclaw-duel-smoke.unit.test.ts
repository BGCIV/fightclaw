import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSmokeArtifactBundle } from "../scripts/openclaw-duel-smoke-artifacts.mjs";
import {
	buildOpenClawDuelCommand,
	DEFAULT_SMOKE_PRESET_ID,
} from "../scripts/openclaw-duel-smoke-config.mjs";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("openclaw duel smoke config", () => {
	it("uses the checked-in objective beta preset on both sides", () => {
		const command = buildOpenClawDuelCommand({
			baseUrl: "http://127.0.0.1:3041",
			adminKey: "smoke-admin",
			runnerKey: "smoke-runner-key",
			runnerId: "smoke-runner",
		});

		expect(DEFAULT_SMOKE_PRESET_ID).toBe("objective_beta");
		expect(command.command).toBe("pnpm");
		expect(command.args).toContain("--strategyPresetA");
		expect(command.args[command.args.indexOf("--strategyPresetA") + 1]).toBe(
			"objective_beta",
		);
		expect(command.args).toContain("--strategyPresetB");
		expect(command.args[command.args.indexOf("--strategyPresetB") + 1]).toBe(
			"objective_beta",
		);
		expect(command.args).not.toContain("--strategyA");
		expect(command.args).not.toContain("--strategyB");
	});
});

describe("openclaw smoke failure artifacts", () => {
	it("persists match id, final snapshots, and a structured summary", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "fightclaw-smoke-artifacts-"));
		tempDirs.push(dir);

		const bundle = createSmokeArtifactBundle({
			dir,
			logFiles: {
				serverStdout: path.join(dir, "server.stdout.log"),
				serverStderr: path.join(dir, "server.stderr.log"),
				cliStdout: path.join(dir, "cli.stdout.log"),
				cliStderr: path.join(dir, "cli.stderr.log"),
			},
		});

		bundle.setMatchId("match-123");
		bundle.setFinalLogSnapshot({
			ok: true,
			status: 200,
			text: JSON.stringify({
				matchId: "match-123",
				events: [{ event: "match_ended" }],
			}),
			json: {
				matchId: "match-123",
				events: [{ event: "match_ended" }],
			},
		});
		bundle.setFinalStateSnapshot({
			ok: true,
			status: 200,
			text: JSON.stringify({
				state: { status: "ended", stateVersion: 9 },
			}),
			json: {
				state: { status: "ended", stateVersion: 9 },
			},
		});

		const written = await bundle.persistFailureArtifacts("Smoke failure.");

		expect(readFileSync(written.matchIdFile, "utf8")).toContain("match-123");
		expect(
			JSON.parse(readFileSync(written.finalLogFile, "utf8")),
		).toMatchObject({
			ok: true,
			status: 200,
			json: {
				matchId: "match-123",
				events: [{ event: "match_ended" }],
			},
		});
		expect(JSON.parse(readFileSync(written.summaryFile, "utf8"))).toMatchObject(
			{
				failureMessage: "Smoke failure.",
				matchId: "match-123",
				finalLogFile: written.finalLogFile,
				finalStateFile: written.finalStateFile,
			},
		);
	});
});
