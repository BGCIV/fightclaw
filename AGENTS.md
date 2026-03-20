# Fightclaw Agent Guide

Fightclaw is a pnpm + Turborepo monorepo for an AI agent arena built from a Workers API, React web app, and deterministic engine.

## Quick Reference

- Package manager: `pnpm`
- Dev: `pnpm run dev`, `pnpm run dev:server`, `pnpm run dev:web`
- Build/deploy: `pnpm run build`, `pnpm run deploy`
- Quality/tests: `pnpm run check`, `pnpm run check-types`, `pnpm run test` (core server+engine lane), `pnpm run test:server`, `pnpm run test:engine`, `pnpm run test:sim`, `pnpm run test:durable`, `pnpm run test:durable:smoke`

## Universal Rules

- Run workspace scripts from repo root and keep changes scoped to the relevant app/package.
- Keep behavior deterministic and wire-compatible; update `CONTRACTS.md` for request, response, or event shape changes.
- Use Biome defaults: tabs and double quotes.
- Work in narrow slice branches/worktrees, merge into local `dev`, then push `origin/dev`; never push directly to `main`.
- Use the hard-cutover approach; do not add backward compatibility layers unless explicitly required.
- Keep secrets out of git and treat `.env.example` as the template.
- When server-side changes affect beta runs, replay checks, or production validation, redeploy the Cloudflare Worker before trusting remote results.

## Detailed Guidance

- [Architecture and Runtime Map](.claude/instructions/architecture.md)
- [Testing and Commands](.claude/instructions/testing.md)
- [Style and Workflow](.claude/instructions/style-and-workflow.md)
- [Contracts, Rules, and Environment](.claude/instructions/contracts-and-env.md)
- [Current API Phase and Replay Workflow](.claude/instructions/current-status-and-replay.md)
