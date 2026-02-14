const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isJsonResponse = (response: Response) => {
	const contentType = response.headers.get("content-type") ?? "";
	return contentType.toLowerCase().includes("application/json");
};

export const adaptDoErrorEnvelope = async (response: Response) => {
	if (response.ok || !isJsonResponse(response)) return response;

	const body = (await response
		.clone()
		.json()
		.catch(() => null)) as unknown;
	if (!isRecord(body)) return response;
	if (body.ok === false) return response;
	if (typeof body.error !== "string") return response;

	const headers = new Headers(response.headers);
	headers.set("content-type", "application/json");
	return new Response(JSON.stringify({ ok: false, ...body }), {
		status: response.status,
		headers,
	});
};
