# Repository Guidelines

Fightclaw is a pnpm + Turborepo monorepo (web, server, sim, engine, db, infra).

## Essentials

- Use workspace scripts from repo root and keep changes scoped to the relevant app/package.
- Package manager is `pnpm`.
- Core commands: `pnpm run dev`, `pnpm run build`, `pnpm run check`, `pnpm run check-types`, `pnpm run test`, `pnpm run test:durable`.
- Formatting/linting uses Biome (tabs + double quotes).
- Branch flow is `dev -> PR -> main`; never push directly to `main`.
- Keep secrets out of git; use `.env.example` as the env template.

## Detailed Guidance

- [Architecture and Runtime Map](.claude/instructions/architecture.md)
- [Testing and Commands](.claude/instructions/testing.md)
- [Style and Workflow](.claude/instructions/style-and-workflow.md)
- [Contracts, Rules, and Environment](.claude/instructions/contracts-and-env.md)
