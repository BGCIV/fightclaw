# Fightclaw Runtime Contract Design

## Goal

Create one canonical runtime-boundary document for the Fightclaw ecosystem so the skill/distribution layer, local execution helper layer, and authoritative Fightclaw server/engine layer all describe the same live contract.

## Recommended Approach

1. Canonical contract doc plus thin pointer updates. Recommended.
This creates one normative runtime artifact and updates the two highest-traffic surfaces to point at it. It removes practical ambiguity without widening into a repo-wide doc rewrite.

2. Canonical contract doc only.
This is lower effort, but it leaves the skill and README speaking in older language, which means two truths would still exist in practice.

3. Full docs cleanup across skill references, playbooks, READMEs, and plans.
This would eventually be cleaner, but it is too wide for the current need and would mix contract definition with general documentation editing.

## Why Approach 1

The downloadable skill and the runner README are both real product surfaces. The skill is the discovery/install boundary in the ClawHub/OpenClaw ecosystem, and the README is the operator/developer boundary. If the new contract lives only in a standalone doc, those entry points will keep teaching stale mental models.

The best narrow cut is:
- one precise canonical contract doc
- one short skill update that points to it and adopts the same runtime vocabulary
- one short runner README update that points to it and treats the contract as the source of truth

## Architecture

The contract should formalize three layers:

1. Distribution and instruction layer
ClawHub `SKILL.md` explains onboarding and how to invoke the local helper path. It should not define transport details or duplicate protocol specs.

2. Local execution layer
The Fightclaw helper/gateway owns compact state compilation, legal-move constrained choice, provider invocation, bounded turn planning, commentary best-effort behavior, and the deterministic fallback ladder.

3. Authority layer
The Fightclaw server/engine owns authoritative legality, AP/action budget, combat/economy/state transitions, and terminal conditions. No runner or skill logic changes game truth.

## Canonical Contract Sections

The new runtime contract doc should be normative and concise, covering:
- purpose and scope
- runtime roles and boundaries
- helper input contract
- helper output contract
- timing and continuation budget
- deterministic fallback ladder
- commentary rule and separation from move submission
- weak-box minimum completion guarantees
- what is deliberately out of scope

## Pointer Update Rules

`skills/fightclaw-arena/SKILL.md`
- keep user-facing onboarding flow
- remove or replace WS-primary/live transport language
- point live runtime details to the canonical contract
- keep the skill thin and orchestration-first

`apps/openclaw-runner/README.md`
- keep usage examples and operator entry points
- point runtime semantics to the canonical contract
- avoid duplicating wire/runtime rules beyond brief summaries

## Success Criteria

This branch is successful when:
- there is exactly one canonical runtime-boundary doc in the repo
- the skill points to it and no longer teaches stale WS-first language
- the runner README points to it as the runtime source of truth
- the branch does not widen into a general docs rewrite
