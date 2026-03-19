export const DEFAULT_SMOKE_PRESET_ID = "objective_beta";
export const DEFAULT_GATEWAY_CMD = "pnpm exec tsx scripts/gateway-move.ts";

export function buildOpenClawDuelCommand({
	baseUrl,
	adminKey,
	runnerKey,
	runnerId,
	moveTimeoutMs = 2000,
}) {
	return {
		command: "pnpm",
		args: [
			"-C",
			"apps/openclaw-runner",
			"exec",
			"tsx",
			"src/cli.ts",
			"duel",
			"--baseUrl",
			baseUrl,
			"--adminKey",
			adminKey,
			"--runnerKey",
			runnerKey,
			"--runnerId",
			runnerId,
			"--strategyPresetA",
			DEFAULT_SMOKE_PRESET_ID,
			"--strategyPresetB",
			DEFAULT_SMOKE_PRESET_ID,
			"--gatewayCmd",
			DEFAULT_GATEWAY_CMD,
			"--moveTimeoutMs",
			String(moveTimeoutMs),
		],
	};
}
