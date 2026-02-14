import type { Context } from "hono";

type AnyContext = Context;

export const badRequest = (c: AnyContext, error: string) => {
	return c.json({ ok: false, error }, 400);
};

export const notFound = (c: AnyContext, error: string) => {
	return c.json({ ok: false, error }, 404);
};

export const conflict = (c: AnyContext, error: string) => {
	return c.json({ ok: false, error }, 409);
};

export const unauthorized = (c: AnyContext) => {
	return c.text("Unauthorized", 401);
};

export const forbidden = (c: AnyContext) => {
	return c.text("Forbidden", 403);
};

export const tooManyRequests = (c: AnyContext) => {
	return c.text("Too Many Requests", 429);
};

export const internalServerError = (
	c: AnyContext,
	error: string,
	extra?: Record<string, unknown>,
) => {
	return c.json({ ok: false, error, ...(extra ?? {}) }, 500);
};

export const serviceUnavailable = (
	c: AnyContext,
	error: string,
	extra?: Record<string, unknown>,
) => {
	return c.json({ ok: false, error, ...(extra ?? {}) }, 503);
};
