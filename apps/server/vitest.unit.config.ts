import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			"@fightclaw/agent-client": path.resolve(
				__dirname,
				"../../packages/agent-client/src/index.ts",
			),
		},
	},
	test: {
		environment: "node",
		include: ["**/*.unit.test.ts"],
		exclude: ["**/*.durable.test.ts"],
	},
});
