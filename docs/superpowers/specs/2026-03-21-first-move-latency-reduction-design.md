# First-Move Latency Reduction

**Date**: 2026-03-21
**Branch**: `model-test/opus-4-6/first-move-latency-reduction`
**Status**: Design approved

## Problem

When an agent's turn begins, the first move takes 26-46 seconds under real AWS-hosted OpenClaw conditions. While LLM inference dominates (~15-35s), there is ~1.5-3.5s of avoidable overhead in the runner and gateway invocation path that runs sequentially before inference even starts.

### Current first-move latency chain

```
your_turn SSE event
  -> moveProvider.nextMove()
    -> client.getMatchState(matchId)              ~100ms   (HTTP GET, redundant)
    -> listLegalMoves + budget computation         ~10ms
    -> matchContextStore.buildTurnContext()         ~100-300ms (HTTP GET match log)
    -> invokeGateway(gatewayCmd, ...)              ~total gateway time:
         -> tsx compiles gateway script             ~1-3s
         -> script spawns openclaw agent CLI        ~500ms
         -> CLI connects to local gateway WS        ~50ms
         -> LLM inference                           ~15-35s
```

Steps 1, 3, and the tsx compilation in step 4 are the targets.

## Design

Three independent optimizations, each deployable separately.

### 1. Parallelize state fetch + context build

**Files**: `apps/openclaw-runner/src/cli.ts`

**Current**: `getMatchState` and `buildTurnContext` run sequentially in `createMoveProvider.nextMove()`.

**Change**: Run them concurrently via `Promise.all`. The `buildTurnContext` method only needs `matchId` and `agentId` for its HTTP call to the match log endpoint. It also accepts `state` for extracting `current.turn/actionsRemaining/activePlayer`, but this is optional metadata — the context build can proceed without it and we patch the `current` field in after the parallel fetch completes.

**Implementation**:
```typescript
// Before (sequential)
const state = await client.getMatchState(matchId);
// ... use state ...
const turnContext = await matchContextStore.buildTurnContext({ matchId, agentId, state });

// After (parallel)
const [state, partialTurnContext] = await Promise.all([
  client.getMatchState(matchId),
  matchContextStore.buildTurnContext({ matchId, agentId }),
]);
// Patch current-state metadata onto the context after both resolve
if (partialTurnContext && state) {
  partialTurnContext.current = extractCurrentFromState(state);
}
```

**Savings**: ~100-300ms (match log fetch runs concurrently with state fetch).

**Risk**: Low. The two HTTP calls are independent. The only dependency is that `current` metadata in the turn context is slightly less informative if state fetch fails, which is already handled (turnContext falls through to `undefined` on error).

### 2. Cache state from SSE events

**Files**: `packages/agent-client/src/runner.ts`, `packages/agent-client/src/types.ts`, `apps/openclaw-runner/src/cli.ts`

**Current**: The runner receives `state` events via SSE (containing full game state) immediately before `your_turn` events. But `moveProvider.nextMove()` ignores this and makes a fresh HTTP GET to `getMatchState`.

**Change**:
1. In `runner.ts`, capture the most recent SSE `state` event payload and its `stateVersion`.
2. Extend `MoveProviderContext` with an optional `lastKnownState` field.
3. In `createMoveProvider`, when `lastKnownState` is present and its version matches `stateVersion`, use it directly. Fall back to HTTP GET if absent or version mismatch.

**Implementation sketch** (runner.ts):
```typescript
// In handleEvent, before your_turn dispatch:
if (event.event === "state" && event.payload) {
  cachedState = event.payload;
  cachedStateVersion = event.stateVersion ?? -1;
}

// In resolveMove, pass cached state to moveProvider:
const moveContext = {
  agentId, matchId, stateVersion,
  lastKnownState: cachedStateVersion === stateVersion ? cachedState : undefined,
};
```

**Implementation sketch** (cli.ts createMoveProvider):
```typescript
// Use cached state if available, otherwise fetch
const state = context.lastKnownState
  ? context.lastKnownState
  : await client.getMatchState(matchId);
```

**Savings**: ~100ms per move when SSE state is fresh (always true on first move of a turn).

**Risk**: Low. The SSE `state` event is the authoritative state broadcast by the server immediately before `your_turn`. Version check ensures staleness is impossible. HTTP fallback preserved for edge cases (reconnection, missed events).

### 3. Pre-compile gateway script to JS

**Files**: `apps/openclaw-runner/package.json`, `apps/openclaw-runner/scripts/gateway-openclaw-agent.ts`, EC2 run scripts

**Current**: The `gatewayCmd` in production is:
```
OPENCLAW_BIN=/usr/local/bin/openclaw OPENCLAW_AGENT_ID=main OPENCLAW_TIMEOUT_SECONDS=18 \
  corepack pnpm -C apps/openclaw-runner exec tsx scripts/gateway-openclaw-agent.ts
```

`tsx` compiles TypeScript on every invocation.

**Change**:
1. Add a build target to `apps/openclaw-runner/package.json` that compiles the gateway scripts to JS using `esbuild` (already in the monorepo via tsup/vitest).
2. Output to `apps/openclaw-runner/dist/gateway-openclaw-agent.js` as a self-contained ESM bundle.
3. Update the EC2 run scripts to use `node dist/gateway-openclaw-agent.js` instead of `tsx scripts/gateway-openclaw-agent.ts`.

**Savings**: ~1-3s per gateway invocation.

**Risk**: Low. The compiled JS is functionally identical. The source `.ts` files remain for development. Only the production invocation path changes.

## Out of scope

- LLM inference latency (provider-side, not addressable here)
- Gateway CLI startup overhead (Approach B — direct WS to gateway)
- Persistent agent sessions (Approach C — session reuse)
- Changes to the OpenClaw binary or skill.md distribution

## Testing

- Existing tests in `apps/openclaw-runner/test/cli.test.ts` cover `createMoveProvider` with a mock `invokeGatewayImpl`. These tests will be extended to verify:
  - Parallel fetch behavior (state + context build)
  - SSE state cache hit path vs HTTP fallback
- Gateway script compilation verified by running `node dist/gateway-openclaw-agent.js` with piped stdin matching the existing test fixtures.
- Integration validation: run a real match on EC2 and compare first-move latency before/after.

## Success criteria

- First-move latency reduced by 1.5-3.5s in production (measured from `your_turn` event to move submission).
- All existing tests pass unchanged or with minimal adaptation.
- No behavioral changes to move selection logic.
