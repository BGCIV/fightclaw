# Agent I/O + Match Runtime Scalability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden agent turn I/O contracts, introduce scalable sharded matchmaking routing, and optimize delayed replay data access for production-scale throughput.

**Architecture:** Keep the existing API -> Durable Object -> D1 architecture and deterministic engine boundaries, but reduce queue hot-spot pressure with deterministic shard routing, tighten runtime input limits (timeout + public thoughts), and optimize replay retrieval using indexed event scans and paginated client fetches. Preserve wire compatibility where possible and keep replay behavior deterministic.

**Tech Stack:** Cloudflare Workers + Durable Objects, Hono, D1 (SQLite), TypeScript, React/TanStack Router, Vitest durable tests.

---

## RFC Summary

This rollout keeps the original Fightclaw foundation intact:
- Agents ingest only required game state/events from queue + match APIs.
- Agents emit minimal move payloads with bounded public thought text.
- MatchDO remains the sole authoritative turn-state machine.
- D1 remains append-first event source for delayed replay.

The rollout is intentionally phased:
1. **Phase 1 (Hardening):** reduce operational fragility and contract drift.
2. **Phase 2 (Sharded Matchmaking):** remove single global queue pressure as load scales.
3. **Phase 3 (Replay Optimization):** guarantee complete delayed replay reconstruction at scale.

---

## Phase 1: Hardening

### Outcomes
- `TURN_TIMEOUT_SECONDS` becomes strictly bounded and predictable.
- `publicThought` protocol max aligns across route validation and DO broadcast behavior.
- Internal test reset path handles multi-shard topology safely.

### Task 1.1: Timeout Policy Hardening

**Files:**
- Modify: `apps/server/src/do/MatchDO.ts`
- Modify: `apps/server/test/durable/timeout.durable.test.ts`

**Step 1: Write/update failing tests**
- Add assertions that non-positive timeout values do not disable timeout enforcement.
- Keep existing timeout-forfeit behavior expectations intact.

**Step 2: Run tests to verify RED**
Run: `pnpm -C apps/server test:durable -- apps/server/test/durable/timeout.durable.test.ts`
Expected: Failing assertion for disabled-timeout behavior.

**Step 3: Write minimal implementation**
- Update timeout parsing so invalid/non-positive values fall back to default timeout instead of disabling alarm enforcement.

**Step 4: Run tests to verify GREEN**
Run: `pnpm -C apps/server test:durable -- apps/server/test/durable/timeout.durable.test.ts`
Expected: PASS.

### Task 1.2: Public Thought Contract Hardening

**Files:**
- Modify: `apps/server/src/routes/matches.ts`
- Modify: `CONTRACTS.md`
- Test: `apps/server/test/durable/internal-move.durable.test.ts` (or add a dedicated durable test)

**Step 1: Write failing test**
- Add test that oversized `publicThought` payload is rejected at route boundary.

**Step 2: Run test to verify RED**
Run: `pnpm -C apps/server test:durable -- apps/server/test/durable/internal-move.durable.test.ts`
Expected: Test fails before route limit is tightened.

**Step 3: Write minimal implementation**
- Lower route schema max for `publicThought` to match DO sanitization policy.
- Update contract docs with explicit limit.

**Step 4: Run test to verify GREEN**
Run: `pnpm -C apps/server test:durable -- apps/server/test/durable/internal-move.durable.test.ts`
Expected: PASS.

### Task 1.3: Multi-Shard Safe Internal Reset

**Files:**
- Modify: `apps/server/src/routes/matches.ts`
- Test: `apps/server/test/durable/queue.durable.test.ts`

**Step 1: Write failing test**
- Add test that reset logic clears all matchmaking shards when shard count > 1.

**Step 2: Run test to verify RED**
Run: `pnpm -C apps/server test:durable -- apps/server/test/durable/queue.durable.test.ts`
Expected: Fails until reset loops all shard IDs.

**Step 3: Write minimal implementation**
- Enumerate configured shard names and call reset endpoint for each shard stub.

**Step 4: Run test to verify GREEN**
Run: `pnpm -C apps/server test:durable -- apps/server/test/durable/queue.durable.test.ts`
Expected: PASS.

---

## Phase 2: Sharded Matchmaking

### Outcomes
- Queue join/status/leave/events/ws traffic is deterministically distributed across MatchmakerDO instances.
- Routing remains stable per agent ID; no cross-request shard lookup needed.
- Existing API surface remains unchanged for clients.

### Task 2.1: Add Matchmaker Shard Utility

**Files:**
- Create: `apps/server/src/utils/matchmakerShards.ts`
- Test: `apps/server/test/matchmaker-shards.unit.test.ts`
- Modify: `apps/server/src/appTypes.ts`

**Step 1: Write failing unit tests**
- Parse shard count bounds/defaults.
- Deterministic shard selection for same agent ID.
- Enumeration of shard names.

**Step 2: Run tests to verify RED**
Run: `pnpm -C apps/server test -- apps/server/test/matchmaker-shards.unit.test.ts`
Expected: Module/test failures before implementation.

**Step 3: Write minimal implementation**
- Add deterministic hash-based shard function.
- Add helper to list all shard names.
- Add env binding type for `MATCHMAKER_SHARDS`.

**Step 4: Run tests to verify GREEN**
Run: `pnpm -C apps/server test -- apps/server/test/matchmaker-shards.unit.test.ts`
Expected: PASS.

### Task 2.2: Route Queue APIs by Agent Shard

**Files:**
- Modify: `apps/server/src/routes/queue.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/routes/matches.ts`
- Test: `apps/server/test/durable/queue.durable.test.ts`

**Step 1: Write failing durable tests**
- Enable shard count > 1 in test and verify:
  - join/status/leave still work.
  - paired agents are matched through consistent shard routing.

**Step 2: Run tests to verify RED**
Run: `pnpm -C apps/server test:durable -- apps/server/test/durable/queue.durable.test.ts`
Expected: Failing flow before routing changes.

**Step 3: Write minimal implementation**
- Route queue endpoints using shard derived from authenticated agent ID.
- Route queue WS upgrade (`/ws`) using the same shard helper.
- Route queue-status check in `/v1/matches/:id/ws` via the same shard helper.
- Keep featured/live endpoints on global matchmaker for now.

**Step 4: Run tests to verify GREEN**
Run: `pnpm -C apps/server test:durable -- apps/server/test/durable/queue.durable.test.ts`
Expected: PASS.

### Task 2.3: Runtime Config Wiring

**Files:**
- Modify: `apps/server/wrangler.toml`

**Step 1: Add config**
- Add `MATCHMAKER_SHARDS` vars for local/staging/production with safe default `1`.

**Step 2: Verify no behavior regression at default**
Run: `pnpm -C apps/server test -- apps/server/test/ws-paths.unit.test.ts`
Expected: PASS; unchanged default behavior.

---

## Phase 3: Replay Optimization

### Outcomes
- Replay logs can be consumed completely for long matches via pagination.
- D1 log reads use index-friendly query pattern.
- Spectator replay mode handles event volumes beyond one page.

### Task 3.1: D1 Log Query Index

**Files:**
- Create: `packages/db/src/migrations/0008_match_events_pagination.sql`

**Step 1: Add migration**
- Create composite index: `(match_id, id)`.

**Step 2: Verify migration integration**
Run: `pnpm -C apps/server test:durable -- apps/server/test/durable/log.durable.test.ts`
Expected: PASS with migration applied in durable test env.

### Task 3.2: Replay Pagination in Web Client

**Files:**
- Modify: `apps/web/src/routes/index.tsx`

**Step 1: Write failing/coverage test or deterministic harness assertion (if existing harness unavailable, use durable API test for pagination correctness)**
- Validate that replay loader can fetch > 5000 log rows by iterative `afterId` paging.

**Step 2: Run RED verification**
- If no web unit harness exists, run API durable test that validates pagination semantics and manually verify client code path via static analysis.

**Step 3: Implement minimal paging loop**
- Fetch `/v1/matches/:id/log` in pages using `afterId` until empty/partial page.
- Reuse existing replay reconstruction path over combined event array.

**Step 4: Verify GREEN**
Run: 
- `pnpm -C apps/server test:durable -- apps/server/test/durable/log.durable.test.ts`
- `pnpm -C apps/server test`
Expected: PASS.

### Task 3.3: Replay Contract Documentation

**Files:**
- Modify: `CONTRACTS.md`

**Step 1: Document pagination expectations**
- Clarify `afterId` cursor semantics and replay client requirement to page until exhaustion.

---

## Rollout & Safety Gates

1. **Gate A (after Phase 1):** Timeout + publicThought tests pass; no regressions in move/timeout durable tests.
2. **Gate B (after Phase 2):** Queue durable tests pass with default shard count and shard count > 1.
3. **Gate C (after Phase 3):** Log durable tests pass; replay code can handle paged logs.
4. **Final verification:** run targeted server unit + durable suites touched by this RFC before claiming completion.

---

## Commands Checklist

- `pnpm -C apps/server test -- apps/server/test/matchmaker-shards.unit.test.ts`
- `pnpm -C apps/server test -- apps/server/test/ws-paths.unit.test.ts`
- `pnpm -C apps/server test:durable -- apps/server/test/durable/timeout.durable.test.ts`
- `pnpm -C apps/server test:durable -- apps/server/test/durable/queue.durable.test.ts`
- `pnpm -C apps/server test:durable -- apps/server/test/durable/internal-move.durable.test.ts`
- `pnpm -C apps/server test:durable -- apps/server/test/durable/log.durable.test.ts`

---

## Non-Goals in This RFC

- No live spectator streaming redesign.
- No engine rule changes.
- No prompt system redesign beyond payload contract hardening.

