# Agent Quality Baseline Scoreboard

## Decision

`objective_beta` is the current beta-default winner for `hex_conquest`.

## Why It Won

- It won the first fixed-profile round robin in `apps/sim/results/hex_conquest_baselines_fastlane_a/scoreboard.json`.
- It won the heavier soak in `apps/sim/results/hex_conquest_baselines_fastlane_b/scoreboard.json`.
- It was the only preset that materially reduced stall behavior, holding `maxTurnsRate = 0.475` in both runs while the rest of the field stayed around `0.8063` to `0.8344`.
- It also led the field on composite score and spectator-usefulness proxy in both runs.

## Result Summary

### Run `hex_conquest_baselines_fastlane_a`

- Games: `400`
- Winner: `objective_beta`
- Composite score: `0.6072`
- Win rate: `0.1375`
- Max-turn rate: `0.475`

### Run `hex_conquest_baselines_fastlane_b`

- Games: `800`
- Winner: `objective_beta`
- Composite score: `0.6121`
- Win rate: `0.1594`
- Max-turn rate: `0.475`

## Why The Others Lost

- `defensive_beta`: safe but still stalled too often, with `maxTurnsRate = 0.8063` in the soak run.
- `safe_fallback_beta`: cleaner than most losers, but still heavily draw-bound at `maxTurnsRate = 0.8094`.
- `aggressive_beta`: did not convert tempo into enough decisive games and remained stall-heavy at `maxTurnsRate = 0.825`.
- `balanced_beta`: remained stable and clean, but did not solve the stall problem and ended at `maxTurnsRate = 0.8344`.

## Caveats

- The fixed baseline set is still globally draw-heavy: soak-run draw rate was `0.75`, so this branch selects the best current beta default rather than claiming the old sim gates now pass.
- No API spot-check was run in this branch because `LLM_API_KEY` / `OPENROUTER_API_KEY` were unavailable in the current environment and local `.env`.

## Operational Validation

- `pnpm run smoke:openclaw-duel` now runs the real OpenClaw duel CLI with `--strategyPresetA objective_beta --strategyPresetB objective_beta`.
- The representative local smoke run completed cleanly with `ok: true`, a real `matchId`, terminal `match_ended` in the canonical log, and final `stateVersion: 33`.
