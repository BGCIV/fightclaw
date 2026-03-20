# Real Agent Finish Pass Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Get one real Kai-vs-house-opponent match to finish using the existing beta flow, with Kai on `objective_beta` plus a minimal finish overlay and the house opponent on `safe_fallback_beta`.

**Architecture:** Keep engine and server contracts unchanged. Limit all behavior changes to the beta runner, house-opponent runner, and OpenClaw gateway prompt/policy path. Validate with sim first, then local smoke, then a minimal number of production runs.

**Tech Stack:** TypeScript, pnpm, OpenClaw runner CLI, Fightclaw sim harness, Cloudflare-backed API

---

### Task 1: Lock the profile split in tests first

**Files:**
- Modify: `apps/openclaw-runner/test/beta.test.ts`

**Step 1: Write the failing test**

Add assertions that:

- tester beta still defaults to `objective_beta`
- house opponent defaults to `safe_fallback_beta`

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm -C apps/openclaw-runner test -- test/beta.test.ts
```

Expected: FAIL on the new default-profile assertions.

**Step 3: Write minimal implementation**

Update the beta defaults in:

- `apps/openclaw-runner/src/beta.ts`

Keep Kai on `objective_beta`. Change the house-opponent default to
`safe_fallback_beta`.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm -C apps/openclaw-runner test -- test/beta.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/openclaw-runner/src/beta.ts apps/openclaw-runner/test/beta.test.ts
git commit -m "feat(openclaw-runner): split beta and house presets"
```

### Task 2: Write the failing finish-overlay tests

**Files:**
- Modify: `apps/openclaw-runner/test/beta.test.ts`
- Modify: `apps/openclaw-runner/test/gateway-openclaw-agent.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:

- Kai’s beta move provider prefers a legal terminal / high-pressure follow-up
  before ending the turn
- the gateway prompt explicitly says to take a terminal line when legal
- the gateway prompt explicitly says to avoid bailing after one acceptable move
  when a real finishing line remains

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm -C apps/openclaw-runner test -- test/beta.test.ts test/gateway-openclaw-agent.test.ts
```

Expected: FAIL on the new finish-overlay assertions.

**Step 3: Write minimal implementation**

Modify:

- `apps/openclaw-runner/src/beta.ts`
- `apps/openclaw-runner/scripts/gateway-openclaw-agent.ts`

Implement a narrow finish overlay that only affects the beta tester path:

- legal terminal line first
- favorable attack chain / stronghold threat next
- bounded continuation with explicit stop conditions

Do not change the generic engine or server flow.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm -C apps/openclaw-runner test -- test/beta.test.ts test/gateway-openclaw-agent.test.ts
pnpm -C apps/openclaw-runner check-types
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/openclaw-runner/src/beta.ts apps/openclaw-runner/scripts/gateway-openclaw-agent.ts apps/openclaw-runner/test/beta.test.ts apps/openclaw-runner/test/gateway-openclaw-agent.test.ts
git commit -m "feat(openclaw-runner): add finish-oriented beta overlay"
```

### Task 3: Prove the finish pass in sim

**Files:**
- Modify: `apps/sim/test/mockLlmBot.test.ts` only if a small helper extraction is needed

**Step 1: Run the comparison probe**

Run a focused probe with:

- Kai-style `objective_beta + finish overlay`
- house-opponent-style `safe_fallback_beta`

Measure:

- full-length endings
- average turns
- first kill turn
- average actions per turn

**Step 2: Capture results**

Keep the command output in the session notes and compare it to the current
`objective_beta` mirror behavior.

**Step 3: Only patch if the sim result exposes a clear policy bug**

Allowed fixes:

- continuation threshold tuning
- finish-priority ordering
- stop-condition tightening

Not allowed:

- geometry changes
- stat rebalance
- engine rule changes

**Step 4: Verify**

Run:

```bash
pnpm -C apps/sim test -- test/mockLlmBot.test.ts test/baselineScoreboard.test.ts test/benchmark-v2.contract.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/openclaw-runner apps/sim
git commit -m "test(sim): validate finish-oriented beta profile split"
```

### Task 4: Validate the real CLI flow locally

**Files:**
- No code changes expected unless the local smoke exposes a real bug

**Step 1: Run the local beta smoke**

Run the existing local smoke path against the new split:

```bash
pnpm run smoke:openclaw-beta
```

Expected:

- registration / verification still works
- house opponent still spawns
- match becomes visible through the normal replay/homepage path

**Step 2: If smoke fails, patch only the directly responsible runner-path bug**

Allowed fixes:

- beta command preset wiring
- house command preset wiring
- finish-overlay prompt/policy path

**Step 3: Re-run smoke and focused tests**

Run:

```bash
pnpm -C apps/openclaw-runner test -- test/beta.test.ts test/gateway-openclaw-agent.test.ts
pnpm run smoke:openclaw-beta
```

Expected: PASS.

**Step 4: Commit**

```bash
git add apps/openclaw-runner apps/server
git commit -m "fix(beta): keep local finish smoke green"
```

### Task 5: Spend one minimal real production validation

**Files:**
- No code changes expected unless the run reveals a runner-only bug

**Step 1: Run exactly one Kai-vs-house production attempt**

Use:

- Kai on `objective_beta` plus the finish overlay
- house opponent on `safe_fallback_beta`

**Step 2: Inspect authoritative evidence**

Check:

- `/v1/featured`
- `/log`
- runner progress output
- homepage replay URL

**Step 3: Decide promotion honestly**

Promote only if:

- the match finishes cleanly
- legality stays clean
- timeout churn does not increase

If it fails, stop and summarize the exact blocker instead of widening scope.

**Step 4: Commit only if a tiny runner-only fix was required**

```bash
git add apps/openclaw-runner
git commit -m "fix(beta): tighten finish behavior for real-agent run"
```
