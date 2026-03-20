# Reconnect Chaos Reliability Design

**Date:** 2026-03-18

**Status:** Approved for implementation in-session

## Goal

Pressure the runner/session reconnect path hard enough to expose the real seams in queue wait, queue-to-stream handoff, SSE resume, duplicate boundary replay, and terminal-state handling, then apply only the minimal production fixes required to make those failures boring.

## Problem

The repo now has the right architecture direction:

- runner lifecycle is centered on `RunnerSession`
- match live/replay transport is canonical SSE
- replay and spectate both support `afterId`
- queue wait and match stream are now one client-side lifecycle

What we do not yet have is proof that the path stays correct under disruption. The current test suite verifies happy-path resume behavior, but it does not yet cover the costly failures that make OpenClaw feel flaky:

- disconnect while waiting in queue
- disconnect after queue resolution but before or during stream attach
- disconnect mid-stream after real envelopes have already advanced the cursor
- duplicate replay of the last envelope at the resume boundary
- reconnect during or just after move submission
- reconnect after the match is already terminal

That means the repo is directionally correct but not yet hardened against the exact class of failures users experience as "sometimes it kind of works."

## Success Criteria

This pass is green only if all of the following are true:

- the runner can reconnect without losing turn eligibility
- resume does not duplicate the last actionable envelope
- terminal events stop further resume churn
- queue-to-match handoff remains single-path through the session adapter

Anything outside that set is out of scope.

## Scope

### In Scope

- RED tests for runner/session reconnect chaos in unit coverage
- RED tests for queue/SSE/log boundary behavior in durable coverage
- minimal production fixes in the runner/session/SSE reliability path
- timer hygiene, reconnect state cleanup, duplicate envelope suppression, resume-after-terminal handling, and `afterId` boundary correctness

### Out of Scope

- protocol redesign
- new endpoints
- schema changes
- web UI/product work
- opportunistic cleanup
- observability expansion unless a missing signal blocks a test or fix
- `game_ended` alias removal in this pass

## Production Lanes

### Primary Production Lane

- `packages/agent-client/src/runner.ts`

This is the main place where queue wait, queue resolution, stream attach, reconnect scheduling, and terminal handling converge. If a production fix is needed, it should almost certainly land here first.

### Primary Truth-Finding Lanes

- `apps/server/test/agent-client-stream.unit.test.ts`
- `apps/server/test/durable/queue.durable.test.ts`
- `apps/server/test/durable/sse.durable.test.ts`
- `apps/server/test/durable/log.durable.test.ts`

These are the tests that should drive the work. A production change that cannot be traced back to one named failing scenario from these lanes probably does not belong in this slice.

### Secondary Lanes

- `apps/server/test/durable/featured-stream.durable.test.ts`
- `apps/web/src/routes/index.tsx`

Featured stream is control-plane rather than runner-critical, so it is secondary here. The web replay-follow path should stay out of the production blast radius unless a RED test proves that a reliability bug only manifests in that downstream consumer.

## Scenario Order

The scenarios are ranked by business damage, not by convenience:

1. queue wait disconnect
2. queue resolution just before stream attach
3. mid-stream reconnect with duplicate boundary replay
4. reconnect during or immediately after move submission
5. resume after terminal event

This order attacks the places most likely to make OpenClaw feel unreliable.

## Approaches Considered

### 1. Test-only chaos pass

Pros:

- smallest implementation diff
- fastest to write initially

Cons:

- guarantees a second pass for the same surface
- leaves real runner reliability defects alive after the failures are known

### 2. Bounded chaos pass with minimal production fixes

Pros:

- keeps the work attached to real failures
- limits production touch points to the reconnect/resume lane
- hardens the path users actually experience

Cons:

- requires disciplined scope control
- easy to sprawl if fixes are not kept test-traceable

### 3. Broad reliability refactor across server, runner, and web

Pros:

- could smooth multiple layers at once

Cons:

- too large for one slice
- blurs whether failures are fixed or merely rearranged
- raises risk of accidental protocol or product drift

## Decision

Choose approach 2.

This pass will be a bounded chaos hardening block:

- write RED tests for one named failure at a time
- watch the failure happen
- apply the smallest production fix that makes the failure pass
- stop when the named scenarios above are green

## Expected Fix Shapes

Fair-game production fixes include:

- `afterId` boundary handling
- duplicate envelope suppression on resume
- reconnect state-machine cleanup
- timer/backoff hygiene
- terminal-event idempotency
- queue-to-stream handoff cleanup inside the session adapter

Not fair game:

- new transport surfaces
- protocol or schema changes
- gameplay logic changes
- unrelated route cleanup

## Testing Strategy

### Unit First

Start in `apps/server/test/agent-client-stream.unit.test.ts`.

These tests should drive the runner-session edge cases because they are fast, deterministic, and can directly model queue, stream, and move-submit ordering.

### Durable Second

Once the unit lane identifies the shape of the fixes, extend durable coverage in:

- `queue.durable.test.ts`
- `sse.durable.test.ts`
- `log.durable.test.ts`

Durable tests should verify the server-side resume and replay contract under realistic sequencing, especially around `afterId`, terminal boundaries, and replay/log catch-up.

### Web Only If Forced

Do not touch `apps/web/src/routes/index.tsx` unless a RED test proves the bug only manifests in replay-follow consumption and cannot be addressed lower in the stack.

## Risks

- Accidentally adding a "helper" production change that is not tied to a failing scenario.
- Letting reconnect fixes turn into observability work.
- Fixing duplicate replay in one layer while leaving terminal churn or queue handoff ambiguity alive in another.

## Non-Goals

- No attempt to remove `game_ended` in this pass.
- No feature or presentation work.
- No control-plane redesign for featured streaming.
