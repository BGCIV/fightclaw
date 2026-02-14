# Style and Workflow

## Overview

Use this for implementation consistency, commit hygiene, and branch/PR flow.

## Style Rules

- Formatter/linter: Biome (not ESLint/Prettier).
- Formatting: tabs, double quotes.
- TypeScript: strict mode conventions; keep imports explicit and organized.
- Keep changes scoped to the target app/package in this monorepo.

## Git and Branch Rules

- Work on `dev` and open PRs to `main`.
- Do not push directly to `main`.
- Keep commit messages short, imperative, and optionally scoped (for example `server: ...`, `test(server): ...`).

## PR Expectations

- Include concise summary and test commands run.
- Include screenshots for UI-impacting changes.
- Merge only after preview deploy and checks are green.
