import { spawn } from "node:child_process";
import { type Move, MoveSchema } from "@fightclaw/engine";

type GatewayInput = {
	agentId?: string;
	agentName?: string;
	matchId?: string;
	stateVersion?: number;
	state?: unknown;
};

type GatewayOutput = {
	move: Move;
	publicThought?: string;
};

const FALLBACK_OUTPUT = {
	error: "Gateway unavailable; no valid move was produced.",
	publicThought:
		"Gateway unavailable; upstream fallback handling should choose a legal move.",
};

const readStdin = async () => {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	return Buffer.concat(chunks).toString("utf8").trim();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const safeJsonParse = (raw: string): unknown => {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
};

const normalize = (value: string | undefined) =>
	value?.trim().toLowerCase() ?? "";

const resolveSlot = (input: GatewayInput): "kai" | "mrsmith" | null => {
	const normalizedName = normalize(input.agentName);
	if (normalizedName.includes("kai")) return "kai";
	if (
		normalizedName.includes("mrsmith") ||
		normalizedName.includes("mr.smith") ||
		normalizedName.includes("smith")
	) {
		return "mrsmith";
	}

	const agentId = normalize(input.agentId);
	if (agentId && agentId === normalize(process.env.KAI_AGENT_ID)) return "kai";
	if (agentId && agentId === normalize(process.env.MRSMITH_AGENT_ID)) {
		return "mrsmith";
	}

	return null;
};

const resolveCommand = (slot: "kai" | "mrsmith" | null): string | null => {
	const fallback = process.env.DEFAULT_GATEWAY_CMD?.trim();
	if (slot === "kai")
		return process.env.KAI_GATEWAY_CMD?.trim() ?? fallback ?? null;
	if (slot === "mrsmith") {
		return process.env.MRSMITH_GATEWAY_CMD?.trim() ?? fallback ?? null;
	}
	return fallback ?? null;
};

const runGatewayCommand = async (
	command: string,
	inputRaw: string,
): Promise<GatewayOutput | null> => {
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

			const parsed = safeJsonParse(stdout.trim());
			if (!isRecord(parsed)) {
				resolve(null);
				return;
			}

			const parsedMove = MoveSchema.safeParse(parsed.move);
			if (!parsedMove.success) {
				resolve(null);
				return;
			}

			resolve({
				move: parsedMove.data,
				publicThought:
					typeof parsed.publicThought === "string"
						? parsed.publicThought
						: undefined,
			});
		});

		child.stdin.write(inputRaw);
		child.stdin.end();
	});
};

const main = async () => {
	const raw = await readStdin();
	if (!raw) {
		process.stdout.write(JSON.stringify(FALLBACK_OUTPUT));
		return;
	}

	const parsed = safeJsonParse(raw);
	const payload: GatewayInput = isRecord(parsed)
		? (parsed as GatewayInput)
		: {};
	const slot = resolveSlot(payload);
	const command = resolveCommand(slot);

	if (!command) {
		process.stdout.write(
			JSON.stringify({
				...FALLBACK_OUTPUT,
				publicThought: "No gateway command configured for this agent.",
			}),
		);
		return;
	}

	try {
		const out = await runGatewayCommand(command, raw);
		process.stdout.write(JSON.stringify(out ?? FALLBACK_OUTPUT));
	} catch (error) {
		console.error("gateway-openclaw-router: gateway command failed", {
			command,
			error,
		});
		process.stdout.write(JSON.stringify(FALLBACK_OUTPUT));
	}
};

void main();
