# First-Move Latency Reduction

**Date**: 2026-03-21
**Branch**: `model-test/opus-4-6/first-move-latency-reduction`
**Status**: Design approved (rev 2 — post spec review)

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

**Change**: Run `getMatchState` concurrently with `buildTurnContext` (without the `state` param). The state fetch remains on the critical path — legal moves, budget, turn key, gateway payload, and `singleActionTurns` all depend on it. But the context-build HTTP call (match log fetch) can run in parallel, overlapping with the state fetch.

After both resolve, patch `turnContext.current` from the fetched state.

**Error isolation**: Use individual `.catch()` wrappers, not bare `Promise.all`. A `buildTurnContext` failure must remain non-fatal (set `turnContext = undefined`), matching current behavior. A `getMatchState` failure is fatal and should propagate.

**Implementation**:
```typescript
// Launch context build in parallel (non-fatal on failure)
const turnContextPromise = gatewayCmd
  ? matchContextStore.buildTurnContext({ matchId, agentId }).catch(() => undefined)
  : Promise.resolve(undefined);

// State fetch is on the critical path — must complete before move logic
const state = await client.getMatchState(matchId);

// ... compute legal moves, budget, turn key using state ...

// Await the already-in-flight context build
let turnContext = await turnContextPromise;

// Patch current-state metadata onto context
if (turnContext && state) {
  turnContext.current = extractCurrentFromState(state);
}
```

**Savings**: ~100-300ms (match log fetch runs concurrently with state fetch).

**Risk**: Low. The two HTTP calls are independent. Context-build failure is non-fatal.

### 2. Cache state from SSE events

**Files**: `packages/agent-client/src/runner.ts`, `packages/agent-client/src/types.ts`, `apps/openclaw-runner/src/cli.ts`

**Current**: The runner receives `state` events via SSE (containing game state in `payload.state`) immediately before `your_turn` events. But `moveProvider.nextMove()` ignores this and makes a fresh HTTP GET to `getMatchState`.

#### Shape mismatch

The SSE `state` event and HTTP `getMatchState` return **different shapes**:

- **SSE `state` event** (from `broadcastState` in MatchDO): `payload.state` = the raw game object (`state.game` on server side). The envelope also carries `stateVersion` at the top level.
- **HTTP `GET /state`** response (parsed as `MatchStateResponse`): `{ state: { stateVersion, status, game, turnExpiresAtMs, players, ... } }` — the full `MatchState` object nested under `state`.

Key difference: SSE gives us `game` directly; HTTP gives us the full `MatchState` wrapper that includes `turnExpiresAtMs`, `status`, `stateVersion`, etc.

#### Approach: pass SSE game state as a separate field

Rather than trying to normalize the SSE payload into `MatchStateResponse`, we pass the raw SSE game state on `MoveProviderContext` as a new field `lastKnownGame`. The consumer (`createMoveProvider` in cli.ts) can use this directly for `listLegalMoves`, turn key computation, and the gateway payload — all of which access `state.state.game` anyway.

For fields only available from the HTTP response (`turnExpiresAtMs`, `status`), the move provider either:
- Falls back to HTTP GET (when the SSE game is absent/stale), or
- Uses conservative defaults when SSE game is present (e.g., `turnExpiresAtMs` unavailable = skip budget checks for the first action, which is safe since the turn just started and the full 60s budget is available).

**Change**:
1. In `runner.ts`, capture the most recent SSE `state` event's `payload.state` (the game object) and `stateVersion`.
2. Extend `MoveProviderContext` with optional `lastKnownGame: unknown` and `lastKnownGameVersion: number`.
3. In `createMoveProvider`, when `lastKnownGame` is present and `lastKnownGameVersion === stateVersion`, use it to compute legal moves and build the gateway payload. Skip the `getMatchState` HTTP call. Use `null` for `turnExpiresAtMs` (acceptable: first action of a turn always has full budget).
4. Fall back to HTTP GET when `lastKnownGame` is absent, version mismatches, or on second+ actions in the same turn (where the version has advanced past the SSE snapshot).

**Implementation sketch** (runner.ts):
```typescript
let cachedGame: unknown = undefined;
let cachedGameVersion = -1;

// In handleEvent:
if (event.event === "state" && event.payload) {
  cachedGame = event.payload.state;
  cachedGameVersion = event.stateVersion ?? -1;
}

// In resolveMove:
const moveContext: MoveProviderContext = {
  agentId, matchId, stateVersion,
  ...(cachedGameVersion === stateVersion
    ? { lastKnownGame: cachedGame, lastKnownGameVersion: cachedGameVersion }
    : {}),
};
```

**Implementation sketch** (cli.ts):
```typescript
// In nextMove:
let state: MatchStateResponse;
if (context.lastKnownGame && context.lastKnownGameVersion === stateVersion) {
  // Build a minimal MatchStateResponse-compatible object from SSE data
  state = {
    state: { stateVersion, status: "active", game: context.lastKnownGame },
    // turnExpiresAtMs unavailable from SSE — null is safe for first action
  };
} else {
  state = await client.getMatchState(matchId);
}
```

**Savings**: ~100ms on the first action per turn (SSE state is fresh). Subsequent actions within the same turn always fall back to HTTP (version advances after each move).

**Edge cases**:
- **Reconnection**: `sendYourTurnIfActive` on the server does NOT broadcast a `state` event before `your_turn`. On reconnect, the cache will be empty or stale, and the version check correctly triggers HTTP fallback.
- **Multi-action turns**: After the first move, `stateVersion` advances. The cached version won't match, triggering HTTP fallback. This is correct.
- **`turnExpiresAtMs` absence**: Only affects `getRemainingTurnBudgetMs`. When null, `resolveEffectiveGatewayTimeoutMs` uses `baseGatewayTimeoutMs` without budget capping, which is correct for the first action (full turn budget available).

**Risk**: Low. Version check prevents stale data. HTTP fallback preserved for all edge cases.

### 3. Pre-compile gateway script to JS

**Files**: `apps/openclaw-runner/package.json`, `apps/openclaw-runner/scripts/gateway-openclaw-agent.ts`, EC2 run scripts

**Current**: The `gatewayCmd` in production is:
```
OPENCLAW_BIN=/usr/local/bin/openclaw OPENCLAW_AGENT_ID=main OPENCLAW_TIMEOUT_SECONDS=18 \
  corepack pnpm -C apps/openclaw-runner exec tsx scripts/gateway-openclaw-agent.ts
```

`tsx` compiles TypeScript on every invocation.

**Change**:
1. Add a `build:gateway` script to `apps/openclaw-runner/package.json` using `esbuild` to compile gateway scripts to JS.
2. Output to `apps/openclaw-runner/dist/gateway-openclaw-agent.mjs` as a self-contained ESM bundle.
3. `dist/` is gitignored; operators run `pnpm -C apps/openclaw-runner build:gateway` after checkout.
4. Dev workflow still uses `tsx` for iteration; pre-compiled JS is for production only.
5. `esbuild` must externalize `@fightclaw/engine` if it contains native bindings, otherwise bundle everything.

**Savings**: ~1-3s per gateway invocation.

**Risk**: Low. The compiled JS is functionally identical. The source `.ts` files remain for development.

## Scope notes

- **`beta.ts`**: Has a similar `createMoveProvider` pattern but delegates to `createMoveProvider` from `cli.ts` internally. Changes to `cli.ts` will propagate. No separate changes needed.
- **`resolveTimeoutFallbackMove`**: The timeout fallback in cli.ts (line 578) independently calls `client.getMatchState`. This is only invoked when the move provider times out, which is a rare error path. Not optimizing this — it would add complexity for a path that shouldn't fire under normal operation.

## Out of scope

- LLM inference latency (provider-side, not addressable here)
- Gateway CLI startup overhead (Approach B — direct WS to gateway)
- Persistent agent sessions (Approach C — session reuse)
- Changes to the OpenClaw binary or skill.md distribution

## Testing

Existing tests in `apps/openclaw-runner/test/cli.test.ts` cover `createMoveProvider` with a mock `invokeGatewayImpl`. Extend with:

1. **Parallel fetch**: Verify `buildTurnContext` failure does not prevent move selection (non-fatal isolation).
2. **SSE cache hit**: Provide `lastKnownGame` + matching version; verify no HTTP call to `getMatchState`.
3. **SSE cache miss**: Provide stale `lastKnownGameVersion`; verify HTTP fallback fires.
4. **SSE cache absent**: Omit `lastKnownGame`; verify HTTP fallback fires.
5. **Multi-action turn**: Verify second action falls back to HTTP (version advanced).
6. **Gateway compilation**: Run `node dist/gateway-openclaw-agent.mjs` with piped stdin matching test fixtures; verify identical output to tsx-executed version.
7. **Integration**: Run a real match on EC2 and compare first-move latency before/after.

## Success criteria

- First-move latency reduced by 1.5-3.5s in production (measured from `your_turn` event to move submission).
- All existing tests pass unchanged or with minimal adaptation.
- No behavioral changes to move selection logic.
