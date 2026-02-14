# Testing and Commands

## Overview

Use this when adding/refactoring code or validating behavior changes.

## Primary Commands

- Full workspace typecheck: `pnpm run check-types`
- Full workspace lint/format: `pnpm run check`
- Fast server lane: `pnpm run test`
- Durable lane: `pnpm run test:durable`

## Single-Test Execution

- Server fast suite:
  - `cd apps/server && node ./node_modules/vitest/vitest.mjs -c vitest.unit.config.ts --run`
- Single fast test file:
  - `cd apps/server && node ./node_modules/vitest/vitest.mjs -c vitest.unit.config.ts --run test/events.unit.test.ts`
- Single durable file:
  - `cd apps/server && VITEST_INCLUDE="test/durable/smoke.durable.test.ts" node ./scripts/run-durable-tests.mjs`
- Engine tests:
  - `cd packages/engine && bun test`

## Test Conventions

- `*.unit.test.ts`: fast Node lane.
- `*.durable.test.ts`: Miniflare Durable lane.
- `*.test.ts`: default suite coverage.

## Known Constraints

- Durable tests can intermittently fail with isolated-storage issues in Miniflare.
- Treat durable failures as best-effort unless explicitly required for gating.
