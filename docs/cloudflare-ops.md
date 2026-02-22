# Cloudflare Operations Guardrails

## Minimal Deploy Surface

- **Canonical pipeline:** run `pnpm run deploy` from the repo root. That script invokes `turbo -F @fightclaw/infra deploy`, which ultimately executes `packages/infra/alchemy.run.ts` to create/replace the `fightclaw-server-production` worker and its Cloudflare bindings (D1, durable objects, analytics dataset, version metadata, secrets, etc.).
- **Production guard rails:** run `pnpm run deploy:server:prod` to wrap the canonical pipeline. `scripts/deploy-server-production-guarded.sh` now simply enforces the canonical worker name and environment, calls `pnpm run deploy`, then validates `/v1/system/version`, `/v1/queue/status`, and `/v1/admin/agents/:id/disable` before printing the worker’s deployment status.

Do **not** run `pnpm -C apps/server exec wrangler deploy ...` or any other direct Wrangler deployment; the canonical `pnpm run deploy` path is the only allowed production deploy entry point. If you need to inspect worker status, use `pnpm -C apps/server exec wrangler deployments status --name fightclaw-server-production` from the guard or audit scripts only.

## Drift Audits and Legacy Cleanup

Run `pnpm run audit:cloudflare` (`scripts/cloudflare-audit-workers.sh`) whenever you want to prove the canonical deployment is reachable and the legacy `fightclaw-server` worker/service stays deleted. That script uses Wrangler to query deployments status, curls the production `/v1/system/version`, and ensures the legacy workers.dev endpoint responds with `404`.
