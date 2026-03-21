# Current API Phase and Replay Workflow

## Overview

Use this when touching API reliability work, simulator replay tooling, or `/dev` replay behavior.

## API Phase Status (as of 2026-02-18)

- API graduation contract is passing and considered complete for this phase.
- `api_smoke` and `api_full` each achieved 2 consecutive passes under the minimal contract.
- API phase is intentionally scope-frozen: avoid adding new API thresholds/optimization work unless production issues appear.

## Reliability Targets in Force

- illegal moves remain zero
- high completion rate
- bounded max-turn endings
- acceptable p95 match wall-clock

## Dev Replay Workflow

- `/dev` supports both `Sandbox` mode (local random/burst simulation) and `API Replay` mode (real API lane artifacts).
- Replay export bridge:
  - script: `apps/sim/scripts/export-web-replay.ts`
  - output: `apps/web/public/dev-replay/latest.json`
- Useful commands:
  - `pnpm -C apps/sim run export:web-replay`
  - `pnpm -C apps/sim run benchmark:v2:api_full:viz`
  - `pnpm -C apps/sim run benchmark:v2:api_smoke:viz`
- Recommended local loop:
  1. `pnpm run dev:server`
  2. `pnpm run dev:web`
  3. open `http://localhost:3001/dev`
  4. run one of the `*:viz` commands (or `export:web-replay`) to refresh replay data

## Notes

- Keep generated replay artifacts out of code commits unless explicitly requested.
- When server-side changes affect future tests, beta runs, or production validation, redeploy the Cloudflare Worker before relying on remote behavior. Production testing against a stale deployed worker can mask or create issues that do not match the current local code.
- For local `/dev` browser validation, treat the web app and the local server as a pair. Run both before checking replay or spectator behavior so UI validation does not silently fall back to a missing backend.
