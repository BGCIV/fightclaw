export const isDurableObjectResetError = (error: unknown) => {
	if (!error || typeof error !== "object") return false;
	const anyErr = error as { message?: unknown; durableObjectReset?: unknown };
	if (anyErr.durableObjectReset === true) return true;
	const message = typeof anyErr.message === "string" ? anyErr.message : "";
	return message.includes("invalidating this Durable Object");
};

export const doFetchWithRetry = async (
	stub: { fetch: (input: string, init?: RequestInit) => Promise<Response> },
	input: string,
	init?: RequestInit,
	retries = 2,
) => {
	let attempt = 0;
	for (;;) {
		try {
			return await stub.fetch(input, init);
		} catch (error) {
			if (attempt >= retries || !isDurableObjectResetError(error)) throw error;
			attempt += 1;
			await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
		}
	}
};
