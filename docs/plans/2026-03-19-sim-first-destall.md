# Sim-First De-Stall Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a sim-first diagnostic and tuning loop that identifies and validates one structural anti-stall change for `hex_conquest` before spending more production match budget.

**Architecture:** Keep the work centered in `apps/sim` and `packages/engine`. First add diagnostics that reveal whether the game is stalling because of path-to-contact, objective pressure, or combat lethality. Then test one structural candidate at a time with a hard cutover in the sim lane, and only do a tiny production confirmation after a clear sim winner exists.

**Tech Stack:** TypeScript, Bun tests in `apps/sim`, engine logic in `packages/engine`, existing benchmark scripts in `apps/sim/scripts`, optional browser verification against the deployed web app.

---

### Task 1: Lock the current structural problem with a focused diagnostic repro

**Files:**
- Modify: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/apps/sim/test/integration.test.ts`
- Modify: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/apps/sim/test/boardgameio.integration.test.ts`
- Reference: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/apps/sim/DIAGNOSTICS_REPORT.md`

**Step 1: Write a failing or revealing regression-style test**

Add one focused test that captures the current symptom in a structural lane, such as:

- a midfield or default-board matchup taking too many turns before first damage
- a default-board mirrored matchup hitting `maxTurns` too often in a small deterministic sample

The test does not need to fail forever. It can be written as a skipped or targeted diagnostic test first if the exact threshold is still being established.

**Step 2: Run only the new repro test**

Run: `pnpm -C apps/sim test -- --filter integration`

Expected: either a failing threshold or a clear printed diagnostic showing current bad behavior.

**Step 3: Keep the test narrow**

Do not tune anything yet. The output should tell us whether the current board and objectives are causing late first contact or late first damage.

**Step 4: Commit**

```bash
git add apps/sim/test/integration.test.ts apps/sim/test/boardgameio.integration.test.ts
git commit -m "test(sim): lock current stall reproduction"
```

### Task 2: Add structural pacing diagnostics to the sim reporting path

**Files:**
- Modify: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/apps/sim/src/match.ts`
- Modify: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/apps/sim/src/boardgameio/runner.ts`
- Modify: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/apps/sim/src/types.ts`
- Create or modify: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/apps/sim/test/structuralDiagnostics.test.ts`

**Step 1: Write the failing test for diagnostic fields**

Add a test that expects the match result/report shape to expose fields such as:

- `firstContactTurn`
- `firstDamageTurn`
- `firstKillTurn`
- `terminalReason`

If a shared helper makes sense, keep it small and local to sim.

**Step 2: Run the diagnostic test**

Run: `pnpm -C apps/sim test -- --filter structuralDiagnostics`

Expected: FAIL because the fields do not exist yet.

**Step 3: Implement the minimal diagnostics**

Track the first turn where:

- opposing units become adjacent or otherwise engageable
- damage is recorded
- a unit dies

Keep the implementation deterministic and reporting-only.

**Step 4: Run the diagnostic test again**

Run: `pnpm -C apps/sim test -- --filter structuralDiagnostics`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/sim/src/match.ts apps/sim/src/boardgameio/runner.ts apps/sim/src/types.ts apps/sim/test/structuralDiagnostics.test.ts
git commit -m "feat(sim): add structural pacing diagnostics"
```

### Task 3: Expose the diagnostics through a tiny analysis command or summary output

**Files:**
- Modify: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/apps/sim/src/cli.ts`
- Modify: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/apps/sim/src/reporting/baselineScoreboard.ts`
- Modify: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/apps/sim/test/baselineScoreboard.test.ts`

**Step 1: Write the failing reporting test**

Add a test that expects the scoreboard or summary output to surface at least one aggregated pacing field, such as average first-contact turn or average first-kill turn.

**Step 2: Run the reporting test**

Run: `pnpm -C apps/sim test -- --filter baselineScoreboard`

Expected: FAIL because the metric is missing.

**Step 3: Implement the minimal reporting change**

Thread the new diagnostics into the existing summary/reporting path. Avoid building a big new dashboard format.

**Step 4: Run the test again**

Run: `pnpm -C apps/sim test -- --filter baselineScoreboard`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/sim/src/cli.ts apps/sim/src/reporting/baselineScoreboard.ts apps/sim/test/baselineScoreboard.test.ts
git commit -m "feat(sim): report structural pacing metrics"
```

### Task 4: Establish the current baseline in the fast lane

**Files:**
- No code changes required unless a tiny script tweak is needed
- Reference: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/apps/sim/scripts/benchmark-v2.ts`

**Step 1: Run a small baseline matrix**

Run a reproducible fast-lane sample with the current rules. Keep it smaller than a full benchmark if needed for speed, but include the scenarios most relevant to stalling.

Suggested command:

```bash
pnpm -C apps/sim exec tsx src/cli.ts tourney --games 8 --seed 1 --maxTurns 180 --harness boardgameio
```

If a better existing benchmark command already captures the same lanes, use it instead.

**Step 2: Save the baseline numbers locally**

Record:

- max-turn ending rate
- average turns
- average first contact
- average first damage
- average first kill

Do not commit raw artifacts.

**Step 3: Commit only if code changed**

If no code changed in this task, skip the commit.

### Task 5: Implement one geometry-first anti-stall candidate

**Files:**
- Modify: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/packages/engine/src/index.ts`
- Modify: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/packages/engine/test/engine.test.ts`
- Modify: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/apps/sim/test/integration.test.ts`

**Step 1: Write the failing engine/integration test**

Choose one geometry-focused candidate, most likely a starting-position adjustment that shortens path-to-contact without changing the board size yet.

Write tests that prove the new intended placements or the new early-contact behavior.

**Step 2: Run only the new tests**

Run:

```bash
pnpm -C packages/engine test
pnpm -C apps/sim test -- --filter integration
```

Expected: FAIL before implementation.

**Step 3: Implement the minimal geometry change**

Change only one structural variable. Do not mix in VP, economy, or stat changes here.

**Step 4: Re-run the targeted tests**

Run the same commands again and confirm PASS.

**Step 5: Commit**

```bash
git add packages/engine/src/index.ts packages/engine/test/engine.test.ts apps/sim/test/integration.test.ts
git commit -m "feat(engine): shorten early contact geometry"
```

### Task 6: Compare the candidate against the baseline

**Files:**
- No code changes required unless a tiny benchmark helper is needed

**Step 1: Re-run the same fast-lane sample**

Use the same command from Task 4.

**Step 2: Compare against the saved baseline**

Accept only if the candidate improves at least the following:

- lower `maxTurns` or draw-heavy endings
- earlier first contact or first damage
- no obvious collapse in decisive gameplay

**Step 3: Stop if the candidate is not clearly better**

Do not stack another fix on top. If the numbers are unclear or worse, go back and choose the next single candidate.

**Step 4: Commit only if code changed**

If no code changed in this task, skip the commit.

### Task 7: Validate with one minimal real-agent run

**Files:**
- Modify only if a tiny scripted validation helper is needed
- Reference: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/apps/server/scripts/openclaw-duel-smoke.mjs`
- Reference: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/apps/openclaw-runner/src/beta.ts`

**Step 1: Use the smallest production-safe validation path**

Run one minimal real-agent or house-opponent validation against the tuned rules if that path is available locally or in staging. Avoid repeated production runs.

**Step 2: Inspect authoritative truth**

Verify:

- terminal reason
- whether public commentary still flows
- whether the ticker/result band still align with the log

**Step 3: Use browser observation only as confirmation**

If helpful, use Playwright to inspect the live replay page for the single validation match. Do not use browser observation as the primary debugging source.

**Step 4: Commit only if code changed**

If validation requires no code changes, skip the commit.

### Task 8: Write a short conclusion note

**Files:**
- Create: `/Users/bgciv/Dev/fightclaw/.worktrees/sim-first-destall/docs/plans/2026-03-19-sim-first-destall-results.md`

**Step 1: Summarize the before/after**

Capture:

- the baseline structural problem
- the chosen candidate
- the sim result
- the minimal production validation result

Keep it short and decision-oriented.

**Step 2: Commit**

```bash
git add docs/plans/2026-03-19-sim-first-destall-results.md
git commit -m "docs: record sim-first de-stall findings"
```

### Task 9: Full verification before claiming success

**Files:**
- No new files unless a tiny test adjustment is required

**Step 1: Run relevant tests**

Run:

```bash
pnpm -C packages/engine test
pnpm -C apps/sim test
pnpm run check-types
```

Note: at the start of this slice, `apps/sim test` already had one unrelated failing test in `apps/sim/test/stateEncoder.test.ts` expecting `D11=high_ground` while the actual contested-nearby output was `C10=lumber_camp`. Do not misattribute that failure to de-stall work; either leave it untouched as pre-existing or fix it only if the slice legitimately changes that behavior.

**Step 2: Run focused formatting/lint verification on touched files**

Run:

```bash
pnpm exec biome check <touched files>
```

**Step 3: Commit any final verification-only adjustments**

```bash
git add <touched files>
git commit -m "test: finalize sim-first de-stall verification"
```
