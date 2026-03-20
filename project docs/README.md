# Project Docs Guide

`project docs/` is the home for product- and rules-level documentation that should outlast individual implementation slices.

## Current Tracked Surface

The current committed source of truth in this folder is:

- [war-of-attrition-rules.md](./war-of-attrition-rules.md): canonical game-rules spec for the current 21x9 War of Attrition ruleset

## Authority Boundaries

When documents disagree, prefer:

1. [war-of-attrition-rules.md](./war-of-attrition-rules.md) for game rules
2. [CONTRACTS.md](../CONTRACTS.md) for API, event, and transport contracts
3. [README.md](../README.md) for current repo and product workflow
4. current engine/server code for implementation details

## About Older Design Material

You may also have local, non-tracked design files under `project docs/game design/`.

- Treat those as exploratory or historical unless they are explicitly promoted into tracked docs.
- They can be useful for inspiration and product thinking.
- They should not override the current canonical rules spec or repo contracts.
