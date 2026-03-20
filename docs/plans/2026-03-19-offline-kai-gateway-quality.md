# Offline Kai Gateway Quality Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reproduce Kai's live gateway failure shape offline on AWS using synthetic local states, then land one narrow gateway-side fix only if the harness proves a single root cause.

**Architecture:** Keep the work entirely in the OpenClaw runner/gateway layer. Build a small harness that drives the real `gateway-openclaw-agent.ts` script against curated synthetic states, records classification data, and only permits a fix if the evidence points to one narrow gateway-boundary defect.

**Tech Stack:** TypeScript, pnpm, OpenClaw runner CLI, AWS shell scripts, Node child-process execution

---

### Task 1: Add a synthetic-state probe harness with failing classification tests

**Files:**
- Create: `apps/openclaw-runner/src/kaiGatewayProbe.ts`
- Create: `apps/openclaw-runner/test/kaiGatewayProbe.test.ts`

**Step 1: Write the failing tests**

Add tests that prove the harness can classify:

- parse failure
- invalid move selection
- provider invocation failure
- successful legal move emission

Use stubbed raw gateway/provider outputs instead of the real AWS host for the
unit tests.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm -C apps/openclaw-runner test -- test/kaiGatewayProbe.test.ts
```

Expected: FAIL because the harness/classifier does not exist yet.

**Step 3: Write minimal implementation**

Implement a probe helper that:

- accepts a synthetic gateway input
- runs the same normalization/classification pipeline the real gateway uses
- returns a compact report with failure class, latency, parse outcome, and
  chosen/fallback move metadata

Keep it reusable by both tests and an AWS-facing CLI script.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm -C apps/openclaw-runner test -- test/kaiGatewayProbe.test.ts
pnpm -C apps/openclaw-runner check-types
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/openclaw-runner/src/kaiGatewayProbe.ts apps/openclaw-runner/test/kaiGatewayProbe.test.ts
git commit -m "test(openclaw-runner): classify kai gateway probe outcomes"
```

### Task 2: Add curated synthetic-state fixtures and an AWS probe command

**Files:**
- Create: `apps/openclaw-runner/scripts/kai-gateway-probe.ts`
- Create: `apps/openclaw-runner/test/fixtures/kai-gateway/opening.json`
- Create: `apps/openclaw-runner/test/fixtures/kai-gateway/follow-up.json`
- Create: `apps/openclaw-runner/test/fixtures/kai-gateway/attack-pressure.json`
- Modify: `apps/openclaw-runner/test/kaiGatewayProbe.test.ts`

**Step 1: Write the failing fixture-driven test**

Add a test that loads the curated fixture inputs and asserts the probe report is
well-formed for each case.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm -C apps/openclaw-runner test -- test/kaiGatewayProbe.test.ts
```

Expected: FAIL because the fixture loader or probe CLI does not exist yet.

**Step 3: Write minimal implementation**

Create:

- a tiny fixture set based on `createInitialState(...)` and one-action derived
  follow-up states
- a CLI script that can run the real `gateway-openclaw-agent.ts` path against
  those inputs and print structured probe reports

The script should be safe to scp/run on AWS without touching Cloudflare.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm -C apps/openclaw-runner test -- test/kaiGatewayProbe.test.ts
pnpm -C apps/openclaw-runner check-types
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/openclaw-runner/scripts/kai-gateway-probe.ts apps/openclaw-runner/test/fixtures/kai-gateway apps/openclaw-runner/test/kaiGatewayProbe.test.ts
git commit -m "feat(openclaw-runner): add offline kai gateway probe harness"
```

### Task 3: Run the harness on AWS and classify the primary failure

**Files:**
- No code changes required unless the offline reports expose a narrow defect

**Step 1: Sync the probe script and fixtures to AWS**

Copy only the needed files to the AWS repo checkout.

**Step 2: Run the curated probes against the real AWS OpenClaw agent**

Run the real gateway path on AWS using:

- `OPENCLAW_BIN=/usr/local/bin/openclaw`
- `OPENCLAW_AGENT_ID=main` (or the current Kai selector)
- bounded `OPENCLAW_TIMEOUT_SECONDS`

Capture structured output for each synthetic state.

**Step 3: Classify the result**

Name the primary failure class precisely, for example:

- parse failure from extra prose
- response payload shape mismatch
- legal move normalization failure
- timeout/provider invocation instability
- stdin/stdout contract issue

If no single class dominates, stop here and document that the branch remains
diagnostic-only.

**Step 4: Save a short report**

Write a compact report in:

- `docs/plans/2026-03-19-offline-kai-gateway-quality-report.md`

Include only the small number of probe outcomes needed to justify the next
decision.

**Step 5: Commit**

```bash
git add docs/plans/2026-03-19-offline-kai-gateway-quality-report.md
git commit -m "docs(openclaw-runner): classify kai gateway probe failures"
```

### Task 4: Land one minimal fix only if the evidence is narrow

**Files:**
- Modify only the smallest relevant subset of:
  - `apps/openclaw-runner/scripts/gateway-openclaw-agent.ts`
  - `apps/openclaw-runner/src/kaiGatewayProbe.ts`
  - `apps/openclaw-runner/test/kaiGatewayProbe.test.ts`
  - `apps/openclaw-runner/test/gateway-openclaw-agent.test.ts`

**Step 1: Write the failing test for the proven defect**

Add one targeted test that reproduces the exact narrow cause exposed by the AWS
probe report.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm -C apps/openclaw-runner test -- test/kaiGatewayProbe.test.ts test/gateway-openclaw-agent.test.ts
```

Expected: FAIL on the new narrow regression case.

**Step 3: Write minimal implementation**

Implement the smallest gateway-side fix only.

Do not:

- redesign prompts broadly
- add new planning heuristics
- touch engine/server/UI code

**Step 4: Re-run offline verification**

Run:

```bash
pnpm -C apps/openclaw-runner test -- test/kaiGatewayProbe.test.ts test/gateway-openclaw-agent.test.ts test/beta.test.ts
pnpm -C apps/openclaw-runner check-types
```

Then rerun the AWS synthetic-state probe and confirm the primary failure class
is materially reduced or removed.

**Step 5: Commit**

```bash
git add apps/openclaw-runner/scripts/gateway-openclaw-agent.ts apps/openclaw-runner/src/kaiGatewayProbe.ts apps/openclaw-runner/test
git commit -m "fix(openclaw-runner): harden kai gateway response handling"
```

### Task 5: Spend one real validation run only if Task 4 landed a fix

**Files:**
- No further code changes expected

**Step 1: Reuse the existing real beta/house flow**

Run one production-style validation:

- Kai tester on `objective_beta` with the current finish overlay
- house opponent on `safe_fallback_beta`

**Step 2: Inspect only the essential artifacts**

Check:

- runner terminal output
- authoritative `/log`
- homepage replay URL
- public commentary on the agent card

**Step 3: Stop**

If the match starts and finishes and the old failure class is gone or materially
reduced, stop the branch here.

If the same failure class remains, do not keep iterating in production. End the
branch with the diagnostic report and next recommendation instead.
