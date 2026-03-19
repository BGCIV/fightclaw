# Sim-First De-Stall Design

Date: 2026-03-19

## Summary

Fightclaw currently has two different failure classes that can look similar from the outside:

1. Real-agent turn execution failures, which show up in production as `turn_timeout`.
2. Structural pacing failures, which show up in simulation as `maxTurns` or draw-heavy endings.

This slice targets the second class first. The goal is to reduce structurally stalled matches in `hex_conquest` without widening Cloudflare production usage and without hiding the problem behind larger limits.

## What We Know

### Production evidence

- Recent real matches such as `03df6ee2-1dfc-41d8-ac05-3c883e6849dc` and `4c5779f1-c9ac-43ad-bf44-2d230161f515` ended with `turn_timeout` on turn 1.
- The homepage replay, ticker, result band, and public commentary correctly reflect the authoritative log for those matches.
- The public commentary lane is not the root cause of the timeout path. Commentary is entering through the runner and being rendered correctly.

### Simulation and engine evidence

- `apps/sim/DIAGNOSTICS_REPORT.md` already documents long path-to-contact and persistent `maxTurns` endings.
- `apps/sim/TESTING_HANDOFF.md` already warns against mixed-causality changes and recommends single-variable engine tuning.
- The engine default remains a `17x9` board with `40` turn limit.
- Starting units still begin at opposite ends of the board, which creates a long runway before decisive contact.
- The selected baseline preset `objective_beta` was accepted as the least stall-prone available profile, but its own artifact explicitly says the fixed baseline set remains draw-heavy overall.

## Goal

Produce one structural anti-stall change that improves decisive completion in sim and is cheap enough to validate with a very small number of production runs.

## Non-Goals

- Do not redesign transports, streams, or replay.
- Do not broaden agent intelligence work beyond what is necessary to validate a structural tuning change.
- Do not simply increase turn limits or timeout budgets as the primary fix.
- Do not rely on large numbers of production matches for diagnosis.

## Recommended Approach

### Option A: Sim-first structural diagnosis and tuning

Use `apps/sim` as the main truth-finding lane to isolate whether stalling is driven mainly by:

- spawn/contact geometry
- objective and income pressure
- combat lethality / unit stats

Then change one structural variable at a time, measure the effect, and only do a tiny production validation after a clear sim improvement appears.

This is the recommended option.

### Option B: Agent-policy-first

Keep the game mostly unchanged and try to make OpenClaw agents more decisive. This may help real matches, but it risks overfitting to one agent profile while leaving the core game structurally stall-prone.

### Option C: Limit-first

Increase turn limits or server timeouts so matches have more runway. This would cost more on Cloudflare and is more likely to mask than solve the problem.

## Design

### 1. Diagnostic-first sim lane

Before tuning any rule, add a compact diagnostic layer in `apps/sim` that can answer:

- turns to first contact
- turns to first damage
- turns to first kill
- terminal reason mix
- rough frontline distance trend over time

This should be cheap enough to run repeatedly in fast-lane benchmarks and useful enough to tell whether a candidate change is actually making the game converge.

### 2. Single-variable tuning order

Test structural levers in this order:

1. Spawn/contact geometry
2. Objective and income pressure
3. Unit stat tuning
4. Agent policy tweaks

Rationale:

- geometry affects every agent equally and is the most likely root cause of late contact
- objective pressure can force decisive play without making combat arbitrary
- unit stats should be changed only after geometry and incentives are understood
- agent policy should validate the tuned game, not carry it alone

### 3. Hard-cutover candidate selection

Pick one candidate at a time and treat it as a hard cutover in the sim lane. Do not add compatibility flags or preserve alternate behaviors in the main codepath.

Candidate examples:

- move starting armies inward
- increase central objective pressure
- reduce recruit-loop strength relative to board control

The first candidate should be geometry-focused unless diagnostics clearly prove otherwise.

### 4. Production-conservative validation

Once one candidate produces a clearly better sim profile, validate it with:

- one very small real-agent run
- one browser replay/featured check
- one authoritative log inspection

The purpose of production validation is confirmation, not discovery.

## Success Criteria

The slice is successful if it gives us all of the following:

- a reproducible sim diagnostic readout for structural stalling
- one chosen structural candidate backed by evidence, not guesswork
- improved decisive completion in the selected sim lanes
- a minimal production validation showing the change does not regress the real product path

## Risks

### Sim and production divergence

Real agents can still behave differently from benchmark agents. That is acceptable as long as the tuned change improves the game structure itself rather than depending on one agent policy.

### Mixed-causality

Changing map geometry, VP pressure, and unit stats together would make the result hard to trust. This slice must stay single-variable.

### Free-tier drift

Too many production validation runs will create Cloudflare cost pressure and noisy Durable Object usage. Keep production runs sparse and intentional.

## Initial Recommendation

Start with a geometry/contact diagnostic pass in `apps/sim`, then test one geometry-focused anti-stall change before touching stats or policy. The evidence gathered so far makes that the highest-probability lever.
