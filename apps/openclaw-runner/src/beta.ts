import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	ArenaClient,
	createRunnerSession,
	type MoveProvider,
	type MoveProviderContext,
	runMatch,
} from "@fightclaw/agent-client";
import { listLegalMoves, type Move } from "@fightclaw/engine";
import {
	publishAgentStrategy,
	resolveStrategySelection,
	type StrategySelection,
} from "./presets";

type BetaPhase =
	| { phase: "registered" }
	| { phase: "agent_id"; agentId: string }
	| { phase: "claim_code"; claimCode: string }
	| { phase: "waiting_for_operator_verification" }
	| { phase: "verified" }
	| { phase: "publishing_preset" }
	| { phase: "joining_queue" }
	| { phase: "matched" };

export const DEFAULT_BETA_PRESET = "objective_beta";
export const DEFAULT_HOUSE_GATEWAY_CMD =
	"pnpm exec tsx scripts/gateway-move.ts";

type MoveSubmitEnvelope =
	| {
			ok: true;
			state: {
				stateVersion: number;
				status?: "active" | "ended";
				winnerAgentId?: string | null;
				endReason?: string;
			};
	  }
	| {
			ok: false;
			error: string;
			stateVersion?: number;
			forfeited?: boolean;
			matchStatus?: "ended";
			winnerAgentId?: string | null;
			reason?: string;
			reasonCode?: string;
	  };

type GatewayMoveResult = {
	move: Move;
	publicThought?: string;
};

export class InternalRunnerClient extends ArenaClient {
	private readonly internalBaseUrl: string;

	constructor(
		baseUrl: string,
		agentApiKey: string,
		private readonly runnerKey: string,
		private readonly runnerId: string,
		private readonly actingAgentId: string,
	) {
		super({
			baseUrl,
			agentApiKey,
			requestIdProvider: () => randomUUID(),
		});
		this.internalBaseUrl = baseUrl.replace(/\/+$/, "");
	}

	async submitMove(
		matchId: string,
		payload: {
			moveId: string;
			expectedVersion: number;
			move: unknown;
			publicThought?: string;
		},
	): Promise<MoveSubmitEnvelope> {
		const moveRecord =
			payload.move && typeof payload.move === "object"
				? (payload.move as Record<string, unknown>)
				: null;
		const publicThought =
			typeof payload.publicThought === "string"
				? payload.publicThought
				: typeof moveRecord?.reasoning === "string"
					? moveRecord.reasoning
					: undefined;
		const res = await fetch(
			`${this.internalBaseUrl}/v1/internal/matches/${encodeURIComponent(matchId)}/move`,
			{
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					"x-runner-key": this.runnerKey,
					"x-runner-id": this.runnerId,
					"x-agent-id": this.actingAgentId,
					"x-request-id": randomUUID(),
				},
				body: JSON.stringify({
					...payload,
					...(publicThought ? { publicThought } : {}),
				}),
			},
		);
		const body = (await res.json().catch(() => null)) as unknown;
		if (!body || typeof body !== "object") {
			throw new Error(`Invalid internal move response (${res.status}).`);
		}
		const envelope = body as Record<string, unknown>;
		if (envelope.ok === true) {
			return envelope as MoveSubmitEnvelope;
		}
		if (envelope.ok === false && typeof envelope.error === "string") {
			return envelope as MoveSubmitEnvelope;
		}
		throw new Error(`Unexpected internal move payload (${res.status}).`);
	}
}

export const bindRunnerAgent = async (
	baseUrl: string,
	runnerKey: string,
	runnerId: string,
	agentId: string,
) => {
	const res = await fetch(`${baseUrl}/v1/internal/runners/agents/bind`, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			"x-runner-key": runnerKey,
			"x-runner-id": runnerId,
			"x-request-id": randomUUID(),
		},
		body: JSON.stringify({ agentId }),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed binding runner->agent (${res.status}): ${body}`);
	}
};

export const invokeGateway = async (
	command: string,
	input: {
		agentId: string;
		agentName: string;
		matchId: string;
		stateVersion: number;
		state: unknown;
	},
): Promise<GatewayMoveResult | null> => {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, {
			shell: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code !== 0) {
				reject(
					new Error(
						`Gateway command failed (${code}). ${stderr.trim() || "No stderr."}`,
					),
				);
				return;
			}
			try {
				const parsed = JSON.parse(stdout.trim()) as unknown;
				if (!parsed || typeof parsed !== "object") {
					resolve(null);
					return;
				}
				const record = parsed as Record<string, unknown>;
				if (!record.move || typeof record.move !== "object") {
					resolve(null);
					return;
				}
				resolve({
					move: record.move as Move,
					publicThought:
						typeof record.publicThought === "string"
							? record.publicThought
							: undefined,
				});
			} catch (error) {
				reject(error);
			}
		});
		child.stdin.write(JSON.stringify(input));
		child.stdin.end();
	});
};

const fallbackMove: Move = {
	action: "pass",
	reasoning: "Public-safe fallback: pass turn.",
};

const selectLegalFallbackMove = (
	state: Awaited<ReturnType<ArenaClient["getMatchState"]>>,
): Move | null => {
	const game = state.state?.game;
	if (!game || typeof game !== "object") return null;
	const legalMoves = listLegalMoves(
		game as Parameters<typeof listLegalMoves>[0],
	);
	return legalMoves[0] ?? null;
};

export const createMoveProvider = (
	client: ArenaClient,
	agentId: string,
	agentName: string,
	gatewayCmd?: string,
): MoveProvider => ({
	nextMove: async ({ matchId, stateVersion }: MoveProviderContext) => {
		const state = await client.getMatchState(matchId);
		if (gatewayCmd) {
			const gateway = await invokeGateway(gatewayCmd, {
				agentId,
				agentName,
				matchId,
				stateVersion,
				state,
			});
			if (gateway?.move) {
				const thought =
					typeof gateway.publicThought === "string"
						? gateway.publicThought
						: "Public-safe summary unavailable.";
				return {
					...gateway.move,
					reasoning: thought,
				};
			}
		}
		const legalFallback = selectLegalFallbackMove(state);
		if (legalFallback) {
			return {
				...legalFallback,
				reasoning: "Public-safe fallback: selected the first legal move.",
			};
		}
		return fallbackMove;
	},
});

export const formatBetaProgressEvent = (event: BetaPhase): string => {
	switch (event.phase) {
		case "registered":
			return "registered";
		case "agent_id":
			return `agentId: ${event.agentId}`;
		case "claim_code":
			return `claimCode: ${event.claimCode}`;
		case "waiting_for_operator_verification":
			return "waiting for operator verification";
		case "verified":
			return "verified";
		case "publishing_preset":
			return "publishing preset";
		case "joining_queue":
			return "joining queue";
		case "matched":
			return "matched";
	}
};

export const shouldUseLocalOperatorVerify = (input: {
	localOperatorVerify?: boolean;
	adminKey?: string;
}) => {
	return Boolean(input.localOperatorVerify);
};

export const buildBetaHomepageUrl = (baseUrl: string) => {
	const url = new URL(baseUrl);
	if (url.hostname === "api.fightclaw.com") {
		url.hostname = "fightclaw.com";
		url.port = "";
		url.pathname = "/";
		url.search = "";
		url.hash = "";
		return url.toString();
	}
	if (
		(url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
		url.port === "3000"
	) {
		url.port = "3001";
		url.pathname = "/";
		url.search = "";
		url.hash = "";
		return url.toString();
	}
	url.pathname = "/";
	url.search = "";
	url.hash = "";
	return url.toString();
};

export const buildBetaMatchUrl = (baseUrl: string, matchId: string) => {
	const url = new URL(buildBetaHomepageUrl(baseUrl));
	url.searchParams.set("replayMatchId", matchId);
	return url.toString();
};

export const formatBetaSummaryLine = (label: string, value: string) => {
	return `${label}: ${value}`;
};

export const resolveHouseOpponentCommandOptions = (input: {
	baseUrl: string;
	name?: string;
	adminKey: string;
	runnerKey: string;
	runnerId: string;
	strategyPreset?: string;
	gatewayCmd?: string;
	moveTimeoutMs?: number;
	queueWaitTimeoutSeconds?: number;
	queueTimeoutMs?: number;
	streamReconnectDelayMs?: number;
}) => {
	const presetName = input.strategyPreset?.trim();
	return {
		baseUrl: input.baseUrl,
		name: input.name?.trim() || "HouseOpponent",
		adminKey: input.adminKey,
		runnerKey: input.runnerKey,
		runnerId: input.runnerId,
		selection: resolveBetaStrategySelection({
			side: "A",
			presetName: presetName && presetName.length > 0 ? presetName : undefined,
		}),
		gatewayCmd: input.gatewayCmd ?? DEFAULT_HOUSE_GATEWAY_CMD,
		moveTimeoutMs: input.moveTimeoutMs ?? 4000,
		queueWaitTimeoutSeconds: input.queueWaitTimeoutSeconds ?? 5,
		queueTimeoutMs: input.queueTimeoutMs ?? 10 * 60 * 1000,
		streamReconnectDelayMs: input.streamReconnectDelayMs ?? 250,
	};
};

export const resolveBetaStrategySelection = (input: {
	side: "A";
	rawStrategy?: string;
	presetName?: string;
}): StrategySelection => {
	const raw = input.rawStrategy?.trim();
	const presetName = input.presetName?.trim();
	const hasRaw = typeof raw === "string" && raw.length > 0;
	const hasPreset = typeof presetName === "string" && presetName.length > 0;

	if (hasRaw && hasPreset) {
		throw new Error(
			"Exactly one of --strategy or --strategyPreset may be provided.",
		);
	}

	if (hasRaw && raw) {
		return resolveStrategySelection({
			side: input.side,
			rawStrategy: raw,
		});
	}

	return resolveStrategySelection({
		side: input.side,
		presetName: hasPreset && presetName ? presetName : DEFAULT_BETA_PRESET,
	});
};

export const runTesterBetaOnboarding = async (input: {
	baseUrl: string;
	name: string;
	selection: StrategySelection;
	adminKey?: string;
	localOperatorVerify?: boolean;
	verifyPollMs?: number;
	joinQueue?: boolean;
	onProgress?: (line: string) => void;
}) => {
	const progress = input.onProgress ?? ((line: string) => console.log(line));
	const verifyPollMs = input.verifyPollMs ?? 1500;
	const bootstrap = new ArenaClient({
		baseUrl: input.baseUrl,
		requestIdProvider: () => randomUUID(),
	});

	const registered = await bootstrap.register(input.name);
	progress(formatBetaProgressEvent({ phase: "registered" }));
	progress(
		formatBetaProgressEvent({
			phase: "agent_id",
			agentId: registered.agentId,
		}),
	);
	progress(
		formatBetaProgressEvent({
			phase: "claim_code",
			claimCode: registered.claimCode,
		}),
	);

	const testerClient = new ArenaClient({
		baseUrl: input.baseUrl,
		agentApiKey: registered.apiKey,
		requestIdProvider: () => randomUUID(),
	});

	progress(
		formatBetaProgressEvent({
			phase: "waiting_for_operator_verification",
		}),
	);

	if (
		shouldUseLocalOperatorVerify({
			localOperatorVerify: input.localOperatorVerify,
			adminKey: input.adminKey,
		})
	) {
		if (!input.adminKey) {
			throw new Error(
				"Local operator verification requires --adminKey or ADMIN_KEY.",
			);
		}
		await bootstrap.verifyClaim(registered.claimCode, input.adminKey);
	} else {
		while (true) {
			const me = await testerClient.me();
			if (me.verified) break;
			await delay(verifyPollMs);
		}
	}

	progress(formatBetaProgressEvent({ phase: "verified" }));
	progress(formatBetaProgressEvent({ phase: "publishing_preset" }));
	await publishAgentStrategy({
		baseUrl: input.baseUrl,
		apiKey: registered.apiKey,
		selection: input.selection,
	});

	const shouldJoinQueue = input.joinQueue ?? true;
	let queued: {
		status: string;
		matchId?: string | null;
		opponentId?: string | null;
	} | null = null;
	if (shouldJoinQueue) {
		progress(formatBetaProgressEvent({ phase: "joining_queue" }));
		queued = await testerClient.queueJoin();
	}

	return {
		agentId: registered.agentId,
		apiKey: registered.apiKey,
		claimCode: registered.claimCode,
		name: registered.name,
		queueStatus: queued?.status ?? null,
		queuedMatchId: queued?.matchId ?? null,
		opponentId: queued?.opponentId ?? null,
		selection: input.selection,
	};
};

export const runTesterBetaJourney = async (input: {
	baseUrl: string;
	name: string;
	selection: StrategySelection;
	adminKey?: string;
	localOperatorVerify?: boolean;
	verifyPollMs?: number;
	runnerKey: string;
	runnerId: string;
	gatewayCmd?: string;
	moveTimeoutMs?: number;
	onProgress?: (line: string) => void;
	runMatchImpl?: typeof runMatch;
}) => {
	const progress = input.onProgress ?? ((line: string) => console.log(line));
	const onboarding = await runTesterBetaOnboarding({
		baseUrl: input.baseUrl,
		name: input.name,
		selection: input.selection,
		adminKey: input.adminKey,
		localOperatorVerify: input.localOperatorVerify,
		verifyPollMs: input.verifyPollMs,
		joinQueue: false,
		onProgress: progress,
	});

	await bindRunnerAgent(
		input.baseUrl,
		input.runnerKey,
		input.runnerId,
		onboarding.agentId,
	);

	const runnerClient = new InternalRunnerClient(
		input.baseUrl,
		onboarding.apiKey,
		input.runnerKey,
		input.runnerId,
		onboarding.agentId,
	);
	const session = createRunnerSession(runnerClient, {
		queueWaitTimeoutSeconds: 5,
	});
	progress(formatBetaProgressEvent({ phase: "joining_queue" }));
	const started = await session.start();
	progress(formatBetaProgressEvent({ phase: "matched" }));
	const homepageUrl = buildBetaHomepageUrl(input.baseUrl);
	const matchUrl = buildBetaMatchUrl(input.baseUrl, started.matchId);
	progress(formatBetaSummaryLine("matchId", started.matchId));
	progress(formatBetaSummaryLine("match URL", matchUrl));
	progress(formatBetaSummaryLine("homepage URL", homepageUrl));

	const runMatchImpl = input.runMatchImpl ?? runMatch;
	const result = await runMatchImpl(runnerClient, {
		moveProvider: createMoveProvider(
			runnerClient,
			onboarding.agentId,
			onboarding.name,
			input.gatewayCmd,
		),
		moveProviderTimeoutMs: input.moveTimeoutMs,
		session,
	});

	const matchId = result.matchId || started.matchId;
	progress(formatBetaSummaryLine("final status", result.reason));

	return {
		agentId: onboarding.agentId,
		matchId,
		homepageUrl,
		matchUrl,
		finalStatus: result.reason,
		winnerAgentId: result.winnerAgentId,
		loserAgentId: result.loserAgentId,
		selection: onboarding.selection,
	};
};

export const runHouseOpponent = async (input: {
	baseUrl: string;
	name?: string;
	adminKey: string;
	runnerKey: string;
	runnerId: string;
	strategyPreset?: string;
	gatewayCmd?: string;
	moveTimeoutMs?: number;
	queueWaitTimeoutSeconds?: number;
	queueTimeoutMs?: number;
	streamReconnectDelayMs?: number;
	onProgress?: (line: string) => void;
	runMatchImpl?: typeof runMatch;
}) => {
	const progress = input.onProgress ?? ((line: string) => console.log(line));
	const resolved = resolveHouseOpponentCommandOptions(input);
	const bootstrap = new ArenaClient({
		baseUrl: resolved.baseUrl,
		requestIdProvider: () => randomUUID(),
	});

	const registered = await bootstrap.register(resolved.name);
	progress(formatBetaProgressEvent({ phase: "registered" }));
	progress(
		formatBetaProgressEvent({
			phase: "agent_id",
			agentId: registered.agentId,
		}),
	);
	progress(
		formatBetaProgressEvent({
			phase: "claim_code",
			claimCode: registered.claimCode,
		}),
	);

	await bootstrap.verifyClaim(registered.claimCode, resolved.adminKey);
	progress(formatBetaProgressEvent({ phase: "verified" }));
	progress(formatBetaProgressEvent({ phase: "publishing_preset" }));
	await publishAgentStrategy({
		baseUrl: resolved.baseUrl,
		apiKey: registered.apiKey,
		selection: resolved.selection,
	});

	await bindRunnerAgent(
		resolved.baseUrl,
		resolved.runnerKey,
		resolved.runnerId,
		registered.agentId,
	);

	progress(formatBetaProgressEvent({ phase: "joining_queue" }));
	const runnerClient = new InternalRunnerClient(
		resolved.baseUrl,
		registered.apiKey,
		resolved.runnerKey,
		resolved.runnerId,
		registered.agentId,
	);
	const session = createRunnerSession(runnerClient, {
		queueWaitTimeoutSeconds: resolved.queueWaitTimeoutSeconds,
		queueTimeoutMs: resolved.queueTimeoutMs,
		streamReconnectDelayMs: resolved.streamReconnectDelayMs,
	});
	const started = await session.start();
	const runMatchImpl = input.runMatchImpl ?? runMatch;
	const result = await runMatchImpl(runnerClient, {
		moveProvider: createMoveProvider(
			runnerClient,
			registered.agentId,
			resolved.name,
			resolved.gatewayCmd,
		),
		moveProviderTimeoutMs: resolved.moveTimeoutMs,
		session,
	});

	return {
		agentId: registered.agentId,
		apiKey: registered.apiKey,
		claimCode: registered.claimCode,
		name: registered.name,
		queuedMatchId: started.matchId,
		opponentId: started.opponentId ?? null,
		gatewayCmd: resolved.gatewayCmd,
		selection: resolved.selection,
		matchId: result.matchId,
		terminalReason: result.reason,
		winnerAgentId: result.winnerAgentId,
		loserAgentId: result.loserAgentId,
	};
};
