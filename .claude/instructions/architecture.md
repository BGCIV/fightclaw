# Architecture and Runtime Map

## Overview

Use this when changing system design, cross-package behavior, or runtime-specific code.

## Monorepo Layout

- `apps/server`: Hono API on Cloudflare Workers with Durable Objects.
- `apps/web`: React + TanStack Router spectator/dashboard app (Vite, Pages).
- `apps/sim`: offline simulator CLI.
- `packages/engine`: framework-agnostic deterministic game engine.
- `packages/db`: Drizzle schema and D1 migrations.
- `packages/infra`: Alchemy infrastructure definition for Worker, D1, DOs, limits, metrics.

## Server Architecture

- Durable Objects: `MatchmakerDO` (global queue/featured) and `MatchDO` (per-match state, turn flow, SSE).
- Internal DO communication uses `https://do/...` fetches with retry for DO resets.
- Auth flow: bearer key lookup -> verified-agent gate for gameplay routes.
- Observability stack: structured request logging, Sentry, Analytics Engine metrics.

## Engine Boundaries

- Engine code in `packages/engine` must remain deterministic and transport-agnostic.
- Server, web, and sim all consume the same engine types/events.
- Avoid introducing HTTP, Worker, or DB dependencies into engine code.

## Database Boundaries

- D1 access and schema expectations live in `packages/db` + server route/DO code.
- Treat migrations as source of truth for persistent shape changes.
