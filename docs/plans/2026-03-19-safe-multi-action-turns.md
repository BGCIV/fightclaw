# Safe Multi-Action Turns Implementation Plan

Date: 2026-03-19

## Scope

Implement a bounded 2–3 action turn planner in the sim baseline lane and the
beta runner path. Keep engine rules, transports, and replay contracts unchanged.

## Guardrails

- Hard cutover only. No compatibility flags.
- Engine remains the sole source of legality and turn truth.
- Max action budget per player-turn: `3`.
- Re-evaluate after each accepted action.
- End turn early when no meaningful follow-up remains.
- Promotion requires better completion behavior than `objective_beta` without
  illegal-move or timeout regression.

## Task 1: Lock The Desired Behavior With Tests

Add focused RED tests for:

- sim planner produces multiple actions when a strong follow-up exists
- sim planner stops early when no follow-up clears threshold
- beta policy drains at most `3` actions in one engine turn
- beta policy ends with `end_turn` rather than low-value loops
- stale follow-up plans are discarded and legality is re-checked
- reporting captures:
  - actions per turn
  - one-action-turn rate
  - first kill turn
  - attack rate
  - objective-take rate
  - turn-limit ending rate

## Task 2: Add A Shared Policy-Shaped Planner In `apps/sim`

Implement a small planner utility that:

- ranks legal moves by continuation value
- simulates accepted moves against evolving state
- appends at most `3` actions
- stops on:
  - explicit `end_turn`
  - active-player change
  - terminal state
  - continuation score below threshold

Use this planner for the baseline mock-LLM presets instead of single-step move
selection.

## Task 3: Expand Sim Reporting

Extend match/reporting output to capture:

- accepted actions per player-turn
- one-action-turn count/rate
- attack count/rate
- objective-take count/rate
- meaningful ticker density proxy

Surface these in the baseline scoreboard and benchmark summary so the candidate
can be compared directly against `objective_beta`.

## Task 4: Apply The Same Bound To Beta Runner Policy

Update the beta/OpenClaw path so it can take up to `3` bounded actions in one
engine turn while keeping the existing one-move submit API.

Recommended implementation:

- beta-only move provider stores a small turn plan cache
- after each accepted move, it recomputes or validates the next step against the
  fresh match state
- it emits one public-safe commentary string per submitted move
- it stops cleanly with `end_turn` once the budget or continuation rule says to

Keep duel and generic runner behavior unchanged.

## Task 5: Benchmark Against `objective_beta`

Run controlled `apps/sim` comparisons on the default board/mirror lane and any
other decisive benchmark lane that already exists.

Primary decision metrics:

- lower turn-limit endings
- higher mean actions per turn
- lower one-action-turn rate
- earlier first kill
- stable or improved attack/objective-take rates
- no illegal-move regression

## Task 6: Minimal Production Validation

If sim gates are green:

- run one very small real beta validation
- confirm a real match completes a multi-action turn
- confirm commentary still flows correctly
- confirm no new timeout churn appears

Keep Cloudflare usage intentionally low.

## Verification

At minimum run:

- focused `apps/sim` unit tests
- focused `apps/openclaw-runner` tests
- relevant `check-types`
- focused benchmark or mass runs comparing candidate vs `objective_beta`

Only claim success from measured output, not from intended behavior.
