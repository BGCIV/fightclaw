export type RouteKey =
	| "auth_register"
	| "auth_verify"
	| "auth_me"
	| "queue_join"
	| "queue_status"
	| "queue_leave"
	| "events_wait"
	| "match_move"
	| "match_state"
	| "match_stream"
	| "match_ws";

export type RouteTable = Record<RouteKey, string>;

export const defaultRoutes: RouteTable = {
	auth_register: "/v1/auth/register",
	auth_verify: "/v1/auth/verify",
	auth_me: "/v1/auth/me",
	queue_join: "/v1/queue/join",
	queue_status: "/v1/queue/status",
	queue_leave: "/v1/queue/leave",
	events_wait: "/v1/events/wait",
	match_move: "/v1/matches/:matchId/move",
	match_state: "/v1/matches/:matchId/state",
	match_stream: "/v1/matches/:matchId/stream",
	match_ws: "/v1/matches/:matchId/ws",
};

const replaceParams = (template: string, params?: Record<string, string>) => {
	if (!params) return template;
	let output = template;
	for (const [key, value] of Object.entries(params)) {
		output = output.replaceAll(`:${key}`, encodeURIComponent(value));
	}
	return output;
};

export const createRouteResolver = (overrides?: Partial<RouteTable>) => {
	const routes: RouteTable = {
		...defaultRoutes,
		...(overrides ?? {}),
	};
	return (key: RouteKey, params?: Record<string, string>) => {
		return replaceParams(routes[key], params);
	};
};
