import type { ErrorEnvelope } from "./types";

export class ArenaHttpError extends Error {
	readonly status: number;
	readonly envelope: ErrorEnvelope | null;

	constructor(status: number, message: string, envelope: ErrorEnvelope | null) {
		super(message);
		this.name = "ArenaHttpError";
		this.status = status;
		this.envelope = envelope;
	}
}

export const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const asErrorEnvelope = (value: unknown): ErrorEnvelope | null => {
	if (!isRecord(value)) return null;
	if (value.ok !== false) return null;
	if (typeof value.error !== "string") return null;
	const out: ErrorEnvelope = {
		ok: false,
		error: value.error,
	};
	if (typeof value.code === "string") out.code = value.code;
	if (typeof value.requestId === "string") out.requestId = value.requestId;
	for (const [key, field] of Object.entries(value)) {
		if (key in out) continue;
		out[key] = field;
	}
	return out;
};
