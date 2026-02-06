# Fightclaw Project Memory

## Local Dev Setup Gotchas

- **CORS**: `apps/server/.env` must include `http://localhost:3001` in `CORS_ORIGIN` for the web dev server to talk to the API server
- **Secrets**: `apps/server/.env` must have `API_KEY_PEPPER`, `ADMIN_KEY`, `INTERNAL_RUNNER_KEY` — these are not inherited from root `.env`. Root `.env` has `API_KEY_PEPPER` and `ADMIN_KEY` but the server's wrangler dev only reads `apps/server/.env`
- **D1 Migrations**: Must be applied manually for local dev: `cd apps/server && ln -sf ../../packages/db/src/migrations migrations && npx wrangler d1 migrations apply --local fightclaw-database-dev`
- **Move schema**: Uses `targetHex` (not `to`) for move/attack actions. Invalid move schema causes forfeit
- **Port**: Server runs on 3000, web on 3001. Use `pnpm -w run dev:server` and `pnpm -w run dev:web` (not `pnpm run dev:server`)

## Branch Management
- Work happens on `dev` branch, PR to `main`
- Pre-push hook blocks direct pushes to `main`

## Test Lanes
- Engine: `pnpm -F @fightclaw/engine test` (Bun)
- Server unit: `pnpm -F server test` (Node + Vitest)
- Durable: `cd apps/server && node ./node_modules/vitest/vitest.mjs -c vitest.durable.config.ts --run <file>`
- Durable teardown noise (workerd "invalidating this Durable Object") is expected, not a bug
