# Cloudflare Operations Guardrails

## Minimal Deploy Surface

- **Canonical pipeline:** run `pnpm run deploy` from the repo root. That script invokes `turbo -F @fightclaw/infra deploy`, which ultimately executes `packages/infra/alchemy.run.ts` to create/replace the `fightclaw-server-production` worker and its Cloudflare bindings (D1, durable objects, analytics dataset, version metadata, secrets, etc.).
- **Production guard rails:** run `pnpm run deploy:server:prod` to wrap the canonical pipeline. `scripts/deploy-server-production-guarded.sh` now simply enforces the canonical worker name and environment, calls `pnpm run deploy`, then validates `/v1/system/version`, `/v1/queue/status`, and `/v1/admin/agents/:id/disable` before printing the worker’s deployment status.

Do **not** run `pnpm -C apps/server exec wrangler deploy ...` or any other direct Wrangler deployment; the canonical `pnpm run deploy` path is the only allowed production deploy entry point. If you need to inspect worker status, use `pnpm -C apps/server exec wrangler deployments status --name fightclaw-server-production` from the guard or audit scripts only.

## Drift Audits and Legacy Cleanup

Run `pnpm run audit:cloudflare` (`scripts/cloudflare-audit-workers.sh`) whenever you want to prove the production surface remains hardened.

The audit enforces:

- Canonical worker deployment is present and has an active version.
- Deployed bindings/vars/secrets include the required production set.
- Secret inventory has no extras beyond the expected production keys.
- Production `/v1/system/version` reports `environment=production`.
- `/v1/queue/status` is `401` and `/v1/admin/agents/:id/disable` is `403` unauthenticated.
- Legacy `fightclaw-server` workers.dev endpoint is `404`.
- Canonical `fightclaw-server-production` workers.dev endpoint is `404` (`workers_dev = false`).
- Legacy worker service is absent.

Optional (CI-friendly) Pages inventory check:

- Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and the audit will assert exactly one Pages project named `fightclaw` exists in the account.
