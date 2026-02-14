import type { Context } from "hono";
import { z } from "zod";

import { badRequest } from "./httpErrors";

const uuidSchema = z.string().uuid();

export const parseUuidParam = (
	c: Context,
	name: string,
	label: string,
): { ok: true; value: string } | { ok: false; response: Response } => {
	const parsed = uuidSchema.safeParse(c.req.param(name));
	if (!parsed.success) {
		return { ok: false, response: badRequest(c, `${label} must be a UUID.`) };
	}
	return { ok: true, value: parsed.data };
};
