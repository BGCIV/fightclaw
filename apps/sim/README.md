# apps/sim — offline simulator and tournament runner

`apps/sim` runs local/offline Fightclaw matches using `@fightclaw/engine`.
It is for simulation, diagnostics, and bot iteration (not production runtime).

## Runners

`apps/sim` uses the `boardgameio` harness for all current simulator runs.

## Install and quick start

From repo root:

```bash
pnpm -C apps/sim install
```

Single match:

```bash
pnpm -C apps/sim exec tsx src/cli.ts single \
  --seed 1 \
  --maxTurns 200 \
  --bot1 aggressive \
  --bot2 mockllm \
  --scenario midfield
```

Tournament:

```bash
pnpm -C apps/sim exec tsx src/cli.ts tourney --games 200 --seed 1 --maxTurns 200
```

Mass simulation:

```bash
pnpm -C apps/sim exec tsx src/cli.ts mass --games 10000 --parallel 4 --output ./results
```

## Scratch probes

Ad-hoc diagnostics scripts live under `scripts/scratch/`:

```bash
pnpm -C apps/sim run scratch:test-game
pnpm -C apps/sim run scratch:test-llm
pnpm -C apps/sim run scratch:test-parse
```

## Simulation Flags

Use these with `single`, `tourney`, or `mass`:

- `--invalidPolicy skip|stop_turn|forfeit`
- `--moveValidationMode strict|relaxed`
- `--strict` (fail on harness divergence checks)
- `--artifactDir <path>` (default: `out/boardgameio`)
- `--storeFullPrompt true|false`
- `--storeFullOutput true|false`

Scenarios:

- `--scenario melee|ranged|stronghold_rush|midfield|all_infantry|all_cavalry|all_archer|infantry_archer|cavalry_archer|infantry_cavalry`

## Replay

Replay accepts current match logs and boardgame artifacts.

```bash
pnpm -C apps/sim exec tsx src/cli.ts replay --logFile ./path/to/log-or-artifact.json
```

## Outputs and where to inspect

### 1) Match/tournament stdout

CLI prints JSON summaries to stdout for piping and analysis.

### 2) Mass simulation stats

When using `mass` + `--output <dir>`, key files include:

- `<dir>/results.jsonl` (per-match results)
- `<dir>/summary.json` (aggregated stats)
- optional dashboard via:

```bash
pnpm -C apps/sim exec tsx src/cli.ts dashboard --input <dir> --output <dir>/dashboard.html
```

### 3) Boardgame harness artifacts

Boardgame harness writes deterministic per-match artifacts to:

- `out/boardgameio/` by default
- or custom `--artifactDir`

Artifacts include:

- seed, scenario, participants
- accepted/rejected move attempts
- accepted move list with state hashes (for replay)
- result/winner/reason
- optional prompt/model output metadata (if enabled)

### 4) Existing diagnostics collector (optional)

If `--diagnostics` is enabled, diagnostics are written under:

- `apps/sim/diagnostics/`

## Engine adapter contract

`src/engineAdapter.ts` must provide:

- `createInitialState(seed?, config?, players?)`
- `currentPlayer(state)`
- `isTerminal(state)`
- `winner(state)`
- `listLegalMoves(state)`
- `applyMove(state, move)`

Keep engine deterministic and transport-agnostic.
