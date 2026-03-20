# Reconnect Chaos Reliability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add chaos-driven reconnect/resume coverage for the runner session and canonical SSE replay path, then ship only the minimal production fixes required to make those failures pass.

**Architecture:** Keep the production blast radius centered on `packages/agent-client/src/runner.ts`, with tests driving the work from unit and durable lanes. The pass is intentionally constrained: every production change must map back to one named failing reconnect scenario.

**Tech Stack:** TypeScript, Vitest, Cloudflare durable test harness, SSE/log replay contracts.

**Design doc:** `docs/plans/2026-03-18-reconnect-chaos-design.md`

---

### Task 1: RED Unit Tests For Queue Wait And Stream Attach Seams

**Files:**
- Modify: `apps/server/test/agent-client-stream.unit.test.ts`
- Verify: `packages/agent-client/src/runner.ts`

**Step 1: Write the failing queue-wait disconnect test**
- Add a unit test for disconnect while the session is still waiting on queue resolution.
- Model the sequence so the session has to survive the failure and continue the same queue lifecycle instead of starting over.

**Step 2: Run the focused unit test and verify RED**
Run: `pnpm -C apps/server test -- test/agent-client-stream.unit.test.ts`
Expected: FAIL for the new queue-wait reconnect scenario.

**Step 3: Write the failing queue-resolution-before-stream-attach test**
- Add a unit test for the gap between queue resolution and stream attachment.
- Force a failure or close in the attach window and assert the session still reaches the stream cleanly without duplicating queue work.

**Step 4: Re-run the focused unit test file**
Run: `pnpm -C apps/server test -- test/agent-client-stream.unit.test.ts`
Expected: FAIL for the new attach-gap scenario.

### Task 2: Minimal Runner Session Fixes For Task 1

**Files:**
- Modify: `packages/agent-client/src/runner.ts`
- Verify: `packages/agent-client/src/types.ts`

**Step 1: Implement the smallest queue/session fixes**
- Patch only what Task 1 exposed.
- Keep queue-to-match handoff single-path through `RunnerSession`.
- Do not change server routes, event schema, or CLI behavior in this task.

**Step 2: Run the focused unit file**
Run: `pnpm -C apps/server test -- test/agent-client-stream.unit.test.ts`
Expected: PASS for the new queue-wait and attach-gap cases.

**Step 3: Review the diff against scope**
- Confirm the production change is traceable to the failing Task 1 tests.
- Remove any code that is not required by the RED scenarios.

### Task 3: RED Unit Tests For Mid-Stream Resume And Move Submission Edges

**Files:**
- Modify: `apps/server/test/agent-client-stream.unit.test.ts`
- Verify: `packages/agent-client/src/runner.ts`

**Step 1: Write the failing duplicate-boundary replay test**
- Add a unit test where reconnect resumes with the last observed `eventId` boundary and the stream replays the last actionable envelope.
- Assert that move execution remains idempotent and the runner does not duplicate work.

**Step 2: Run the focused unit file and verify RED**
Run: `pnpm -C apps/server test -- test/agent-client-stream.unit.test.ts`
Expected: FAIL for the duplicate-boundary replay scenario.

**Step 3: Write the failing reconnect-near-submit test**
- Add a unit test where reconnect happens during or immediately after move submission.
- Assert that turn eligibility is preserved and the runner does not churn or double-submit.

**Step 4: Re-run the focused unit file**
Run: `pnpm -C apps/server test -- test/agent-client-stream.unit.test.ts`
Expected: FAIL for the near-submit reconnect scenario.

### Task 4: Minimal Runner Session Fixes For Task 3

**Files:**
- Modify: `packages/agent-client/src/runner.ts`

**Step 1: Implement the smallest idempotency/reconnect fixes**
- Patch only what Task 3 exposed.
- Accept fixes such as duplicate envelope suppression, resume-boundary handling, or reconnect state cleanup if directly required by the tests.

**Step 2: Run the focused unit file**
Run: `pnpm -C apps/server test -- test/agent-client-stream.unit.test.ts`
Expected: PASS for all runner-session chaos unit cases.

**Step 3: Keep the client contract unchanged**
- Confirm no new exports, endpoints, or schema changes were added beyond what the tests required.

### Task 5: RED Durable Tests For Replay Boundary And Terminal Resume Behavior

**Files:**
- Modify: `apps/server/test/durable/sse.durable.test.ts`
- Modify: `apps/server/test/durable/log.durable.test.ts`
- Modify: `apps/server/test/durable/queue.durable.test.ts`
- Optionally modify: `apps/server/test/helpers.ts`

**Step 1: Write the failing durable test for replay boundary duplication**
- Add durable coverage proving resume after `afterId` does not duplicate the last actionable envelope.

**Step 2: Run only the targeted durable files and verify RED**
Run: `pnpm -C apps/server exec node ./node_modules/vitest/vitest.mjs -c vitest.durable.config.ts --run test/durable/queue.durable.test.ts test/durable/sse.durable.test.ts test/durable/log.durable.test.ts`
Expected: FAIL for the new replay-boundary durable scenario.

**Step 3: Write the failing durable test for resume-after-terminal**
- Add a durable case proving terminal envelopes stop further reconnect/resume churn.

**Step 4: Re-run the targeted durable files**
Run: `pnpm -C apps/server exec node ./node_modules/vitest/vitest.mjs -c vitest.durable.config.ts --run test/durable/queue.durable.test.ts test/durable/sse.durable.test.ts test/durable/log.durable.test.ts`
Expected: FAIL for the new terminal-resume scenario.

### Task 6: Minimal Production Fixes For Durable Failures

**Files:**
- Modify only if required by RED:
  - `packages/agent-client/src/runner.ts`
  - `apps/web/src/routes/index.tsx`
  - server-side reliability files directly implicated by the failing durable tests

**Step 1: Implement only the smallest durable-driven fix**
- Prefer the runner/session layer first.
- Touch `apps/web/src/routes/index.tsx` only if the failure provably lives in replay-follow consumption and cannot be corrected lower in the stack.

**Step 2: Re-run the targeted durable files**
Run: `pnpm -C apps/server exec node ./node_modules/vitest/vitest.mjs -c vitest.durable.config.ts --run test/durable/queue.durable.test.ts test/durable/sse.durable.test.ts test/durable/log.durable.test.ts`
Expected: PASS.

**Step 3: Keep featured secondary**
- Do not expand into `featured-stream.durable.test.ts` unless a durable failure in this pass forces a related control-plane fix.

### Task 7: Final Verification And Review

**Files:**
- Verify only

**Step 1: Run unit confidence**
Run: `pnpm run test`
Expected: PASS.

**Step 2: Run type confidence**
Run: `pnpm run check-types`
Expected: PASS.

**Step 3: Run targeted durable confidence**
Run: `pnpm -C apps/server exec node ./node_modules/vitest/vitest.mjs -c vitest.durable.config.ts --run test/durable/queue.durable.test.ts test/durable/sse.durable.test.ts test/durable/log.durable.test.ts`
Expected: PASS.

**Step 4: Run Biome on touched files**
Run: `pnpm exec biome check <touched-files>`
Expected: PASS.

**Step 5: Review against success criteria**
- Confirm reconnect preserves turn eligibility.
- Confirm resume does not duplicate the last actionable envelope.
- Confirm terminal events stop resume churn.
- Confirm queue-to-match handoff is still single-path through `RunnerSession`.
