import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ArenaClient } from "@fightclaw/agent-client";
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
	| { phase: "joining_queue" };

export const DEFAULT_BETA_PRESET = "objective_beta";

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
	}
};

export const shouldUseLocalOperatorVerify = (input: {
	localOperatorVerify?: boolean;
	adminKey?: string;
}) => {
	return Boolean(input.localOperatorVerify);
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

	progress(formatBetaProgressEvent({ phase: "joining_queue" }));
	const queued = await testerClient.queueJoin();

	return {
		agentId: registered.agentId,
		apiKey: registered.apiKey,
		claimCode: registered.claimCode,
		name: registered.name,
		queueStatus: queued.status,
		queuedMatchId: queued.matchId,
		opponentId: queued.opponentId ?? null,
		selection: input.selection,
	};
};
