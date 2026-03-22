import alchemy from "alchemy";
import {
	AnalyticsEngineDataset,
	D1Database,
	DurableObjectNamespace,
	VersionMetadata,
	Worker,
} from "alchemy/cloudflare";
import { config } from "dotenv";

config({ path: "./.env" });
config({ path: "../../apps/server/.env" });

const envOrDefault = (name: string, fallback: string) =>
	alchemy.env(name, process.env[name] ?? fallback);

const app = await alchemy("fightclaw");

const db = await D1Database("database", {
	migrationsDir: "../../packages/db/src/migrations",
});

const matchmaker = DurableObjectNamespace("matchmaker", {
	className: "MatchmakerDO",
	sqlite: true,
});

const match = DurableObjectNamespace("match", {
	className: "MatchDO",
	sqlite: true,
});

const obs = AnalyticsEngineDataset("obs", {
	dataset: "FIGHTCLAW_OBS",
});

const versionMetadata = VersionMetadata();

export const server = await Worker("server", {
	name: "fightclaw-server-production",
	cwd: "../../apps/server",
	entrypoint: "src/index.ts",
	compatibility: "node",
	url: false,
	bindings: {
		DB: db,
		CORS_ORIGIN: envOrDefault("CORS_ORIGIN", ""),
		MATCHMAKING_ELO_RANGE: envOrDefault("MATCHMAKING_ELO_RANGE", "200"),
		MATCHMAKER_SHARDS: envOrDefault("MATCHMAKER_SHARDS", "1"),
		TURN_TIMEOUT_SECONDS: envOrDefault("TURN_TIMEOUT_SECONDS", "300"),
		API_KEY_PEPPER: alchemy.secret(process.env.API_KEY_PEPPER ?? ""),
		ADMIN_KEY: alchemy.secret(process.env.ADMIN_KEY ?? ""),
		INTERNAL_RUNNER_KEY: alchemy.secret(process.env.INTERNAL_RUNNER_KEY ?? ""),
		PROMPT_ENCRYPTION_KEY: alchemy.secret(
			process.env.PROMPT_ENCRYPTION_KEY ?? "",
		),
		SENTRY_ENVIRONMENT: envOrDefault("SENTRY_ENVIRONMENT", "production"),
		SENTRY_TRACES_SAMPLE_RATE: envOrDefault("SENTRY_TRACES_SAMPLE_RATE", "0"),
		CF_VERSION_METADATA: versionMetadata,
		OBS: obs,
		MATCHMAKER: matchmaker,
		MATCH: match,
	},
	dev: {
		port: 3000,
	},
});

console.log(`Server -> ${server.url ?? "workers.dev disabled"}`);

await app.finalize();
