# Project Docs Guide

`project docs/` is the home for product- and rules-level documentation that should outlast individual implementation slices.

## Current Tracked Surface

The current committed reference in this folder is:

- [war-of-attrition-rules.md](./war-of-attrition-rules.md): current runtime rules reference for War of Attrition, aligned to the repo's present 17-column default runtime

## Authority Boundaries

When documents disagree, prefer:

1. current engine/server code for implementation details and active behavior
2. [CONTRACTS.md](../CONTRACTS.md) for API, event, and transport contracts
3. [README.md](../README.md) for current repo and product workflow
4. [war-of-attrition-rules.md](./war-of-attrition-rules.md) as the maintained project-doc companion

## About Older Design Material

You may also have local, non-tracked design files under `project docs/game design/`.

- Treat those as exploratory or historical unless they are explicitly promoted into tracked docs.
- They can be useful for inspiration and product thinking.
- They should not override the current repo behavior, tracked rules reference, or repo contracts.
