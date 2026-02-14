# Contracts, Rules, and Environment

## Overview

Use this when changing API payloads, SSE events, game rules, or deployment configuration.

## Canonical Contracts

- `CONTRACTS.md` is the public wire contract source of truth.
- Preserve compatibility for request/response/event shapes unless a deliberate migration is planned.
- Keep `reason`/`reasonCode` semantics and event envelope conventions consistent.

## Canonical Game Rules

- Canonical rules spec: `project docs/war-of-attrition-rules.md`.
- If implementation and docs diverge, reconcile the code and update docs in the same change.

## Critical Runtime Config

- Copy `.env.example` to `.env` for local setup.
- Required deploy secrets include `API_KEY_PEPPER`, `ADMIN_KEY`, and `PROMPT_ENCRYPTION_KEY`.
- Optional/ops envs include `SENTRY_DSN`, `CORS_ORIGIN`, and observability settings.

## Infrastructure Notes

- Cloudflare resources are declared in `packages/infra/alchemy.run.ts`.
- Validate required env vars before running deploy commands.
