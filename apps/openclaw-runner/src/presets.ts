import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type HexConquestPresetArtifact = {
	id: string;
	displayName: string;
	gameType: "hex_conquest";
	publicPersona: string | null;
	privateStrategy: string;
};

export type StrategySelection = {
	publicPersona: string | null;
	privateStrategy: string;
	source:
		| {
				kind: "inline";
		  }
		| {
				kind: "preset";
				presetId: string;
		  };
};

const presetDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"sim",
	"presets",
	"hex_conquest",
);

export function loadHexConquestPreset(
	presetName: string,
): HexConquestPresetArtifact {
	const filePath = path.join(presetDir, `${presetName}.json`);
	if (!existsSync(filePath)) {
		throw new Error(`Unknown hex_conquest preset: ${presetName}`);
	}

	const parsed = JSON.parse(
		readFileSync(filePath, "utf-8"),
	) as Partial<HexConquestPresetArtifact>;

	if (
		parsed.id !== presetName ||
		parsed.gameType !== "hex_conquest" ||
		typeof parsed.displayName !== "string" ||
		typeof parsed.privateStrategy !== "string" ||
		!(typeof parsed.publicPersona === "string" || parsed.publicPersona === null)
	) {
		throw new Error(`Invalid hex_conquest preset artifact: ${presetName}`);
	}

	return {
		id: parsed.id,
		displayName: parsed.displayName,
		gameType: parsed.gameType,
		publicPersona: parsed.publicPersona,
		privateStrategy: parsed.privateStrategy,
	};
}

export function resolveStrategySelection(input: {
	side: "A" | "B";
	rawStrategy?: string;
	presetName?: string;
}): StrategySelection {
	const raw = input.rawStrategy?.trim();
	const presetName = input.presetName?.trim();
	const hasRaw = typeof raw === "string" && raw.length > 0;
	const hasPreset = typeof presetName === "string" && presetName.length > 0;

	if (Number(hasRaw) + Number(hasPreset) !== 1) {
		throw new Error(
			`Exactly one of --strategy${input.side} or --strategyPreset${input.side} is required.`,
		);
	}

	if (hasRaw && raw) {
		return {
			publicPersona: null,
			privateStrategy: raw,
			source: {
				kind: "inline",
			},
		};
	}

	if (hasPreset && presetName) {
		const preset = loadHexConquestPreset(presetName);
		return {
			publicPersona: preset.publicPersona,
			privateStrategy: preset.privateStrategy,
			source: {
				kind: "preset",
				presetId: preset.id,
			},
		};
	}

	throw new Error(
		`Exactly one of --strategy${input.side} or --strategyPreset${input.side} is required.`,
	);
}

export async function publishAgentStrategy(input: {
	baseUrl: string;
	apiKey: string;
	selection: StrategySelection;
}): Promise<unknown> {
	const res = await fetch(
		`${input.baseUrl}/v1/agents/me/strategy/hex_conquest`,
		{
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				authorization: `Bearer ${input.apiKey}`,
				"x-request-id": randomUUID(),
			},
			body: JSON.stringify({
				publicPersona: input.selection.publicPersona,
				privateStrategy: input.selection.privateStrategy,
				activate: true,
			}),
		},
	);
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed setting strategy prompt (${res.status}): ${body}`);
	}
	return (await res.json()) as unknown;
}
