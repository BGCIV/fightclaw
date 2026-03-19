import { randomUUID } from "node:crypto";
import {
	ArenaClient,
	createRunnerSession,
	type RunMatchResult,
	runMatch,
} from "@fightclaw/agent-client";
import {
	bindRunnerAgent,
	createMoveProvider,
	InternalRunnerClient,
	resolveBetaStrategySelection,
	resolveHouseOpponentCommandOptions,
	runHouseOpponent,
	runTesterBetaJourney,
} from "./beta";
import { publishAgentStrategy, resolveStrategySelection } from "./presets";

type ArgMap = Record<string, string | boolean>;

const parseArgs = (
	argv: string[],
): { command: string | null; args: ArgMap } => {
	const [command, ...rest] = argv;
	const args: ArgMap = {};
	for (let i = 0; i < rest.length; i += 1) {
		const part = rest[i];
		if (!part?.startsWith("--")) continue;
		const key = part.slice(2);
		const next = rest[i + 1];
		if (!next || next.startsWith("--")) {
			args[key] = true;
			continue;
		}
		args[key] = next;
		i += 1;
	}
	return { command: command ?? null, args };
};

const asString = (value: string | boolean | undefined): string | undefined => {
	return typeof value === "string" ? value : undefined;
};

const asInt = (
	value: string | boolean | undefined,
	fallback: number,
): number => {
	if (typeof value !== "string") return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return parsed;
};

const usage = () => {
	console.log(
		[
			"Fightclaw OpenClaw Runner",
			"",
			"Commands:",
			"  beta --baseUrl <url> --name <agentName> --runnerKey <key> --runnerId <id> [--strategy <text> | --strategyPreset <name>] [--adminKey <key>] [--localOperatorVerify] [--verifyPollMs 1500] [--gatewayCmd '<cmd>'] [--moveTimeoutMs 4000]",
			"  house-opponent --baseUrl <url> --adminKey <key> --runnerKey <key> --runnerId <id> [--name <agentName>] [--strategyPreset <name>] [--gatewayCmd '<cmd>'] [--moveTimeoutMs 4000]",
			"  duel --baseUrl <url> --adminKey <key> --runnerKey <key> --runnerId <id> [--strategyA <text> | --strategyPresetA <name>] [--strategyB <text> | --strategyPresetB <name>] [--nameA a] [--nameB b] [--gatewayCmd '<cmd>'] [--gatewayCmdA '<cmd>'] [--gatewayCmdB '<cmd>'] [--moveTimeoutMs 4000]",
		].join("\n"),
	);
};

const runBeta = async (args: ArgMap) => {
	const baseUrl = asString(args.baseUrl) ?? "http://127.0.0.1:3000";
	const name = asString(args.name);
	if (!name) {
		throw new Error("beta requires --name");
	}

	const adminKey =
		asString(args.adminKey) ??
		(typeof process.env.ADMIN_KEY === "string"
			? process.env.ADMIN_KEY
			: undefined);

	const selection = resolveBetaStrategySelection({
		side: "A",
		rawStrategy: asString(args.strategy),
		presetName: asString(args.strategyPreset),
	});

	const runnerKey =
		asString(args.runnerKey) ??
		(typeof process.env.INTERNAL_RUNNER_KEY === "string"
			? process.env.INTERNAL_RUNNER_KEY
			: undefined);
	const runnerId =
		asString(args.runnerId) ??
		(typeof process.env.INTERNAL_RUNNER_ID === "string"
			? process.env.INTERNAL_RUNNER_ID
			: undefined);

	if (!runnerKey)
		throw new Error("--runnerKey or INTERNAL_RUNNER_KEY is required.");
	if (!runnerId)
		throw new Error("--runnerId or INTERNAL_RUNNER_ID is required.");

	await runTesterBetaJourney({
		baseUrl,
		name,
		selection,
		adminKey,
		localOperatorVerify: Boolean(args.localOperatorVerify),
		verifyPollMs: asInt(args.verifyPollMs, 1500),
		runnerKey,
		runnerId,
		gatewayCmd: asString(args.gatewayCmd),
		moveTimeoutMs: asInt(args.moveTimeoutMs, 4000),
	});
};

const runHouseOpponentCommand = async (args: ArgMap) => {
	const baseUrl = asString(args.baseUrl) ?? "http://127.0.0.1:3000";
	const adminKey =
		asString(args.adminKey) ??
		(typeof process.env.ADMIN_KEY === "string"
			? process.env.ADMIN_KEY
			: undefined);
	const runnerKey =
		asString(args.runnerKey) ??
		(typeof process.env.INTERNAL_RUNNER_KEY === "string"
			? process.env.INTERNAL_RUNNER_KEY
			: undefined);
	const runnerId =
		asString(args.runnerId) ??
		(typeof process.env.INTERNAL_RUNNER_ID === "string"
			? process.env.INTERNAL_RUNNER_ID
			: undefined);

	if (!adminKey) throw new Error("--adminKey or ADMIN_KEY is required.");
	if (!runnerKey)
		throw new Error("--runnerKey or INTERNAL_RUNNER_KEY is required.");
	if (!runnerId)
		throw new Error("--runnerId or INTERNAL_RUNNER_ID is required.");

	const result = await runHouseOpponent({
		...resolveHouseOpponentCommandOptions({
			baseUrl,
			name: asString(args.name),
			adminKey,
			runnerKey,
			runnerId,
			strategyPreset: asString(args.strategyPreset),
			gatewayCmd: asString(args.gatewayCmd),
			moveTimeoutMs: asInt(args.moveTimeoutMs, 4000),
		}),
		runMatchImpl: runMatch,
	});

	console.log(
		JSON.stringify(
			{
				agentId: result.agentId,
				matchId: result.matchId,
				terminalReason: result.terminalReason,
				winnerAgentId: result.winnerAgentId,
				loserAgentId: result.loserAgentId,
				source: result.selection.source,
			},
			null,
			2,
		),
	);
};

const runDuel = async (args: ArgMap) => {
	const baseUrl = asString(args.baseUrl) ?? "http://127.0.0.1:3000";
	const adminKey =
		asString(args.adminKey) ??
		(typeof process.env.ADMIN_KEY === "string"
			? process.env.ADMIN_KEY
			: undefined);
	const runnerKey =
		asString(args.runnerKey) ??
		(typeof process.env.INTERNAL_RUNNER_KEY === "string"
			? process.env.INTERNAL_RUNNER_KEY
			: undefined);
	const runnerId =
		asString(args.runnerId) ??
		(typeof process.env.INTERNAL_RUNNER_ID === "string"
			? process.env.INTERNAL_RUNNER_ID
			: undefined);
	const nameA = asString(args.nameA) ?? `openclaw-a-${Date.now()}`;
	const nameB = asString(args.nameB) ?? `openclaw-b-${Date.now()}`;
	const selectionA = resolveStrategySelection({
		side: "A",
		rawStrategy: asString(args.strategyA),
		presetName: asString(args.strategyPresetA),
	});
	const selectionB = resolveStrategySelection({
		side: "B",
		rawStrategy: asString(args.strategyB),
		presetName: asString(args.strategyPresetB),
	});
	const gatewayCmd = asString(args.gatewayCmd);
	const gatewayCmdA = asString(args.gatewayCmdA) ?? gatewayCmd;
	const gatewayCmdB = asString(args.gatewayCmdB) ?? gatewayCmd;
	const moveTimeoutMs = asInt(args.moveTimeoutMs, 4_000);

	if (!adminKey) throw new Error("--adminKey or ADMIN_KEY is required.");
	if (!runnerKey)
		throw new Error("--runnerKey or INTERNAL_RUNNER_KEY is required.");
	if (!runnerId)
		throw new Error("--runnerId or INTERNAL_RUNNER_ID is required.");

	const bootstrap = new ArenaClient({
		baseUrl,
		requestIdProvider: () => randomUUID(),
	});

	const registeredA = await bootstrap.register(nameA);
	const registeredB = await bootstrap.register(nameB);
	await bootstrap.verifyClaim(registeredA.claimCode, adminKey);
	await bootstrap.verifyClaim(registeredB.claimCode, adminKey);

	await bindRunnerAgent(baseUrl, runnerKey, runnerId, registeredA.agentId);
	await bindRunnerAgent(baseUrl, runnerKey, runnerId, registeredB.agentId);

	await publishAgentStrategy({
		baseUrl,
		apiKey: registeredA.apiKey,
		selection: selectionA,
	});
	await publishAgentStrategy({
		baseUrl,
		apiKey: registeredB.apiKey,
		selection: selectionB,
	});

	const runnerClientA = new InternalRunnerClient(
		baseUrl,
		registeredA.apiKey,
		runnerKey,
		runnerId,
		registeredA.agentId,
	);
	const runnerClientB = new InternalRunnerClient(
		baseUrl,
		registeredB.apiKey,
		runnerKey,
		runnerId,
		registeredB.agentId,
	);

	const sessionA = createRunnerSession(runnerClientA, {
		queueWaitTimeoutSeconds: 5,
	});
	const sessionB = createRunnerSession(runnerClientB, {
		queueWaitTimeoutSeconds: 5,
	});

	const [startedA, startedB] = await Promise.all([
		sessionA.start(),
		sessionB.start(),
	]);
	if (startedA.matchId !== startedB.matchId) {
		throw new Error(
			`Agent queues diverged: ${startedA.matchId} vs ${startedB.matchId}`,
		);
	}

	const moveProviderA = createMoveProvider(
		runnerClientA,
		registeredA.agentId,
		nameA,
		gatewayCmdA,
	);
	const moveProviderB = createMoveProvider(
		runnerClientB,
		registeredB.agentId,
		nameB,
		gatewayCmdB,
	);

	const [resultA, resultB]: [RunMatchResult, RunMatchResult] =
		await Promise.all([
			runMatch(runnerClientA, {
				moveProvider: moveProviderA,
				moveProviderTimeoutMs: moveTimeoutMs,
				session: sessionA,
			}),
			runMatch(runnerClientB, {
				moveProvider: moveProviderB,
				moveProviderTimeoutMs: moveTimeoutMs,
				session: sessionB,
			}),
		]);

	console.log(
		JSON.stringify(
			{
				matchId: startedA.matchId,
				runnerId,
				agents: [
					{ id: registeredA.agentId, name: nameA },
					{ id: registeredB.agentId, name: nameB },
				],
				results: [resultA, resultB],
			},
			null,
			2,
		),
	);
};

const main = async () => {
	const { command, args } = parseArgs(process.argv.slice(2));
	if (!command) {
		usage();
		process.exit(1);
	}
	if (command === "beta") {
		await runBeta(args);
		return;
	}
	if (command === "house-opponent") {
		await runHouseOpponentCommand(args);
		return;
	}
	if (command === "duel") {
		await runDuel(args);
		return;
	}
	usage();
	throw new Error(`Unknown command: ${command}`);
};

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exit(1);
});
