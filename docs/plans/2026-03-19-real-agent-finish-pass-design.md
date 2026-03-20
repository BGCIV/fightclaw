# Real Agent Finish Pass Design

## Goal

Get one real production-style match to start and finish between two real runner
flows without touching engine rules or server contracts.

The target shape is narrow and honest:

- Kai remains the real tester-facing agent.
- Kai stays on the product-facing `objective_beta` profile.
- The operator-owned house opponent uses `safe_fallback_beta`.
- The only behavior changes live in the runner / gateway policy layer.

## Why This Shape

This keeps the branch aligned with current product reality instead of drifting
into a synthetic “easy mode” setup.

- `objective_beta` is still the product-facing beta profile.
- `safe_fallback_beta` is useful as a stabilizing opponent because it reduces
  opponent weirdness and keeps the debugging surface smaller.
- A house opponent is still the right match counterpart for this slice because
  it avoids doubling the number of real-agent runtimes while we focus on finish
  behavior.

## Recommended Approach

Tighten finish behavior only in the real beta runner path.

That means:

- leave engine authority alone
- leave server queue / match / replay contracts alone
- keep bounded multi-action turns
- strengthen continuation and stop rules so Kai does not take one acceptable
  move and bail when a legal finishing line is available
- explicitly tell the gateway prompt to take terminal lines when legal

## What Changes

### Kai Path

Kai keeps `objective_beta`, but gets a minimal finish-oriented overlay:

- prefer a legal terminal line immediately
- prefer favorable attack chains over passive economy once contact exists
- continue for up to the bounded action budget when follow-up pressure is real
- stop early when the remaining legal moves are only low-value drift

This should be implemented as a narrow overlay in the beta runner / gateway
prompt path, not as a new global preset or an engine rewrite.

### House Opponent Path

The house opponent switches to `safe_fallback_beta`.

That gives us:

- legal, stable, lower-weirdness opposition
- a smaller runtime-debugging surface
- a controlled counterpart for validating whether Kai can finish a match

This is intentionally a product-validation tool, not a new canonical beta
default.

## Non-Goals

This branch should not:

- retune map geometry
- retune unit stats or economy
- change server contracts
- change DO storage or replay behavior
- re-open prompt version selection as a broad baseline contest
- add always-on opponent infrastructure

## Validation Order

1. Sim probe:
   Kai-style `objective_beta + finish overlay` versus `safe_fallback_beta`
   should show fewer full-length endings than the current `objective_beta`
   mirror while preserving legality.
2. Local beta smoke:
   the real beta / house commands should complete cleanly with the new profile
   split and finish-oriented prompt path.
3. Real production runs:
   spend at most one or two production validations because DO usage is budgeted.

## Success Criteria

This slice is successful when all of the following are true:

1. Kai still runs through the same real beta flow.
2. The house opponent still runs through the same real house flow.
3. The only material behavior delta is finish-oriented turn planning.
4. Sim and local smoke both stay legal and stable.
5. At least one real production-style match between Kai and the house opponent
   finishes cleanly without timing out or stalling into a useless loop.

## Failure Criteria

Do not promote this pass if it:

- increases illegal moves
- increases timeout churn
- requires engine-side rule changes to look good
- only works when both sides are moved to `safe_fallback_beta`
