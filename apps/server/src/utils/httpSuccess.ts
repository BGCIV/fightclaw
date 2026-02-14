import type { Context } from "hono";

type AnyContext = Context;

export const success = (c: AnyContext, payload: Record<string, unknown>) => {
	return c.json({ ok: true, ...payload });
};

export const created = (c: AnyContext, payload: Record<string, unknown>) => {
	return c.json({ ok: true, ...payload }, 201);
};
