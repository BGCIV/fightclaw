import OpenAI from "openai";

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export type OpenRouterClientOptions = {
	apiKey: string;
	baseUrl?: string;
	// OpenRouter metadata headers (recommended).
	referer?: string;
	title?: string;
};

export function createOpenRouterClient(opts: OpenRouterClientOptions): OpenAI {
	// OpenRouter recommends sending these headers for attribution/analytics.
	const headers: Record<string, string> = {};
	if (opts.referer) headers["HTTP-Referer"] = opts.referer;
	if (opts.title) headers["X-Title"] = opts.title;

	return new OpenAI({
		apiKey: opts.apiKey,
		baseURL: opts.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL,
		defaultHeaders: headers,
	});
}

export function isOpenRouterBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return true; // default path uses OpenRouter
	try {
		const u = new URL(baseUrl);
		return u.host.includes("openrouter.ai");
	} catch {
		return baseUrl.includes("openrouter.ai");
	}
}
