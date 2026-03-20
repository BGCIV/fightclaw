# Testing and Commands

## Overview

Use this when adding/refactoring code or validating behavior changes.

## Primary Commands

- Full workspace typecheck: `pnpm run check-types`
- Full workspace lint/format: `pnpm run check`
- Core server+engine lane: `pnpm run test`
- Fast server lane: `pnpm run test:server`
- Engine lane: `pnpm run test:engine`
- Sim lane: `pnpm run test:sim`
- Durable lane: `pnpm run test:durable`
- Durable smoke lane: `pnpm run test:durable:smoke`

## Single-Test Execution

- Server fast suite:
  - `pnpm -C apps/server test`
- Single fast test file:
  - `pnpm -C apps/server test -- test/events.unit.test.ts`
- Single durable file:
  - `pnpm -C apps/server test:durable -- test/durable/smoke.durable.test.ts`
- Sim suite:
  - `pnpm run test:sim`
- Focused sim files:
  - `pnpm run test:sim:files -- ./test/boardgameio.integration.test.ts ./test/cliUsage.test.ts`
- Root command note:
  - in fresh worktrees, run `pnpm install` before trusting root `pnpm run test:*` scripts
- Engine tests:
  - `pnpm run test:engine`

## Test Conventions

- `*.unit.test.ts`: fast Node lane.
- `*.durable.test.ts`: Miniflare Durable lane.
- `*.test.ts`: default suite coverage.

## Known Constraints

- Durable tests can intermittently fail with isolated-storage issues in Miniflare.
- `apps/sim` focused tests use Bun path-style file arguments, so prefer the package scripts above over ad hoc shell variants.
- Treat durable failures as best-effort unless explicitly required for gating.
