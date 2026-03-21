# First-Move Latency Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce first-move latency by ~1.5-3.5s by parallelizing fetches, caching SSE state, and pre-compiling the gateway script.

**Architecture:** Three independent optimizations to the runner and agent-client packages. Changes are additive — no behavioral changes to move selection logic. Each optimization can be deployed independently.

**Tech Stack:** TypeScript, Node.js test runner, esbuild, pnpm workspace

**Spec:** `docs/superpowers/specs/2026-03-21-first-move-latency-reduction-design.md`

---

## File Structure

**Modified files:**
- `packages/agent-client/src/types.ts` — extend `MoveProviderContext` with SSE cache fields
- `packages/agent-client/src/runner.ts` — capture SSE state events, pass to move provider
- `apps/openclaw-runner/src/cli.ts` — parallel fetch, SSE cache consumption
- `apps/openclaw-runner/src/beta.ts` — SSE cache consumption (simpler path)
- `apps/openclaw-runner/package.json` — add esbuild, build:gateway script

**New files:**
- `apps/openclaw-runner/test/cli-latency.test.ts` — tests for parallel fetch + SSE cache

**Context files (read-only reference):**
- `apps/openclaw-runner/test/cli.test.ts` — existing test patterns
- `apps/openclaw-runner/src/match-context.ts` — `MatchContextStore.buildTurnContext` API
- `apps/server/src/do/MatchDO.ts:1313-1347` — `broadcastState`/`broadcastYourTurn` for SSE shape reference
- `packages/protocol/src/index.ts:46-51` — `StateEvent` type definition

---

### Task 1: Extend MoveProviderContext with SSE cache fields

**Files:**
- Modify: `packages/agent-client/src/types.ts:112-116`

- [ ] **Step 1: Add optional SSE cache fields to MoveProviderContext**

In `packages/agent-client/src/types.ts`, extend `MoveProviderContext`:

```typescript
export type MoveProviderContext = {
	agentId: string;
	matchId: string;
	stateVersion: number;
	/** Raw game state from the most recent SSE "state" event, if version matches. */
	lastKnownGame?: unknown;
	/** stateVersion of the cached lastKnownGame. */
	lastKnownGameVersion?: number;
};
```

- [ ] **Step 2: Run type check**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6 && pnpm -C packages/agent-client exec tsc --noEmit`
Expected: PASS (new fields are optional, no consumers break)

- [ ] **Step 3: Run existing tests to verify no breakage**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/apps/openclaw-runner && tsx --test test/cli.test.ts`
Expected: All existing tests PASS

- [ ] **Step 4: Commit**

```bash
git add packages/agent-client/src/types.ts
git commit -m "feat(agent-client): add SSE cache fields to MoveProviderContext"
```

---

### Task 2: Capture SSE state events in runner.ts

**Files:**
- Modify: `packages/agent-client/src/runner.ts:490-530`

- [ ] **Step 1: Add SSE state cache variables**

In `runner.ts`, inside `runMatch` after line 493 (`let settled = false;`), add:

```typescript
let cachedGame: unknown = undefined;
let cachedGameVersion = -1;
```

- [ ] **Step 2: Capture state events in handleEvent**

In `handleEvent` (line 604), add state caching BEFORE the existing `your_turn` check. After the terminal/error checks (after line 621), insert:

```typescript
if (event.event === "state" && event.payload) {
	const payload = event.payload as { state?: unknown };
	if (payload.state !== undefined) {
		cachedGame = payload.state;
		cachedGameVersion = typeof event.stateVersion === "number" ? event.stateVersion : -1;
	}
}
```

- [ ] **Step 3: Pass cached state to resolveMove**

In `resolveMove` (line 414), update the `moveContext` construction to include cache fields:

```typescript
const moveContext: MoveProviderContext = {
	agentId,
	matchId,
	stateVersion,
	...(cachedGameVersion === stateVersion && cachedGame !== undefined
		? { lastKnownGame: cachedGame, lastKnownGameVersion: cachedGameVersion }
		: {}),
};
```

Update the `if` block (lines 420-425) and the `Promise.race` block (line 434-435) to pass `moveContext` instead of constructing it inline. The existing code builds the context object inline — replace both occurrences.

- [ ] **Step 4: Run type check**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6 && pnpm -C packages/agent-client exec tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Run existing tests**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/apps/openclaw-runner && tsx --test test/cli.test.ts`
Expected: All existing tests PASS (new fields are optional, consumers haven't changed yet)

- [ ] **Step 6: Commit**

```bash
git add packages/agent-client/src/runner.ts
git commit -m "feat(agent-client): cache SSE state events and pass to move provider"
```

---

### Task 3: Write tests for SSE cache and parallel fetch

**Files:**
- Create: `apps/openclaw-runner/test/cli-latency.test.ts`

- [ ] **Step 1: Write test — SSE cache hit skips HTTP fetch**

Create `apps/openclaw-runner/test/cli-latency.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createInitialState,
	listLegalMoves,
	type Move,
} from "@fightclaw/engine";
import { createMoveProvider } from "../src/cli";

const createStateResponse = (args?: {
	game?: ReturnType<typeof createInitialState>;
	turnExpiresAtMs?: number;
}) => ({
	state: {
		stateVersion: 1,
		status: "active" as const,
		game:
			args?.game ?? createInitialState(1, undefined, ["agent-a", "agent-b"]),
	},
	...(typeof args?.turnExpiresAtMs === "number"
		? { turnExpiresAtMs: args.turnExpiresAtMs }
		: {}),
});

const createTestContextStore = () =>
	({
		buildTurnContext: async () => undefined,
	}) as never;

test("SSE cache hit: skips getMatchState when lastKnownGame is provided", async () => {
	let httpFetchCount = 0;
	const game = createInitialState(1, undefined, ["agent-a", "agent-b"]);
	const legalMoves = listLegalMoves(game);
	const firstLegal = legalMoves[0];
	assert.ok(firstLegal);

	const client = {
		getMatchState: async () => {
			httpFetchCount += 1;
			return createStateResponse({ game });
		},
	} as never;

	const provider = createMoveProvider(
		client,
		"agent-a",
		"Agent A",
		"strategy",
		createTestContextStore(),
		"fake-gateway",
		{
			invokeGatewayImpl: async () => ({
				move: firstLegal,
				publicThought: "Good move.",
			}),
		},
	);

	await provider.nextMove({
		matchId: "match-1",
		stateVersion: 1,
		lastKnownGame: game,
		lastKnownGameVersion: 1,
	});

	assert.equal(httpFetchCount, 0, "Should not call getMatchState when SSE cache is fresh");
});

test("SSE cache miss: falls back to HTTP when version mismatches", async () => {
	let httpFetchCount = 0;
	const game = createInitialState(1, undefined, ["agent-a", "agent-b"]);
	const legalMoves = listLegalMoves(game);
	const firstLegal = legalMoves[0];
	assert.ok(firstLegal);

	const client = {
		getMatchState: async () => {
			httpFetchCount += 1;
			return createStateResponse({ game });
		},
	} as never;

	const provider = createMoveProvider(
		client,
		"agent-a",
		"Agent A",
		"strategy",
		createTestContextStore(),
		"fake-gateway",
		{
			invokeGatewayImpl: async () => ({
				move: firstLegal,
				publicThought: "Good move.",
			}),
		},
	);

	await provider.nextMove({
		matchId: "match-1",
		stateVersion: 2,
		lastKnownGame: game,
		lastKnownGameVersion: 1,
	});

	assert.equal(httpFetchCount, 1, "Should call getMatchState when SSE cache version mismatches");
});

test("SSE cache absent: falls back to HTTP when no cached state", async () => {
	let httpFetchCount = 0;
	const game = createInitialState(1, undefined, ["agent-a", "agent-b"]);
	const legalMoves = listLegalMoves(game);
	const firstLegal = legalMoves[0];
	assert.ok(firstLegal);

	const client = {
		getMatchState: async () => {
			httpFetchCount += 1;
			return createStateResponse({ game });
		},
	} as never;

	const provider = createMoveProvider(
		client,
		"agent-a",
		"Agent A",
		"strategy",
		createTestContextStore(),
		"fake-gateway",
		{
			invokeGatewayImpl: async () => ({
				move: firstLegal,
				publicThought: "Good move.",
			}),
		},
	);

	await provider.nextMove({
		matchId: "match-1",
		stateVersion: 1,
	});

	assert.equal(httpFetchCount, 1, "Should call getMatchState when no SSE cache");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/apps/openclaw-runner && tsx --test test/cli-latency.test.ts`
Expected: First test FAILS (SSE cache not consumed yet — `getMatchState` still called). Other two may pass since they expect HTTP fallback.

- [ ] **Step 3: Write test — multi-action turn: second action falls back to HTTP**

Add to the same file:

```typescript
test("SSE cache: second action in turn falls back to HTTP (version advanced)", async () => {
	let httpFetchCount = 0;
	const game = createInitialState(1, undefined, ["agent-a", "agent-b"]);
	const legalMoves = listLegalMoves(game);
	const firstLegal = legalMoves[0];
	assert.ok(firstLegal);

	const client = {
		getMatchState: async () => {
			httpFetchCount += 1;
			return createStateResponse({ game });
		},
	} as never;

	const provider = createMoveProvider(
		client,
		"agent-a",
		"Agent A",
		"strategy",
		createTestContextStore(),
		"fake-gateway",
		{
			invokeGatewayImpl: async () => ({
				move: firstLegal,
				publicThought: "Good move.",
			}),
		},
	);

	// First action: SSE cache hit (version 1 matches)
	await provider.nextMove({
		matchId: "match-1",
		stateVersion: 1,
		lastKnownGame: game,
		lastKnownGameVersion: 1,
	});
	assert.equal(httpFetchCount, 0, "First action should use SSE cache");

	// Second action: version advanced to 2, but SSE cache still has version 1
	await provider.nextMove({
		matchId: "match-1",
		stateVersion: 2,
		lastKnownGame: game,
		lastKnownGameVersion: 1,
	});
	assert.equal(httpFetchCount, 1, "Second action should fall back to HTTP");
});
```

- [ ] **Step 5: Write test — parallel fetch: context build failure is non-fatal**

Add to the same file:

```typescript
test("parallel fetch: context build failure does not prevent move selection", async () => {
	const game = createInitialState(1, undefined, ["agent-a", "agent-b"]);
	const legalMoves = listLegalMoves(game);
	const firstLegal = legalMoves[0];
	assert.ok(firstLegal);

	const client = {
		getMatchState: async () => createStateResponse({ game }),
	} as never;

	const failingContextStore = {
		buildTurnContext: async () => {
			throw new Error("Context build failed");
		},
	} as never;

	const provider = createMoveProvider(
		client,
		"agent-a",
		"Agent A",
		"strategy",
		failingContextStore,
		"fake-gateway",
		{
			invokeGatewayImpl: async (_cmd: string, input: Record<string, unknown>) => {
				assert.equal(input.turnContext, undefined, "turnContext should be undefined when build fails");
				return {
					move: firstLegal,
					publicThought: "Good move.",
				};
			},
		},
	);

	const move = await provider.nextMove({
		matchId: "match-1",
		stateVersion: 1,
	});

	assert.ok(move, "Move should still be selected despite context build failure");
});
```

- [ ] **Step 6: Run all new tests to confirm expected failures**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/apps/openclaw-runner && tsx --test test/cli-latency.test.ts`
Expected: SSE cache hit test FAILS. Others may pass or fail depending on current error handling.

- [ ] **Step 7: Commit test file**

```bash
git add apps/openclaw-runner/test/cli-latency.test.ts
git commit -m "test: add failing tests for SSE cache and parallel fetch"
```

---

### Task 4: Implement SSE cache consumption in cli.ts createMoveProvider

**Files:**
- Modify: `apps/openclaw-runner/src/cli.ts:605-610`

- [ ] **Step 1: Add SSE cache check at the top of nextMove**

In `createMoveProvider` (cli.ts), replace the current `nextMove` opening (lines 605-611):

```typescript
// Current:
nextMove: async ({ matchId, stateVersion }: MoveProviderContext) => {
	const state = await client.getMatchState(matchId);
	const game = (state.state?.game ?? null) as { ... } | null;
```

With:

```typescript
nextMove: async (context: MoveProviderContext) => {
	const { matchId, stateVersion } = context;

	// Use SSE-cached game if version matches (saves ~100ms HTTP round-trip)
	const useCache =
		context.lastKnownGame !== undefined &&
		context.lastKnownGameVersion === stateVersion;

	const state = useCache
		? {
				state: {
					stateVersion,
					status: "active" as const,
					game: context.lastKnownGame,
				},
			}
		: await client.getMatchState(matchId);

	const game = (state.state?.game ?? null) as {
		actionsRemaining?: number;
		turn?: number;
		activePlayer?: string;
	} | null;
```

Note: When using the SSE cache, `turnExpiresAtMs` is absent. `getRemainingTurnBudgetMs` will return `null`, causing `resolveEffectiveGatewayTimeoutMs` to use `baseGatewayTimeoutMs` without budget capping. This is correct for the first action of a turn (full 60s budget available).

- [ ] **Step 2: Run the SSE cache tests**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/apps/openclaw-runner && tsx --test test/cli-latency.test.ts`
Expected: All SSE cache tests PASS

- [ ] **Step 3: Run all existing tests**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/apps/openclaw-runner && tsx --test test/cli.test.ts`
Expected: All existing tests PASS (they don't provide `lastKnownGame`, so they hit HTTP fallback)

- [ ] **Step 4: Commit**

```bash
git add apps/openclaw-runner/src/cli.ts
git commit -m "feat(openclaw-runner): consume SSE-cached game state in createMoveProvider"
```

---

### Task 5: Implement parallel fetch in cli.ts createMoveProvider

**Files:**
- Modify: `apps/openclaw-runner/src/cli.ts:656-666`

- [ ] **Step 1: Launch context build in parallel with state fetch**

In the `nextMove` function, the current sequential flow (around lines 656-666) is:

```typescript
if (gatewayCmd) {
	let turnContext: unknown;
	try {
		turnContext = await matchContextStore.buildTurnContext({
			matchId,
			agentId,
			state,
		});
	} catch {
		turnContext = undefined;
	}
```

Restructure the function so context build starts BEFORE the state fetch (or concurrently if no SSE cache). Move the context build launch to before the state fetch:

```typescript
// Launch context build early — runs in parallel with state fetch (non-fatal)
const turnContextPromise = gatewayCmd
	? matchContextStore
			.buildTurnContext({ matchId, agentId })
			.catch(() => undefined)
	: Promise.resolve(undefined);

// ... state fetch (SSE cache or HTTP) happens here ...
// ... legal moves, budget computation ...

// Await the already-in-flight context build
let turnContext: unknown;
try {
	const partialContext = await turnContextPromise;
	if (partialContext && typeof partialContext === "object" && state.state) {
		const gameObj = state.state.game as {
			turn?: number;
			actionsRemaining?: number;
			activePlayer?: string;
		} | undefined;
		if (gameObj) {
			(partialContext as Record<string, unknown>).current = {
				...(typeof gameObj.turn === "number" ? { turn: gameObj.turn } : {}),
				...(typeof gameObj.actionsRemaining === "number"
					? { actionsRemaining: gameObj.actionsRemaining }
					: {}),
				...(typeof gameObj.activePlayer === "string"
					? { activePlayer: gameObj.activePlayer }
					: {}),
			};
		}
	}
	turnContext = partialContext;
} catch {
	turnContext = undefined;
}
```

The key change: `buildTurnContext` is called WITHOUT `state` (so it proceeds with its HTTP call immediately) and we patch `current` from the state after both resolve.

- [ ] **Step 2: Run all latency tests**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/apps/openclaw-runner && tsx --test test/cli-latency.test.ts`
Expected: All PASS (including context-build-failure test)

- [ ] **Step 3: Run all existing tests**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/apps/openclaw-runner && tsx --test test/cli.test.ts`
Expected: All PASS

- [ ] **Step 4: Run full test suite**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/apps/openclaw-runner && tsx --test test/**/*.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add apps/openclaw-runner/src/cli.ts
git commit -m "feat(openclaw-runner): parallelize state fetch and context build"
```

---

### Task 6: Implement SSE cache consumption in beta.ts

**Files:**
- Modify: `apps/openclaw-runner/src/beta.ts:356-357` (createBetaMoveProvider — the production path)
- Modify: `apps/openclaw-runner/src/beta.ts:482-483` (createMoveProvider — the simpler legacy path)

**Important:** `beta.ts` has TWO move providers. `createBetaMoveProvider` (line 326) is the one used in production by `runTesterBetaJourney` and `runHouseOpponent`. `createMoveProvider` (line 476) is a simpler legacy path. Both need the SSE cache.

- [ ] **Step 1: Add SSE cache check to createBetaMoveProvider**

In `beta.ts`, the `createBetaMoveProvider` function (line 326) has `nextMove` at line 356. Update it:

```typescript
// Current (line 356-357):
nextMove: async ({ matchId, stateVersion }: MoveProviderContext) => {
	const state = await client.getMatchState(matchId);

// After:
nextMove: async (context: MoveProviderContext) => {
	const { matchId, stateVersion } = context;
	const useCache =
		context.lastKnownGame !== undefined &&
		context.lastKnownGameVersion === stateVersion;
	const state = useCache
		? {
				state: {
					stateVersion,
					status: "active" as const,
					game: context.lastKnownGame,
				},
			}
		: await client.getMatchState(matchId);
```

- [ ] **Step 2: Add SSE cache check to createMoveProvider (legacy)**

Same pattern for the simpler `createMoveProvider` at line 482:

```typescript
// Current (line 482-483):
nextMove: async ({ matchId, stateVersion }: MoveProviderContext) => {
	const state = await client.getMatchState(matchId);

// After:
nextMove: async (context: MoveProviderContext) => {
	const { matchId, stateVersion } = context;
	const useCache =
		context.lastKnownGame !== undefined &&
		context.lastKnownGameVersion === stateVersion;
	const state = useCache
		? {
				state: {
					stateVersion,
					status: "active" as const,
					game: context.lastKnownGame,
				},
			}
		: await client.getMatchState(matchId);
```

- [ ] **Step 3: Run beta tests**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/apps/openclaw-runner && tsx --test test/beta.test.ts`
Expected: All PASS

- [ ] **Step 4: Run type check**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/apps/openclaw-runner && pnpm check-types`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/openclaw-runner/src/beta.ts
git commit -m "feat(openclaw-runner): consume SSE-cached state in both beta move providers"
```

---

### Task 7: Add esbuild and build:gateway script

**Files:**
- Modify: `apps/openclaw-runner/package.json`

- [ ] **Step 1: Add esbuild devDependency and build script**

Update `apps/openclaw-runner/package.json`:

```json
{
	"name": "@fightclaw/openclaw-runner",
	"private": true,
	"version": "0.0.0",
	"type": "module",
	"scripts": {
		"check-types": "tsc --noEmit",
		"test": "tsx --test test/**/*.test.ts",
		"build:gateway": "esbuild scripts/gateway-openclaw-agent.ts scripts/gateway-move.ts --bundle --platform=node --format=esm --outdir=dist --out-extension:.js=.mjs --packages=external"
	},
	"dependencies": {
		"@fightclaw/agent-client": "workspace:*",
		"@fightclaw/engine": "workspace:*",
		"openclaw": "^2026.2.17"
	},
	"devDependencies": {
		"@fightclaw/config": "workspace:*",
		"@types/node": "catalog:",
		"esbuild": "^0.25.0",
		"tsx": "^4.19.2",
		"typescript": "catalog:"
	}
}
```

Note: `--packages=external` keeps workspace dependencies (`@fightclaw/engine`) as external imports resolved at runtime from `node_modules`. This avoids bundling the engine twice.

- [ ] **Step 2: Install the new dependency**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6 && pnpm install`
Expected: esbuild installed, lockfile updated

- [ ] **Step 3: Run the build**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/apps/openclaw-runner && pnpm build:gateway`
Expected: Creates `dist/gateway-openclaw-agent.mjs` and `dist/gateway-move.mjs`

- [ ] **Step 4: Verify the compiled gateway script works**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/apps/openclaw-runner && echo '{}' | node dist/gateway-openclaw-agent.mjs`
Expected: JSON output with a fallback move (state unavailable path)

- [ ] **Step 5: Verify the compiled gateway-move script works**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/apps/openclaw-runner && echo '{}' | node dist/gateway-move.mjs`
Expected: JSON output with end_turn fallback

- [ ] **Step 6: Ensure dist/ is gitignored**

Check if there's already a `.gitignore` in the runner package or monorepo root that covers `dist/`. If not, add `dist/` to `apps/openclaw-runner/.gitignore`.

- [ ] **Step 7: Commit**

```bash
git add apps/openclaw-runner/package.json pnpm-lock.yaml
git add apps/openclaw-runner/.gitignore  # if created
git commit -m "feat(openclaw-runner): add esbuild gateway compilation"
```

---

### Task 8: Run full test suite and type check

**Files:** (none — verification only)

- [ ] **Step 1: Run all openclaw-runner tests**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/apps/openclaw-runner && tsx --test test/**/*.test.ts`
Expected: All PASS

- [ ] **Step 2: Run agent-client type check**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6 && pnpm -C packages/agent-client exec tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Run openclaw-runner type check**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/apps/openclaw-runner && pnpm check-types`
Expected: PASS

- [ ] **Step 4: Run engine tests (sanity check)**

Run: `cd /Users/bgciv/Dev/fightclaw-model-opus-4-6/packages/engine && bun test`
Expected: All PASS (engine unchanged, but verify no workspace breakage)

- [ ] **Step 5: Commit summary**

No new commit — this is verification only. If anything fails, fix and commit the fix.
