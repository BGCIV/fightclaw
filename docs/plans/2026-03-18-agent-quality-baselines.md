# Agent Quality Baselines Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Select a reproducible `hex_conquest` beta-default agent profile from a fixed baseline set, publish it through the existing strategy version system, and validate it in a real OpenClaw runner flow.

**Architecture:** `apps/sim` remains the selection engine. Fixed checked-in profile presets feed the benchmark/scoreboard path, a small publish tool operationalizes the winner through the existing prompt endpoints, and one real runner validation proves the selected preset works outside the simulator. No server-side hidden default logic is added.

**Tech Stack:** TypeScript, pnpm workspace scripts, Bun tests in `apps/sim`, existing server prompt routes, OpenClaw runner CLI, JSON/Markdown artifact output.

---

## Tasks

### Task 1: Add checked-in `hex_conquest` baseline presets

**Files:**
- Create: `apps/sim/src/presets/hexConquestBaselines.ts`
- Create: `apps/sim/test/hexConquestBaselines.test.ts`
- Modify: `apps/sim/src/cli.ts`

**Step 1: Write the failing preset test**

Add a test that asserts:

- exactly 3–5 named presets exist
- each preset has stable id/name metadata
- each preset has `gameType === "hex_conquest"`
- each preset contains non-empty `privateStrategy`

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm -C apps/sim test -- test/hexConquestBaselines.test.ts
```

Expected: FAIL because the preset module does not exist yet.

**Step 3: Write minimal preset implementation**

Create a small typed preset registry that exports the baseline set:

- `balanced_beta`
- `aggressive_beta`
- `defensive_beta`
- `objective_beta`
- `safe_fallback_beta`

Keep prompt text fixed and intentionally distinct. Do not add dynamic generation.

**Step 4: Wire a minimal CLI read path**

Update `apps/sim/src/cli.ts` so preset metadata can be loaded by name in later tasks without duplicating strategy text.

**Step 5: Run targeted tests**

Run:

```bash
pnpm -C apps/sim test -- test/hexConquestBaselines.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/sim/src/presets/hexConquestBaselines.ts apps/sim/test/hexConquestBaselines.test.ts apps/sim/src/cli.ts
git commit -m "feat(sim): add hex conquest baseline presets"
```

### Task 2: Add a reproducible baseline scoreboard path in `apps/sim`

**Files:**
- Modify: `apps/sim/scripts/benchmark-v2.ts`
- Create: `apps/sim/src/reporting/baselineScoreboard.ts`
- Create: `apps/sim/test/baselineScoreboard.test.ts`
- Optionally modify: `apps/sim/src/reporting/behaviorMetrics.ts`

**Step 1: Write the failing scoreboard test**

Add a test covering a minimal benchmark input and asserting the scoreboard:

- computes legal move / illegal move signal
- records forfeit or timeout rate
- records mean turns
- records win distribution
- produces a stable winner selection

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm -C apps/sim test -- test/baselineScoreboard.test.ts
```

Expected: FAIL because the scoreboard module does not exist yet.

**Step 3: Implement the scoreboard helper**

Create a focused helper that consumes existing benchmark and behavior-metric output rather than re-deriving everything from raw artifacts twice.

Output should include:

- profile id
- aggregate match counts
- legal/illegal move signal
- timeout/forfeit rate
- average match length
- win shape
- one spectator-usefulness proxy based on existing behavior metrics
- winner ranking / rationale fields

**Step 4: Integrate scoreboard output into the benchmark path**

Modify `apps/sim/scripts/benchmark-v2.ts` so a fixed-profile baseline run can emit:

- `scoreboard.json`
- `scoreboard.md`

Keep the existing benchmark flow intact; extend it rather than replacing it.

**Step 5: Run focused tests**

Run:

```bash
pnpm -C apps/sim test -- test/baselineScoreboard.test.ts
```

Expected: PASS.

**Step 6: Run one local dry baseline command**

Use a tiny local run that exercises the scoreboard path without API dependence.

Example command shape:

```bash
pnpm -C apps/sim exec tsx scripts/benchmark-v2.ts --name baseline_smoke_local --gamesPerMatchup 1 --skipApi
```

Adjust actual flags to the implemented interface.

Expected: `scoreboard.json` and `scoreboard.md` written successfully.

**Step 7: Commit**

```bash
git add apps/sim/scripts/benchmark-v2.ts apps/sim/src/reporting/baselineScoreboard.ts apps/sim/test/baselineScoreboard.test.ts
git commit -m "feat(sim): add baseline scoreboard selection"
```

### Task 3: Check in the beta winner artifact and summary

**Files:**
- Create: `apps/sim/presets/hex_conquest/<winner>.json`
- Create: `docs/plans/2026-03-18-agent-quality-baselines-scoreboard.md`
- Optionally create: `apps/sim/results/<local-dev-output>` during evaluation only, but do not commit raw results

**Step 1: Run the fixed-profile comparison**

Run the agreed comparison workflow:

- fast-lane volume first
- API spot-check second

Keep the profile set fixed for the whole comparison.

**Step 2: Select the winner from produced scoreboard output**

Name exactly one winner and record:

- why it won
- what it beat
- why rejected profiles were rejected

**Step 3: Check in the winner preset artifact**

Create a single checked-in artifact for the chosen beta profile containing:

- preset id
- display name
- game type
- optional public persona
- private strategy
- provenance metadata referencing the scoreboard run

**Step 4: Add the short report**

Write a concise Markdown summary that points to the winner and the selection signals. Keep it decision-oriented.

**Step 5: Verify no raw benchmark artifacts are staged**

Run:

```bash
git status --short
```

Expected: only preset/report code and docs are staged, not generated result dumps.

**Step 6: Commit**

```bash
git add apps/sim/presets/hex_conquest docs/plans/2026-03-18-agent-quality-baselines-scoreboard.md
git commit -m "feat(sim): select beta baseline winner"
```

### Task 4: Add a thin publish/activate path for checked-in presets

**Files:**
- Create: `apps/openclaw-runner/src/presets.ts`
- Create: `apps/openclaw-runner/test/presets.test.ts` or equivalent focused test file
- Modify: `apps/openclaw-runner/src/cli.ts`

**Step 1: Write the failing preset publish test**

Add a test covering:

- preset lookup by name
- payload mapping to `{ publicPersona, privateStrategy, activate }`
- clear error for unknown preset

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm -C apps/openclaw-runner exec tsx --test test/presets.test.ts
```

If a dedicated test runner already exists, use that instead.

Expected: FAIL because preset loader/publish path does not exist yet.

**Step 3: Implement preset loading**

Create a small helper that loads the checked-in preset artifact and exposes a typed structure for the CLI.

**Step 4: Extend the CLI with one thin command path**

Add a narrow command or flags so the runner can:

- publish a named preset
- optionally activate it
- use it in duel setup without raw `--strategyA/--strategyB` text

Prefer a preset reference path over adding more ad hoc prompt text plumbing.

**Step 5: Run focused tests**

Run:

```bash
pnpm -C apps/openclaw-runner exec tsx --test test/presets.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/openclaw-runner/src/presets.ts apps/openclaw-runner/src/cli.ts apps/openclaw-runner/test/presets.test.ts
git commit -m "feat(runner): publish and use named beta presets"
```

### Task 5: Validate preset-backed strategy activation against existing prompt routes

**Files:**
- Modify: `apps/server/test/durable/prompts.strategy.durable.test.ts`
- Optionally modify: `apps/server/src/routes/prompts.ts` only if a tiny contract alignment is required

**Step 1: Write the failing durable test**

Add one test that proves a preset-shaped payload can be created and activated through the existing strategy endpoints without backend default logic.

The test should cover:

- create strategy version with `publicPersona` and `privateStrategy`
- activate it
- fetch active strategy
- confirm the active version matches the published preset content

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm -C apps/server exec node ./node_modules/vitest/vitest.mjs -c vitest.durable.config.ts --run test/durable/prompts.strategy.durable.test.ts
```

Expected: FAIL only if the current routes do not already satisfy the preset path.

**Step 3: Implement the minimal fix if needed**

If the route already supports the payload cleanly, keep this task test-only. If not, make the smallest route adjustment necessary.

**Step 4: Re-run durable prompt tests**

Run:

```bash
pnpm -C apps/server exec node ./node_modules/vitest/vitest.mjs -c vitest.durable.config.ts --run test/durable/prompts.strategy.durable.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/server/test/durable/prompts.strategy.durable.test.ts apps/server/src/routes/prompts.ts
git commit -m "test(server): lock preset strategy activation flow"
```

### Task 6: Run one real preset-backed OpenClaw validation

**Files:**
- Reuse: `apps/server/scripts/openclaw-duel-smoke.mjs`
- Reuse/modify minimally: `apps/openclaw-runner/src/cli.ts`
- Optionally add: `apps/server/test/openclaw-beta-preset-smoke.unit.test.ts` only if a small parser/helper needs direct coverage

**Step 1: Write the smallest missing test around preset-backed duel invocation**

If the runner CLI adds parsing or mapping logic that is not already covered, add a focused unit test for that exact logic first.

**Step 2: Run the focused test and watch it fail**

Run the smallest relevant command for the new preset path.

**Step 3: Implement the minimal CLI glue**

Only if needed after the failing test.

**Step 4: Run one real smoke or duel using the chosen preset**

Run a real process flow using the selected preset rather than ad hoc strategy text.

Example shape:

```bash
pnpm run smoke:openclaw-duel
```

or a dedicated preset-backed duel command if this branch adds one.

Expected:

- runner starts
- queue resolves
- match stream attaches
- moves are submitted
- terminal `match_ended` is observed
- the selected preset is the source of strategy content

**Step 5: Run final verification**

Run the narrowest relevant verification set:

```bash
pnpm -C apps/sim test -- test/hexConquestBaselines.test.ts test/baselineScoreboard.test.ts
pnpm -C apps/openclaw-runner <runner-test-command>
pnpm -C apps/server exec node ./node_modules/vitest/vitest.mjs -c vitest.durable.config.ts --run test/durable/prompts.strategy.durable.test.ts
pnpm run smoke:openclaw-duel
pnpm run check-types
```

Also record any still-failing pre-existing baseline test separately if it remains unrelated.

**Step 6: Commit**

```bash
git add apps/sim apps/openclaw-runner apps/server docs/plans
git commit -m "feat(beta): operationalize hex conquest baseline winner"
```

### Task 7: Final review and branch finish

**Files:**
- Review all touched files

**Step 1: Run a final diff review**

Run:

```bash
git diff --stat HEAD~6..HEAD
git status --short
```

Expected: only planned files and intentional docs are present.

**Step 2: Request code review**

Use the required review workflow before merge or PR prep.

**Step 3: Prepare branch finish**

Use the repo’s development-branch finishing workflow after implementation is accepted.
