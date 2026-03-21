import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
	ArenaClient,
	createRunnerSession,
	type MoveProvider,
	type MoveProviderContext,
	type RunMatchResult,
	runMatch,
} from "@fightclaw/agent-client";
import { listLegalMoves, type Move } from "@fightclaw/engine";
import {
	bindRunnerAgent,
	InternalRunnerClient,
	resolveBetaStrategySelection,
	resolveHouseOpponentCommandOptions,
	revokeRunnerAgent,
	runHouseOpponent,
	runTesterBetaJourney,
} from "./beta";
import {
	buildMoveProviderTurnKey,
	movesMatchByIdentity,
	resolveEarlyEndTurnOverride,
	selectFinishFollowUpMove,
} from "./finishPressure";
import { selectPreferredLegalFallbackMove } from "./legalFallback";
import { MatchContextStore } from "./match-context";
import {
	fetchActiveAgentStrategy,
	publishAgentStrategy,
	resolveStrategySelection,
} from "./presets";

type ArgMap = Record<string, string | boolean>;

type GatewayMoveResult = {
	move: Move;
	publicThought?: string;
};

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
			"  duel --baseUrl <url> --adminKey <key> --runnerKey <key> --runnerId <id> [--strategyA <text> | --strategyPresetA <name>] [--strategyB <text> | --strategyPresetB <name>] [--nameA a] [--nameB b] [--gatewayCmd '<cmd>'] [--gatewayCmdA '<cmd>'] [--gatewayCmdB '<cmd>'] [--moveTimeoutMs 4000] [--singleActionTurns 1]",
			"  existing-duel --baseUrl <url> --adminKey <key> --runnerKey <key> --runnerId <id> --apiKeyA <key> --apiKeyB <key> [--nameA a] [--nameB b] [--gatewayCmd '<cmd>'] [--gatewayCmdA '<cmd>'] [--gatewayCmdB '<cmd>'] [--moveTimeoutMs 4000] [--singleActionTurns 1]",
		].join("\n"),
	);
};

type ExistingDuelInput = {
	baseUrl: string;
	adminKey: string;
	runnerKey: string;
	runnerId: string;
	apiKeyA: string;
	apiKeyB: string;
	nameA?: string;
	nameB?: string;
	gatewayCmdA?: string;
	gatewayCmdB?: string;
	moveTimeoutMs?: number;
	singleActionTurns?: boolean;
	runMatchImpl?: typeof runMatch;
};

const createExistingRunnerClient = async (input: {
	baseUrl: string;
	apiKey: string;
}) => {
	const bootstrapClient = new ArenaClient({
		baseUrl: input.baseUrl,
		agentApiKey: input.apiKey,
		requestIdProvider: () => randomUUID(),
	});
	const me = await bootstrapClient.me();
	return {
		agentId: me.agentId,
		agentName: me.name,
		apiKey: input.apiKey,
	};
};

const bindExistingRunnerClient = async (input: {
	baseUrl: string;
	apiKey: string;
	runnerKey: string;
	runnerId: string;
	agentId: string;
}) => {
	await bindRunnerAgent(
		input.baseUrl,
		input.runnerKey,
		input.runnerId,
		input.agentId,
	);
	return new InternalRunnerClient(
		input.baseUrl,
		input.apiKey,
		input.runnerKey,
		input.runnerId,
		input.agentId,
	);
};

const revokeExistingRunnerBindings = async (input: {
	baseUrl: string;
	runnerKey: string;
	runnerId: string;
	agentIds: string[];
}) => {
	await Promise.all(
		input.agentIds.map((agentId) =>
			revokeRunnerAgent(
				input.baseUrl,
				input.runnerKey,
				input.runnerId,
				agentId,
			).catch(() => undefined),
		),
	);
};

export const runExistingDuel = async (input: ExistingDuelInput) => {
	const moveTimeoutMs = input.moveTimeoutMs ?? 4_000;
	const runMatchImpl = input.runMatchImpl ?? runMatch;

	const [existingA, existingB] = await Promise.all([
		createExistingRunnerClient({
			baseUrl: input.baseUrl,
			apiKey: input.apiKeyA,
		}),
		createExistingRunnerClient({
			baseUrl: input.baseUrl,
			apiKey: input.apiKeyB,
		}),
	]);
	const [strategyA, strategyB] = await Promise.all([
		fetchActiveAgentStrategy({
			baseUrl: input.baseUrl,
			apiKey: input.apiKeyA,
		}),
		fetchActiveAgentStrategy({
			baseUrl: input.baseUrl,
			apiKey: input.apiKeyB,
		}),
	]);
	const runnerClientA = await bindExistingRunnerClient({
		baseUrl: input.baseUrl,
		apiKey: existingA.apiKey,
		runnerKey: input.runnerKey,
		runnerId: input.runnerId,
		agentId: existingA.agentId,
	});
	let runnerClientB: InternalRunnerClient;
	try {
		runnerClientB = await bindExistingRunnerClient({
			baseUrl: input.baseUrl,
			apiKey: existingB.apiKey,
			runnerKey: input.runnerKey,
			runnerId: input.runnerId,
			agentId: existingB.agentId,
		});
	} catch (error) {
		await revokeRunnerAgent(
			input.baseUrl,
			input.runnerKey,
			input.runnerId,
			existingA.agentId,
		).catch(() => undefined);
		throw error;
	}

	try {
		const matchContextStore = new MatchContextStore({
			baseUrl: input.baseUrl,
			adminKey: input.adminKey,
			onError: (error) => {
				console.warn(error.message);
			},
		});

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
			existingA.agentId,
			input.nameA ?? existingA.agentName,
			strategyA,
			matchContextStore,
			input.gatewayCmdA,
			{
				singleActionTurns: input.singleActionTurns,
				gatewayTimeoutMs: Math.max(1, moveTimeoutMs - 250),
			},
		);
		const moveProviderB = createMoveProvider(
			runnerClientB,
			existingB.agentId,
			input.nameB ?? existingB.agentName,
			strategyB,
			matchContextStore,
			input.gatewayCmdB,
			{
				singleActionTurns: input.singleActionTurns,
				gatewayTimeoutMs: Math.max(1, moveTimeoutMs - 250),
			},
		);

		const [resultA, resultB]: [RunMatchResult, RunMatchResult] =
			await Promise.all([
				runMatchImpl(runnerClientA, {
					moveProvider: moveProviderA,
					moveProviderTimeoutMs: moveTimeoutMs,
					resolveTimeoutFallbackMove:
						createCliTimeoutFallbackResolver(runnerClientA),
					session: sessionA,
				}),
				runMatchImpl(runnerClientB, {
					moveProvider: moveProviderB,
					moveProviderTimeoutMs: moveTimeoutMs,
					resolveTimeoutFallbackMove:
						createCliTimeoutFallbackResolver(runnerClientB),
					session: sessionB,
				}),
			]);

		return {
			matchId: startedA.matchId,
			runnerId: input.runnerId,
			agents: [
				{ id: existingA.agentId, name: input.nameA ?? existingA.agentName },
				{ id: existingB.agentId, name: input.nameB ?? existingB.agentName },
			],
			results: [resultA, resultB],
		};
	} catch (error) {
		await revokeExistingRunnerBindings({
			baseUrl: input.baseUrl,
			runnerKey: input.runnerKey,
			runnerId: input.runnerId,
			agentIds: [existingA.agentId, existingB.agentId],
		});
		throw error;
	}
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

const invokeGateway = async (
	command: string,
	input: {
		agentId: string;
		agentName: string;
		matchId: string;
		stateVersion: number;
		state: unknown;
		strategyPrompt: string;
		turnContext?: unknown;
	},
	timeoutMs: number,
): Promise<GatewayMoveResult | null> => {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, {
			shell: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			fn();
		};
		const onStdout = (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		};
		const onStderr = (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		};
		const onError = (error: Error) => {
			settle(() => reject(error));
		};
		const onClose = (code: number | null) => {
			if (code !== 0) {
				settle(() =>
					reject(
						new Error(
							`Gateway command failed (${code}). ${stderr.trim() || "No stderr."}`,
						),
					),
				);
				return;
			}
			try {
				const parsed = JSON.parse(stdout.trim()) as unknown;
				if (!parsed || typeof parsed !== "object") {
					settle(() => resolve(null));
					return;
				}
				const record = parsed as Record<string, unknown>;
				if (!record.move || typeof record.move !== "object") {
					settle(() => resolve(null));
					return;
				}
				settle(() =>
					resolve({
						move: record.move as Move,
						publicThought:
							typeof record.publicThought === "string"
								? record.publicThought
								: undefined,
					}),
				);
			} catch (error) {
				settle(() => reject(error));
			}
		};
		const timeout = setTimeout(
			() => {
				try {
					child.kill();
				} catch {
					// best-effort cleanup
				}
				settle(() =>
					reject(new Error(`Gateway command timed out after ${timeoutMs}ms.`)),
				);
			},
			Math.max(1, timeoutMs),
		);
		const cleanup = () => {
			clearTimeout(timeout);
			child.stdout.removeListener("data", onStdout);
			child.stderr.removeListener("data", onStderr);
			child.removeListener("error", onError);
			child.removeListener("close", onClose);
			child.stdin.removeAllListeners();
		};
		child.stdout.on("data", onStdout);
		child.stderr.on("data", onStderr);
		child.on("error", onError);
		child.on("close", onClose);
		child.stdin.write(JSON.stringify(input));
		child.stdin.end();
	});
};

const fallbackMove: Move = {
	action: "pass",
	reasoning: "Public-safe fallback: pass turn.",
};
const CLI_FINISH_ATTACK_REASONING =
	"Public-safe summary: continuing pressure with a legal attack before ending the turn.";
const CLI_FINISH_FOLLOW_UP_REASONING =
	"Public-safe summary: taking a legal follow-up before ending the turn.";
const TURN_COMPLETION_RESERVE_MS = 2_500;
const FOLLOW_UP_GATEWAY_TIMEOUT_MS = 5_000;

const selectCliFallbackMove = (
	state: Awaited<ReturnType<ArenaClient["getMatchState"]>>,
): Move | null => {
	const game = state.state?.game;
	if (!game || typeof game !== "object") return null;
	return selectPreferredLegalFallbackMove(
		listLegalMoves(game as Parameters<typeof listLegalMoves>[0]),
	);
};

const getRemainingTurnBudgetMs = (
	state: Awaited<ReturnType<ArenaClient["getMatchState"]>>,
) => {
	if (
		typeof state.turnExpiresAtMs !== "number" ||
		!Number.isFinite(state.turnExpiresAtMs)
	) {
		return null;
	}
	return Math.max(0, state.turnExpiresAtMs - Date.now());
};

const selectCliFollowUpMove = (legalMoves: Move[]) =>
	selectFinishFollowUpMove(legalMoves) ??
	selectPreferredLegalFallbackMove(legalMoves);

const selectLateTurnCompletionMove = (
	state: Awaited<ReturnType<ArenaClient["getMatchState"]>>,
	actionsTakenThisTurn: number,
) => {
	if (actionsTakenThisTurn <= 0) return selectCliFallbackMove(state);
	const game = state.state?.game;
	if (!game || typeof game !== "object") return selectCliFallbackMove(state);
	const legalMoves = listLegalMoves(
		game as Parameters<typeof listLegalMoves>[0],
	);
	return selectCliFollowUpMove(legalMoves);
};

const resolveEffectiveGatewayTimeoutMs = (input: {
	baseGatewayTimeoutMs: number;
	remainingTurnBudgetMs: number | null;
	actionsTakenThisTurn: number;
}) => {
	const followUpCappedTimeoutMs =
		input.actionsTakenThisTurn > 0
			? Math.min(input.baseGatewayTimeoutMs, FOLLOW_UP_GATEWAY_TIMEOUT_MS)
			: input.baseGatewayTimeoutMs;
	if (input.remainingTurnBudgetMs === null) return followUpCappedTimeoutMs;
	return Math.max(
		0,
		Math.min(
			followUpCappedTimeoutMs,
			input.remainingTurnBudgetMs - TURN_COMPLETION_RESERVE_MS,
		),
	);
};

const createCliTimeoutFallbackResolver =
	(client: ArenaClient) =>
	async ({ matchId }: MoveProviderContext): Promise<Move | null> => {
		const state = await client.getMatchState(matchId).catch(() => null);
		if (!state) return null;
		return selectCliFallbackMove(state);
	};

export const createMoveProvider = (
	client: ArenaClient,
	agentId: string,
	agentName: string,
	strategyPrompt: string,
	matchContextStore: MatchContextStore,
	gatewayCmd?: string,
	options?: {
		singleActionTurns?: boolean;
		gatewayTimeoutMs?: number;
		invokeGatewayImpl?: typeof invokeGateway;
	},
): MoveProvider => {
	let turnKey: string | null = null;
	let actionsTakenThisTurn = 0;
	const invokeGatewayImpl = options?.invokeGatewayImpl ?? invokeGateway;
	const resetTurnState = (nextTurnKey: string) => {
		turnKey = nextTurnKey;
		actionsTakenThisTurn = 0;
	};
	return {
		nextMove: async (context: MoveProviderContext) => {
			const { matchId, stateVersion } = context;

			// Use SSE-cached game if version matches (saves ~100ms HTTP round-trip)
			const useCache =
				context.lastKnownGame !== undefined &&
				context.lastKnownGameVersion === stateVersion;

			const state = useCache
				? {
						state: {
							stateVersion,
							status: "active" as const,
							game: context.lastKnownGame,
						},
					}
				: await client.getMatchState(matchId);

			const game = (state.state?.game ?? null) as {
				actionsRemaining?: number;
				turn?: number;
				activePlayer?: string;
			} | null;
			const nextTurnKey = buildMoveProviderTurnKey(matchId, game);
			if (turnKey !== nextTurnKey) {
				resetTurnState(nextTurnKey);
			}
			const legalMoves =
				game && typeof game === "object"
					? listLegalMoves(game as Parameters<typeof listLegalMoves>[0])
					: [];
			const remainingTurnBudgetMs = getRemainingTurnBudgetMs(state);
			if (
				options?.singleActionTurns &&
				typeof game?.actionsRemaining === "number" &&
				game.actionsRemaining <= 5
			) {
				return {
					action: "end_turn",
					reasoning:
						"Ending turn after one action for stable realtime cadence.",
				};
			}
			const effectiveGatewayTimeoutMs = resolveEffectiveGatewayTimeoutMs({
				baseGatewayTimeoutMs: options?.gatewayTimeoutMs ?? 4000,
				remainingTurnBudgetMs,
				actionsTakenThisTurn,
			});
			if (gatewayCmd && effectiveGatewayTimeoutMs <= 0) {
				const localCompletionMove = selectLateTurnCompletionMove(
					state,
					actionsTakenThisTurn,
				);
				if (localCompletionMove) {
					if (
						localCompletionMove.action !== "end_turn" &&
						localCompletionMove.action !== "pass"
					) {
						actionsTakenThisTurn += 1;
					}
					return {
						...localCompletionMove,
						reasoning: "Public-safe fallback: selected a clearly legal move.",
					};
				}
				return fallbackMove;
			}
			if (gatewayCmd) {
				let turnContext: unknown;
				try {
					turnContext = await matchContextStore.buildTurnContext({
						matchId,
						agentId,
						state,
					});
				} catch {
					turnContext = undefined;
				}
				try {
					const gateway = await invokeGatewayImpl(
						gatewayCmd,
						{
							agentId,
							agentName,
							matchId,
							stateVersion,
							state,
							strategyPrompt,
							...(turnContext === undefined ? {} : { turnContext }),
						},
						Math.max(1, effectiveGatewayTimeoutMs),
					);
					if (gateway?.move) {
						const chosenMove =
							legalMoves.find((candidate) =>
								movesMatchByIdentity(candidate, gateway.move),
							) ?? null;
						if (!chosenMove) {
							throw new Error(
								"Gateway returned a move outside the current legal set.",
							);
						}
						const thought =
							typeof gateway.publicThought === "string"
								? gateway.publicThought
								: "Public-safe summary unavailable.";
						const finishPressureOverride = resolveEarlyEndTurnOverride({
							chosenMove,
							legalMoves,
							actionsTakenThisTurn,
							minActionsBeforeEndTurn: 1,
						});
						if (finishPressureOverride) {
							if (
								finishPressureOverride.action !== "end_turn" &&
								finishPressureOverride.action !== "pass"
							) {
								actionsTakenThisTurn += 1;
							}
							return {
								...finishPressureOverride,
								reasoning:
									finishPressureOverride.action === "attack"
										? CLI_FINISH_ATTACK_REASONING
										: CLI_FINISH_FOLLOW_UP_REASONING,
							};
						}
						if (
							chosenMove.action !== "end_turn" &&
							chosenMove.action !== "pass"
						) {
							actionsTakenThisTurn += 1;
						}
						return {
							...chosenMove,
							reasoning: thought,
						};
					}
				} catch {
					const legalFallback = selectCliFallbackMove(state);
					if (legalFallback) {
						if (
							legalFallback.action !== "end_turn" &&
							legalFallback.action !== "pass"
						) {
							actionsTakenThisTurn += 1;
						}
						return {
							...legalFallback,
							reasoning: "Public-safe fallback: selected a clearly legal move.",
						};
					}
					return fallbackMove;
				}
			}
			const legalFallback = selectCliFallbackMove(state);
			if (legalFallback) {
				if (
					legalFallback.action !== "end_turn" &&
					legalFallback.action !== "pass"
				) {
					actionsTakenThisTurn += 1;
				}
				return {
					...legalFallback,
					reasoning: "Public-safe fallback: selected a clearly legal move.",
				};
			}
			return fallbackMove;
		},
	};
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
	const singleActionTurns = asString(args.singleActionTurns) === "1";

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
	const matchContextStore = new MatchContextStore({
		baseUrl,
		adminKey,
		onError: (error) => {
			console.warn(error.message);
		},
	});

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
		selectionA.privateStrategy,
		matchContextStore,
		gatewayCmdA,
		{
			singleActionTurns,
			gatewayTimeoutMs: Math.max(1, moveTimeoutMs - 250),
		},
	);
	const moveProviderB = createMoveProvider(
		runnerClientB,
		registeredB.agentId,
		nameB,
		selectionB.privateStrategy,
		matchContextStore,
		gatewayCmdB,
		{
			singleActionTurns,
			gatewayTimeoutMs: Math.max(1, moveTimeoutMs - 250),
		},
	);

	const [resultA, resultB]: [RunMatchResult, RunMatchResult] =
		await Promise.all([
			runMatch(runnerClientA, {
				moveProvider: moveProviderA,
				moveProviderTimeoutMs: moveTimeoutMs,
				resolveTimeoutFallbackMove:
					createCliTimeoutFallbackResolver(runnerClientA),
				session: sessionA,
			}),
			runMatch(runnerClientB, {
				moveProvider: moveProviderB,
				moveProviderTimeoutMs: moveTimeoutMs,
				resolveTimeoutFallbackMove:
					createCliTimeoutFallbackResolver(runnerClientB),
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

const runExistingDuelCommand = async (args: ArgMap) => {
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
	const apiKeyA = asString(args.apiKeyA);
	const apiKeyB = asString(args.apiKeyB);
	const gatewayCmd = asString(args.gatewayCmd);
	const gatewayCmdA = asString(args.gatewayCmdA) ?? gatewayCmd;
	const gatewayCmdB = asString(args.gatewayCmdB) ?? gatewayCmd;
	const moveTimeoutMs = asInt(args.moveTimeoutMs, 4_000);
	const singleActionTurns = asString(args.singleActionTurns) === "1";

	if (!adminKey) throw new Error("--adminKey or ADMIN_KEY is required.");
	if (!runnerKey)
		throw new Error("--runnerKey or INTERNAL_RUNNER_KEY is required.");
	if (!runnerId)
		throw new Error("--runnerId or INTERNAL_RUNNER_ID is required.");
	if (!apiKeyA) throw new Error("--apiKeyA is required.");
	if (!apiKeyB) throw new Error("--apiKeyB is required.");

	const result = await runExistingDuel({
		baseUrl,
		adminKey,
		runnerKey,
		runnerId,
		apiKeyA,
		apiKeyB,
		nameA: asString(args.nameA),
		nameB: asString(args.nameB),
		gatewayCmdA,
		gatewayCmdB,
		moveTimeoutMs,
		singleActionTurns,
	});

	console.log(JSON.stringify(result, null, 2));
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
	if (command === "existing-duel") {
		await runExistingDuelCommand(args);
		return;
	}
	usage();
	throw new Error(`Unknown command: ${command}`);
};

const isMainModule =
	typeof process.argv[1] === "string" &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
	main().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exit(1);
	});
}
