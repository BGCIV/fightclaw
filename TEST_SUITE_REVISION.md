# Test Suite Revision — Status & Remaining Work

**Last updated:** 2026-02-07

## Current State

| Category | Count | Files |
|----------|-------|-------|
| Engine unit tests | 43 | `packages/engine/test/engine.test.ts` |
| Server unit tests | 21 | `test/events.unit.test.ts` (6), `test/crypto.unit.test.ts` (10), `test/auth.unit.test.ts` (5) |
| Server durable tests | 30 | `test/durable/*.durable.test.ts` (16 files) |
| **Total** | **94** | |

**Skipped tests:** 0
**Known-flaky:** `endgame-persistence.durable.test.ts` (DO persistence timing, non-blocking)

---

## Completed Priorities

### Priority 1: Bulk Up Engine Unit Tests — DONE

43 tests in `packages/engine/test/engine.test.ts` covering initial state, turn mechanics, move validation, combat resolution (ties, cavalry charge, shield wall, archer vulnerability), line of sight, terrain effects, resource depletion, victory conditions (stronghold capture, elimination, turn limit), fortify mechanics, and deterministic replay. No gaps identified.

### Priority 2: Extract Shared Test Helpers — DONE

All helpers centralized in `apps/server/test/helpers.ts`: `pollUntil`, `setupMatch`, `readSseUntil`, `readSseText`, `createAgent`, `resetDb`, `authHeader`. No duplicates across test files.

### Priority 3: Move Logic Out of the Durable Lane — DONE

| What | Status | File |
|------|--------|------|
| Event builders | `events.unit.test.ts` (6 tests) | Already existed |
| Crypto utils (sha256Hex, base64Url*, randomBase64Url) | `crypto.unit.test.ts` (10 tests) | **Added 2026-02-07** |
| createIdentity (appContext.ts) | `auth.unit.test.ts` (5 tests) | **Added 2026-02-07** |
| Zod schema validation | Not added | Low value — Zod schemas are type-safe by construction |

### Priority 4: Resolve Skipped SSE Tests — DONE

Flaky SSE integration tests were removed. Two stable SSE tests remain in `sse.durable.test.ts` (initial state delivery, engine events after move). The SSE serialization logic (`formatSse`) is tested in the unit lane via `events.unit.test.ts`.

### Priority 5: Add Coverage for Untested Routes — DONE

| Route | Status | Test File |
|-------|--------|-----------|
| `POST /v1/auth/register` | Tested | `auth.onboarding.durable.test.ts` |
| `POST /v1/auth/verify` | Tested | `auth.onboarding.durable.test.ts` — **Added 2026-02-07** |
| `GET /v1/auth/me` | Tested | `auth.onboarding.durable.test.ts` |
| `GET /v1/agents/:id/prompts` | Tested | `prompts.strategy.durable.test.ts` |
| `PUT /v1/agents/:id/prompts` | Tested | `prompts.strategy.durable.test.ts` |
| `POST /v1/internal/agents/:id/prompt` | Tested | `prompts.strategy.durable.test.ts` |
| `GET /v1/leaderboard` | Tested | `leaderboard.durable.test.ts` — **Added 2026-02-07** |
| `GET /v1/live` | Tested | `e2e.durable.test.ts` (indirectly) |

### Priority 6: Trim Auth Integration Tests — DONE

Auth tests consolidated. `auth.durable.test.ts` has 5 tests covering bearer token, move auth, public state, and public SSE access. `auth.onboarding.durable.test.ts` has 11 tests covering register, verify, verification gating, /me endpoint, and api_keys table auth.

---

## Housekeeping (2026-02-07)

- **Deleted** `endgame.durable.test.ts` — was a single `.skip`ped empty test; invisible debt removed.
- **Moved** `endgame-persistence.test.ts` → `durable/endgame-persistence.durable.test.ts` — uses `cloudflare:test`, belongs in the durable lane.
- **Fixed** 3 pre-existing assertion bugs in `auth.onboarding.durable.test.ts`: register test expected status 200 (route returns 201), `/me` tests read `data.verified` instead of `data.agent.verified`.

---

## Remaining Work (Optional, Low Priority)

### Zod Schema Unit Tests

`movePayloadSchema`, `finishPayloadSchema`, `matchIdSchema` in `src/index.ts` are untested directly. Zod schemas are type-safe by construction, so the value is lower than other unit tests. Worth adding if you're already in the area:

```
apps/server/test/schemas.unit.test.ts
- movePayloadSchema validates valid move payloads
- movePayloadSchema rejects missing moveId
- finishPayloadSchema accepts optional reason
- matchIdSchema validates UUID format
```

### SSE Filtering Unit Tests

The SSE per-agent filtering logic (which events get sent to which agent) was previously covered by flaky integration tests that were removed. If this logic grows in complexity, extract it into a testable function and cover it in the unit lane.

---

## Test Ratio

**Before this revision:** ~65% durable / ~35% unit
**Current:** ~32% durable / ~23% unit (server) / ~46% unit (engine)

The unit lane is now the primary lane for new server tests. The durable lane is reserved for behavior that genuinely requires the Workers runtime (DO state, D1 queries, queue flow, SSE streaming).
