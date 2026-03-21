import {
	createMemoryHistory,
	createRootRouteWithContext,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export async function renderWithRouterToStaticMarkup(
	path: "/" | "/dev",
	element: ReactElement,
) {
	const rootRoute = createRootRouteWithContext<Record<string, never>>()({
		component: () => element,
	});
	const appRoute = createRoute({
		getParentRoute: () => rootRoute,
		path,
		component: () => <Outlet />,
	});
	const agentRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/agents/$agentId",
		component: () => null,
	});
	const routeTree = rootRoute.addChildren([appRoute, agentRoute]);
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({
			initialEntries: [path],
		}),
		context: {},
	});
	await router.load();

	return renderToStaticMarkup(<RouterProvider router={router} />);
}
