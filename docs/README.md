# Docs Guide

Use this folder for durable project documentation, not as the primary source of truth for every current implementation detail.

## Current Sources Of Truth

When docs disagree, prefer these in order:

1. [CONTRACTS.md](../CONTRACTS.md) for public request, response, and event shapes
2. [README.md](../README.md) for the current repo shape and workflow
3. [AGENTS.md](../AGENTS.md) and [`.claude/instructions/`](../.claude/instructions/) for contributor workflow and operating rules
4. `packages/db` migrations and current code for persisted/runtime behavior

## What Lives Here

- [cloudflare-ops.md](./cloudflare-ops.md): current Cloudflare deploy and audit guardrails
- [fightclaw-runtime-contract.md](./fightclaw-runtime-contract.md): current runner/helper/runtime boundary
- [`plans/`](./plans): historical slice design docs, RFCs, and implementation plans

## Historical Plan Docs

Files in [`docs/plans/`](./plans) are valuable history, but they are not automatically current policy.

- They often capture the repo as it existed on a specific date.
- Some describe approaches that were later hard-cut over or superseded.
- Some older files still mention temporary worktree paths that were relevant only during the slice that produced them.

When a plan conflicts with the current repo:

- treat the plan as historical context
- follow the later merged contract and code
- add a short note or path cleanup if the old plan is likely to mislead future sessions
