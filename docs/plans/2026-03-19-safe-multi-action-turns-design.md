# Safe Multi-Action Turns Design

Date: 2026-03-19

## Summary

The current structural stall is no longer explained mainly by contact geometry.
The default-board mirror artifacts now show earlier contact, but matches still
frequently ride out to the engine turn limit because many turns are effectively:

- one `move` or `recruit`
- immediate `end_turn`

This slice targets that policy seam directly.

The engine remains authoritative and deterministic. No hidden runner behavior
changes game truth. Instead, the runner and sim bot layers should plan a small,
bounded sequence of legal actions for one player-turn, re-evaluate after each
accepted action, and stop early when there is no meaningful follow-up.

## What We Know

### Engine and runner evidence

- The engine already supports multi-action turns through AP and only changes
  active player when a turn is actually ended.
- The generic runner in `packages/agent-client` already loops within a turn and
  can submit multiple moves while the same agent remains active.
- The beta/OpenClaw flow still behaves like a one-decision planner because the
  gateway returns one move at a time and the beta policy is currently shaped to
  finish quickly rather than continue pressure.

### Simulation evidence

- `apps/sim` already has a batch-turn interface through `bot.chooseTurn` and
  `chooseTurnWithMeta`.
- The real LLM sim bot already supports ordered multi-command plans with
  legality re-checking after each accepted command.
- The baseline mock-LLM presets currently choose one move at a time, which
  makes them a good place to add a safe bounded turn planner.
- Structural diagnostics already capture contact/damage/kill timing, so this
  slice can add turn-depth metrics without inventing a separate reporting path.

### Product evidence

- The product value is not just correctness. We need agents that create
  readable, decisive, strategy-shaped matches.
- The relevant failure is now “low-value single-action turns that prolong the
  game,” not only “long spawn distance.”

## Goal

Implement a bounded multi-action turn policy for sim baselines and the beta
runner path that materially reduces turn-limit endings without regressing legal
move reliability or timeout behavior.

## Non-Goals

- Do not redesign the engine action system or AP rules.
- Do not change transports, streams, or replay contracts.
- Do not continue geometry or unit-stat tuning in this slice.
- Do not let the model freewheel through long action chains.
- Do not add backward-compatible policy flags to the main runtime path.

## Recommended Approach

### Option A: Bounded planner on existing turn seams

Add a safe turn planner that:

- caps each player-turn at 2–3 actions
- re-evaluates after each accepted action using fresh legal moves
- prefers a small ordered policy:
  - favorable attack or kill
  - objective capture or pressure
  - frontline recruit or reinforce
  - fortify a threatened valuable unit
  - advance toward enemy stronghold or decisive terrain
- stops when:
  - `end_turn` is chosen
  - the action budget is exhausted
  - the active player changes
  - the match becomes terminal
  - no candidate clears a continuation threshold

This is the recommended option.

### Option B: Prompt-only continuation

Tell the model to keep acting, but leave selection and stop conditions vague.
This is too soft for beta safety and would likely create longer sequences of bad
actions rather than better turn quality.

### Option C: More engine pacing changes

This remains valid long-term, but it is the wrong next slice. The recent sim
evidence says turn-depth and continuation policy are now the dominant limiter.

## Design

### 1. Safe turn planner in `apps/sim`

For the baseline mock-LLM presets, add a bounded turn planner that can choose a
small sequence instead of one move.

Key rules:

- Plan at most `3` actions.
- Simulate accepted actions against evolving legal moves.
- Never keep a stale plan after legality changes.
- Only continue if the next best move is above a minimum continuation score.
- Bias against recruit-only or reposition-only turns when a stronger follow-up
  exists.

This should live at the bot/policy layer, not in the engine.

### 2. Safe multi-action beta runner policy

The beta path should adopt the same bounded-turn idea without changing the
server submit contract.

Recommended shape:

- Keep one-move submit requests.
- Add a beta-only planner/cache that can drain up to `3` moves in one engine
  turn.
- Recompute or invalidate the remaining plan after every accepted move based on
  fresh match state.
- Use explicit stop conditions rather than implicit model whim.

This stays as a beta-policy hard cutover and does not change generic duel flow.

### 3. Prompt and continuation rules

Prompt wording should explicitly encode turn closure:

- do not end the turn after one merely safe action when there is a legal
  high-value follow-up
- prioritize attacks, objective pressure, frontline reinforcement, and
  stronghold approach over low-impact loops
- end the turn early when no follow-up clears the continuation threshold

The important part is not “be smarter.” It is “continue only when continuation
is justified.”

### 4. New pacing metrics

Add a compact reporting layer for:

- mean actions per player-turn
- percent of turns ending after exactly one action
- first kill turn
- attack rate
- objective-take rate
- turn-limit ending rate
- illegal move rate
- timeout proxy / runner regression where available
- a simple spectator proxy such as meaningful ticker density

The scoreboard should compare the candidate directly against `objective_beta`.

### 5. Promotion rule

Only promote the new policy if it does all of the following:

- reduces turn-limit endings or draw-heavy terminal outcomes
- increases actions per turn in a controlled way
- does not meaningfully increase illegal moves
- does not create timeout churn in the beta runner lane

If it fails those gates, we stop and keep the current beta-safe path.

## Success Criteria

This slice is successful when:

1. `apps/sim` can measure bounded turn-depth instead of only win/outcome shape.
2. A candidate safe multi-action policy exists for the baseline presets.
3. The beta runner path can execute 2–3-action turns without changing engine
   truth or the submit contract.
4. The candidate beats `objective_beta` on turn-limit endings or decisive
   completion while holding legal move reliability.
5. One very small production validation confirms the beta runner can finish a
   real multi-action turn without regressing commentary flow.

## Risks

### Plan drift

A planned follow-up can become stale after the first accepted move. The planner
must always re-check legality against fresh state.

### Action spam

If the continuation threshold is too low, agents will just do more junk faster.
The action budget and stop rules must stay hard and conservative.

### Sim/production mismatch

The sim planner and OpenClaw beta policy should be close in spirit, but the sim
lane remains the main truth-finding path. Production validation stays sparse.

## Initial Recommendation

Freeze geometry and most engine tuning. Implement one bounded multi-action turn
planner in sim and the beta runner path, compare it directly against
`objective_beta`, and only promote it if it reduces turn-limit endings without
increasing illegal or timeout failures.
