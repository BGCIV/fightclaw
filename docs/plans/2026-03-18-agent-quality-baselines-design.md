# Agent Quality Baselines Design

Date: 2026-03-18

## Goal

Establish a small, fixed set of `hex_conquest` baseline agent profiles, compare them in `apps/sim` using the existing fast-lane and API spot-check workflow, choose one winner, and make that winner immediately usable as the beta-default strategy through the existing prompt version system.

## Why This Branch Exists

The platform path is finally stable enough that the next bottleneck is no longer transport reliability. The project now needs a reproducible answer to a product question: which agent behavior profile should represent Fightclaw in closed beta because it plays legal, timely, non-broken matches and produces watchable games?

This branch is intentionally not an engine-tuning or backend-default branch. It is a controlled profile-selection branch.

## Non-Goals

- No hidden server-side default logic.
- No gameplay rule changes or engine balance work.
- No protocol changes.
- No broad OpenClaw runner redesign.
- No homepage/projection cleanup beyond what is needed to validate the chosen preset in a real runner flow.

## Recommended Approach

Use `apps/sim` as the selection engine, then operationalize the winner through the existing strategy version flow.

This branch should land four concrete outputs:

1. A fixed baseline profile set for `hex_conquest`.
2. A compact, reproducible scoreboard/report from `apps/sim`.
3. A checked-in beta preset artifact for the winning profile.
4. One thin command path that publishes and activates that preset through the current strategy endpoints.

## Baseline Profiles

The initial set should stay small and intentionally distinct. The point is controlled comparison, not cleverness.

Recommended profiles:

- `balanced_beta`: steady pressure, values legal attacks, avoids stalls, moderate risk.
- `aggressive_beta`: pushes tempo, prefers combat and stronghold pressure.
- `defensive_beta`: preserves units, stabilizes around favorable trades and safe positioning.
- `objective_beta`: prioritizes node control, income pressure, and stronghold approach.
- `safe_fallback_beta`: conservative legal play, minimal flourish, optimized for low breakage.

These profiles should be represented as checked-in prompt/profile artifacts, not ad hoc strings embedded in benchmark commands.

## Source of Truth

### Selection

`apps/sim` remains the authoritative evaluation environment.

Use the existing fast-lane and API-lane split documented in `apps/sim/TESTING_HANDOFF.md`:

- Fast lane for volume and profile comparison using mock-LLM profiles.
- API spot-check for realism against the current reference model lane.

### Operationalization

The chosen winner should live in the existing strategy version system:

- create version
- list versions
- activate version
- fetch active strategy by game type

The server should continue to store and activate versions only. It must not silently decide the beta default at runtime.

## Artifact Model

Add a small checked-in preset directory for `hex_conquest` beta profiles. Each preset should include:

- stable preset id/name
- game type
- optional public persona
- private strategy text
- metadata describing intended style and provenance

This artifact is the reviewable source of truth for profile text. The publish/activate tool should read from this artifact rather than duplicating prompt strings in code.

## Scoreboard

The scoreboard should stay compact and decision-oriented.

Required signals:

- legal move rate
- timeout/forfeit rate
- average turn latency proxy
- average match length / turn count
- win distribution across the fixed matchup set
- spectator-usefulness proxy from existing behavior metrics

The spectator-usefulness proxy should reuse existing behavior metrics where possible instead of inventing a brand-new scoring system. Good candidates are action diversity, reduced draw/stall behavior, macro index, or terrain leverage signals already produced by `apps/sim`.

The output should be machine-readable and human-readable:

- one JSON scoreboard artifact for reproducibility
- one short Markdown summary naming the winner and the reasons

## Selection Rules

The winner should not be "best at everything." It should be "best beta default."

Selection guardrails:

- reject profiles with timeout/forfeit instability
- reject profiles with meaningful draw or stall regression
- reject profiles that collapse into obviously boring or broken play
- reject profiles that look good in fast lane but fail the API spot-check

Recommended tie-break order:

1. reliability
2. legality
3. bounded match pacing
4. watchability / behavior distinctness
5. overall matchup balance

## Thin Publish / Activate Path

The operational path should be one small tool, not new server behavior.

Recommended shape:

- a script or CLI subcommand that reads a checked-in preset
- posts it to `/v1/agents/me/strategy/:gameType`
- optionally activates it
- prints the created/activated version metadata

This path should be simple enough that the OpenClaw runner can use it directly in local smoke/duel flows without inventing another configuration layer.

## Real Validation

After the winner is selected and published, validate it through one real runner-facing flow:

- use the chosen preset instead of ad hoc `--strategyA/--strategyB` text
- run a real OpenClaw duel or smoke path
- confirm the live system still completes cleanly with the preset-backed strategy

This validation is not trying to prove strategic brilliance. It only proves the selected beta preset works in the real CLI/server path.

## Files Likely In Scope

- `apps/sim/src/cli.ts`
- `apps/sim/scripts/benchmark-v2.ts`
- `apps/sim/src/reporting/behaviorMetrics.ts`
- `apps/sim/src/reporting/dashboardGenerator.ts` if needed for scoreboard output
- `apps/openclaw-runner/src/cli.ts`
- `apps/server/src/routes/prompts.ts` only if a small client-facing helper contract needs alignment
- new checked-in preset artifacts under a small `hex_conquest` profile directory
- tests covering preset loading, scoreboard selection, and publish/activate flow

## Risks

### Mixed Causality

If this branch mixes engine tuning, prompt changes, and runner behavior changes, the result will be impossible to trust. Keep profiles fixed, compare them, choose one, operationalize it.

### Overfitting To Fast Lane

Mock-LLM screening is useful, but it cannot be the final truth. The API spot-check remains mandatory before naming a winner.

### Hidden Runtime Defaulting

If the server silently prefers one preset, prompt/version governance becomes muddy. Avoid this completely.

## Done State

This branch is done when:

1. `apps/sim` can evaluate a fixed set of 3–5 baseline profiles.
2. A compact scoreboard/report names one winner against the current baseline workflow.
3. The winning profile exists as a checked-in `hex_conquest` beta preset artifact.
4. There is one thin publish/activate path through the existing strategy endpoints.
5. One real OpenClaw duel/smoke run succeeds using the chosen preset rather than ad hoc prompt text.
