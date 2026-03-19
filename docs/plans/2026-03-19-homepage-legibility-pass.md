# Homepage Legibility Pass Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the homepage spectator presentation into a board-first broadcast desk that makes featured state, recent actions, public commentary, and final results clear without changing any live/replay/state contracts.

**Architecture:** Keep `apps/web/src/routes/index.tsx` as the existing live/replay orchestration layer and add a thin presentation-projection layer that feeds a richer `SpectatorArena` shell. The board remains the visual anchor, while new presentational components render agent cards, a short action ticker, and a terminal result band from the current canonical event stream and state snapshots.

**Tech Stack:** React 19, TanStack Router, existing web route state, CSS in `apps/web/src/index.css`, existing board animation stack, browser/manual verification plus `pnpm -C apps/web check-types`.

---

### Task 1: Add a homepage broadcast projection layer

**Files:**
- Create: `apps/web/src/lib/spectator-desk.ts`
- Modify: `apps/web/src/routes/index.tsx`

**Step 1: Add the presentation model**

Create a small helper module that derives:

- featured desk label/state
- agent card stats from `latestState`
- derived style tag per side
- latest public commentary per side
- ticker items from `engine_events`
- terminal result summary from `match_ended` and final state

Keep all inputs limited to the route’s current state and canonical envelopes. No new fetches, no new backend fields.

**Step 2: Move inline route derivation into the helper**

Refactor `apps/web/src/routes/index.tsx` so it:

- keeps the current SSE/replay/state handling intact
- stores the minimal source state it already has
- derives broadcast-desk props through the helper instead of computing ad hoc UI bits inline

Do not change the route’s transport or replay behavior.

**Step 3: Verify TypeScript contracts**

Run:

```bash
pnpm -C apps/web check-types
```

Expected: PASS. Fix any route/component contract drift before moving on.

**Step 4: Commit**

```bash
git add apps/web/src/lib/spectator-desk.ts apps/web/src/routes/index.tsx
git commit -m "feat(web): add spectator desk projections"
```

### Task 2: Build the broadcast-desk components

**Files:**
- Create: `apps/web/src/components/arena/agent-broadcast-card.tsx`
- Create: `apps/web/src/components/arena/action-ticker.tsx`
- Create: `apps/web/src/components/arena/result-band.tsx`
- Modify: `apps/web/src/components/arena/spectator-arena.tsx`
- Optionally modify: `apps/web/src/components/arena/thought-panel.tsx`

**Step 1: Add the agent broadcast card**

Implement a compact presentational card that renders:

- side / label
- short player label
- derived style tag
- key stats: gold, wood, unit count, VP
- latest public commentary line

Do not turn it into a debug panel or a scroll log.

**Step 2: Add the action ticker**

Implement a focused ticker component that renders:

- short human-readable action lines
- strict recency cap of roughly 5 to 8 items
- seat-aware coloring / emphasis

The ticker must be a spectator projection, not a raw JSON/event dump.

**Step 3: Add the result band**

Implement a terminal result band that renders:

- winner / loser
- outcome reason
- compact final summary

This component should become visually dominant when the match ends.

**Step 4: Expand `SpectatorArena` into the broadcast desk shell**

Refactor `spectator-arena.tsx` so it composes:

- route-level match strip
- board stage
- left/right agent cards
- bottom ticker
- terminal result band

Keep the board stage central and dominant. The board must not shrink into a dashboard tile.

**Step 5: Verify TypeScript contracts**

Run:

```bash
pnpm -C apps/web check-types
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/web/src/components/arena/agent-broadcast-card.tsx apps/web/src/components/arena/action-ticker.tsx apps/web/src/components/arena/result-band.tsx apps/web/src/components/arena/spectator-arena.tsx apps/web/src/components/arena/thought-panel.tsx
git commit -m "feat(web): add broadcast desk components"
```

### Task 3: Restyle the homepage into a board-first broadcast desk

**Files:**
- Modify: `apps/web/src/index.css`
- Optionally modify: `apps/web/src/components/arena/hex-board.tsx`

**Step 1: Redesign the layout CSS**

Update the spectator layout styles so the homepage reads like a broadcast desk:

- stronger match strip hierarchy
- central board stage
- slimmer, higher-signal side cards
- ticker lane beneath the board
- terminal result band treatment

Reuse the current dark terminal visual language. Do not switch themes or add a new design system.

**Step 2: Add responsive collapse rules**

Make sure the layout stays board-first on smaller screens:

- desktop: full desk
- tablet: compressed desk
- mobile: board first, stacked info below

**Step 3: Preserve board dominance**

If needed, make small board-shell adjustments, but do not move gameplay rendering logic into CSS-driven layout code. The board should remain the visual hero.

**Step 4: Verify CSS and type safety**

Run:

```bash
pnpm -C apps/web check-types
pnpm exec biome check apps/web/src/index.css apps/web/src/components/arena/spectator-arena.tsx apps/web/src/components/arena/agent-broadcast-card.tsx apps/web/src/components/arena/action-ticker.tsx apps/web/src/components/arena/result-band.tsx apps/web/src/lib/spectator-desk.ts apps/web/src/routes/index.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/index.css apps/web/src/components/arena/hex-board.tsx
git commit -m "feat(web): restyle homepage as broadcast desk"
```

### Task 4: Verify live, replay, and terminal legibility in the browser

**Files:**
- Modify if needed: `apps/web/src/routes/index.tsx`
- Modify if needed: `apps/web/src/lib/spectator-desk.ts`
- Modify if needed: `apps/web/src/components/arena/*`

**Step 1: Run the local app**

Use the existing server/web dev flow for manual verification.

Suggested commands:

```bash
pnpm run dev:server
pnpm run dev:web
```

**Step 2: Verify the featured live path**

Check in the browser that:

- featured/live strip is clear
- board remains visually dominant
- agent cards read as broadcast cards, not logs
- ticker items are short and readable

**Step 3: Verify replay override behavior**

Check that replay still renders through the same desk layout and is clearly marked as replay/follow-live.

**Step 4: Verify terminal result behavior**

Use a completed match or terminal replay and confirm:

- result band becomes dominant
- winner and reason are obvious
- board remains visible as supporting context

**Step 5: Run final verification**

Run:

```bash
pnpm -C apps/web check-types
pnpm exec biome check apps/web/src/index.css apps/web/src/components/arena apps/web/src/lib/spectator-desk.ts apps/web/src/routes/index.tsx
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/web/src/index.css apps/web/src/components/arena apps/web/src/lib/spectator-desk.ts apps/web/src/routes/index.tsx
git commit -m "chore(web): verify homepage legibility pass"
```

### Task 5: Final branch verification and review checkpoint

**Files:**
- Review only

**Step 1: Verify worktree cleanliness**

Run:

```bash
git status --short
```

Expected: empty output.

**Step 2: Re-run final branch checks**

Run:

```bash
pnpm -C apps/web check-types
pnpm exec biome check apps/web/src/index.css apps/web/src/components/arena apps/web/src/lib/spectator-desk.ts apps/web/src/routes/index.tsx
```

Expected: PASS.

**Step 3: Manual acceptance check**

Confirm all branch goals are visibly satisfied:

- featured match clarity
- recent events/ticker clarity
- public commentary clarity
- obvious end-state/result visibility
- board remains visually dominant

**Step 4: Commit if anything changed during review**

```bash
git add apps/web/src/index.css apps/web/src/components/arena apps/web/src/lib/spectator-desk.ts apps/web/src/routes/index.tsx
git commit -m "fix(web): polish homepage legibility desk"
```

Skip this step if no review changes were needed.
