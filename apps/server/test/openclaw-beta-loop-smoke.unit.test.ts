import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	buildOpenClawBetaTesterCommand,
	buildOpenClawHouseOpponentCommand,
	buildOpenClawOperatorVerifyCommand,
	createBetaLoopSmokeArtifactBundle,
	DEFAULT_SMOKE_PRESET_ID,
} from "../scripts/openclaw-beta-loop-smoke.mjs";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("openclaw beta smoke config", () => {
	it("builds the tester beta command with the real runner flow", () => {
		const command = buildOpenClawBetaTesterCommand({
			baseUrl: "http://127.0.0.1:3041",
			runnerKey: "smoke-runner-key",
			runnerId: "smoke-tester-runner",
		});

		expect(DEFAULT_SMOKE_PRESET_ID).toBe("objective_beta");
		expect(command.command).toBe("pnpm");
		expect(command.args).toEqual(
			expect.arrayContaining([
				"-C",
				"apps/openclaw-runner",
				"exec",
				"tsx",
				"src/cli.ts",
				"beta",
				"--baseUrl",
				"http://127.0.0.1:3041",
				"--runnerKey",
				"smoke-runner-key",
				"--runnerId",
				"smoke-tester-runner",
				"--strategyPreset",
				"objective_beta",
			]),
		);
		expect(command.args).toContain("--gatewayCmd");
		expect(command.args).toContain("--moveTimeoutMs");
	});

	it("builds the operator verify and house-opponent commands", () => {
		const verify = buildOpenClawOperatorVerifyCommand({
			baseUrl: "http://127.0.0.1:3041",
			claimCode: "ABCD-1234",
			adminKey: "smoke-admin",
		});
		const house = buildOpenClawHouseOpponentCommand({
			baseUrl: "http://127.0.0.1:3041",
			adminKey: "smoke-admin",
			runnerKey: "smoke-runner-key",
			runnerId: "smoke-house-runner",
		});

		expect(verify.command).toBe("pnpm");
		expect(verify.args).toEqual(
			expect.arrayContaining([
				"-C",
				"apps/agent-cli",
				"exec",
				"tsx",
				"src/cli.ts",
				"verify",
				"--claimCode",
				"ABCD-1234",
				"--adminKey",
				"smoke-admin",
			]),
		);

		expect(house.command).toBe("pnpm");
		expect(house.args).toEqual(
			expect.arrayContaining([
				"-C",
				"apps/openclaw-runner",
				"exec",
				"tsx",
				"src/cli.ts",
				"house-opponent",
				"--baseUrl",
				"http://127.0.0.1:3041",
				"--adminKey",
				"smoke-admin",
				"--runnerKey",
				"smoke-runner-key",
				"--runnerId",
				"smoke-house-runner",
				"--strategyPreset",
				"objective_beta",
			]),
		);
	});
});

describe("openclaw beta smoke failure artifacts", () => {
	it("persists agent identity, claim code, match id, featured url, and final snapshots", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "fightclaw-beta-smoke-"));
		tempDirs.push(dir);

		const bundle = createBetaLoopSmokeArtifactBundle({
			dir,
			logFiles: {
				serverStdout: path.join(dir, "server.stdout.log"),
				serverStderr: path.join(dir, "server.stderr.log"),
				testerStdout: path.join(dir, "tester.stdout.log"),
				testerStderr: path.join(dir, "tester.stderr.log"),
				operatorStdout: path.join(dir, "operator.stdout.log"),
				operatorStderr: path.join(dir, "operator.stderr.log"),
				houseStdout: path.join(dir, "house.stdout.log"),
				houseStderr: path.join(dir, "house.stderr.log"),
			},
		});

		bundle.setAgentId("agent-123");
		bundle.setClaimCode("ABCD-1234");
		bundle.setMatchId("match-789");
		bundle.setFeaturedUrl("https://fightclaw.com/?replayMatchId=match-789");
		bundle.setFinalFeaturedSnapshot({
			ok: true,
			status: 200,
			text: JSON.stringify({
				matchId: "match-789",
			}),
			json: {
				matchId: "match-789",
			},
		});
		bundle.setFinalLogSnapshot({
			ok: true,
			status: 200,
			text: JSON.stringify({
				matchId: "match-789",
				events: [{ event: "match_ended" }],
			}),
			json: {
				matchId: "match-789",
				events: [{ event: "match_ended" }],
			},
		});
		bundle.setFinalStateSnapshot({
			ok: true,
			status: 200,
			text: JSON.stringify({
				state: { status: "ended", stateVersion: 11 },
			}),
			json: {
				state: { status: "ended", stateVersion: 11 },
			},
		});

		const written = await bundle.persistFailureArtifacts(
			"Closed beta smoke failed.",
		);

		expect(readFileSync(written.agentIdFile, "utf8")).toContain("agent-123");
		expect(readFileSync(written.claimCodeFile, "utf8")).toContain("ABCD-1234");
		expect(readFileSync(written.matchIdFile, "utf8")).toContain("match-789");
		expect(readFileSync(written.featuredUrlFile, "utf8")).toContain(
			"https://fightclaw.com/?replayMatchId=match-789",
		);
		expect(
			JSON.parse(readFileSync(written.finalFeaturedFile, "utf8")),
		).toMatchObject({
			ok: true,
			status: 200,
			json: { matchId: "match-789" },
		});
		expect(JSON.parse(readFileSync(written.summaryFile, "utf8"))).toMatchObject(
			{
				failureMessage: "Closed beta smoke failed.",
				agentId: "agent-123",
				claimCode: "ABCD-1234",
				matchId: "match-789",
				featuredUrl: "https://fightclaw.com/?replayMatchId=match-789",
			},
		);
	});
});
