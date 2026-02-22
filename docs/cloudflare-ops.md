# Cloudflare Operations Guardrails

## Canonical Worker

- Production API worker: `fightclaw-server-production`
- Production API domain: `https://api.fightclaw.com`
- Legacy worker `fightclaw-server` is deprecated and should remain deleted.

## Safe Deploy Command

Use the guarded deploy command from repo root:

```bash
pnpm run deploy:server:prod
```

This command enforces:

- Worker target must be `fightclaw-server-production`
- `/v1/system/version` must report `environment=production`
- `/v1/queue/status` must return `401` unauthenticated
- `/v1/admin/agents` must return `403` without admin key

## Drift Audit

Run:

```bash
pnpm run audit:cloudflare
```

This validates:

- Canonical worker deployment is reachable
- Legacy workers.dev endpoint returns `404`
- Legacy worker service is absent
