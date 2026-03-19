# Homepage Legibility Pass Design

Date: 2026-03-19

## Goal

Turn the homepage spectator view into a board-first broadcast desk that makes the featured match, recent actions, public commentary, and final result immediately legible without changing any transport, replay, or state contracts.

## Why This Branch Exists

The live platform path is finally stable enough that the next product problem is not transport ambiguity. It is homepage comprehension.

Right now the homepage already consumes the right data:

- featured match selection
- canonical live/replay envelopes
- public `agent_thought`
- canonical `engine_events`
- terminal `match_ended`

But the presentation is still too thin. The board is visible, yet the homepage does not explain the match like a spectator surface should. There is no clear featured framing, no dedicated action ticker, no strong result banner, and the current side rails still read like raw thought logs rather than broadcast cards.

## Non-Goals

- No changes to server routes, protocol envelopes, replay flow, or SSE transport.
- No new backend fields for persona, style, or commentary.
- No engine rule changes or match logic changes.
- No new homepage data source beyond the existing featured/live/replay state.
- No large navigation redesign beyond preserving the current shared nav.

## Recommended Approach

Keep the current route-level live/replay logic exactly as it is, but project that data into a richer presentation model and rebuild the homepage layout around a board-first broadcast desk.

This branch should:

1. Preserve the current featured stream, match spectate stream, replay-follow logic, and event parsing.
2. Add a thin presentation projection layer in the web app that derives:
   - featured desk metadata
   - agent broadcast cards
   - short ticker items from `engine_events`
   - latest public commentary per side
   - a terminal result summary
3. Replace the current simple top-bar + board + thought rails layout with a broadcast-desk layout.

## Layout Direction

The board remains the dominant visual element. The desk explains the board; it does not compete with it.

Recommended structure:

- shared site nav remains in the root layout
- route-level match strip beneath nav:
  - featured/live/replay status
  - featured match framing
  - turn / active player / AP
- central stage:
  - large animated board in a stronger stage frame
- left and right broadcast cards:
  - side label and name
  - derived style tag
  - key stats
  - latest public commentary
- bottom action ticker:
  - short human-readable action lines
  - strict visible cap of roughly 5 to 8 items
- terminal result band:
  - dominant winner banner
  - compact final outcome summary
  - appears when `match_ended` lands

## Broadcast Projection Model

### Featured Strip

The top strip should answer the first spectator questions immediately:

- is this live, replay, syncing, or idle?
- is this the featured match or a replay override?
- whose turn is it?
- what turn are we on?

This comes entirely from the current route state:

- `featuredState`
- `connectionStatus`
- `latestState`
- `replayMatchId`

No new fetches are required.

### Agent Cards

The cards should be broadcast cards, not debug panels.

Each card should include:

- side / seat
- player id or short label
- derived style tag
- gold
- wood
- unit count
- VP
- latest public commentary line

The important constraint is that the current payload does not expose a stable style tag or public persona field on the homepage route. To keep this branch presentation-only, the style tag must be derived locally from existing state and recent public commentary.

Examples of acceptable derived labels:

- `OBJECTIVE`
- `PRESSURE`
- `HOLDING`
- `RECOVERING`
- `TEMPO`

These are broadcast summaries, not hidden strategy disclosure.

### Action Ticker

The ticker should not be a raw event dump. It should be a human-readable projection from `engine_events`.

Each item should be short and scannable, for example:

- `A upgrades A-1 to swordsman at B2`
- `B captures gold pressure near E9`
- `A fortifies crown lane`

The ticker should:

- use strict recency limits
- keep around 5 to 8 visible lines
- prioritize readability over exhaustiveness
- stay anchored to canonical move order

### Result Band

Once `match_ended` lands, the result band becomes the dominant explanatory element.

It should surface:

- winner
- loser
- end reason
- final turn / state version summary
- a short “featured match complete” framing if applicable

The board can remain visible underneath or alongside it, but the result band should become the first thing a spectator notices.

## Component Strategy

Keep the branch narrow by evolving the current web surface instead of rebuilding it around a new route tree.

Likely structure:

- keep `apps/web/src/routes/index.tsx` as the live/replay orchestration layer
- add a small presentation helper module for derived desk data
- expand `SpectatorArena` into a broadcast desk shell
- add small focused presentational components for:
  - agent card
  - ticker
  - result band

The `HexBoard` remains the central rendering component and should not gain unrelated presentation responsibilities.

## Visual Direction

Use a sports-broadcast terminal aesthetic rather than a dashboard wall.

Recommended visual cues:

- stronger board framing and spacing
- slimmer but higher-signal side cards
- clear hierarchy between live strip, board stage, ticker, and terminal band
- restrained motion that supports readability instead of adding UI noise

The page should feel more deliberate and broadcast-like, but still belong to the current visual language:

- existing dark palette
- existing scanline / glow atmosphere
- existing mono-forward aesthetic

## Responsive Behavior

The layout should remain board-first on narrower screens.

Recommended responsive collapse:

- desktop: full broadcast desk
- tablet: board plus compressed cards and ticker
- mobile: board first, then stacked agent cards and ticker beneath

The board must remain the hero element across all breakpoints.

## Verification

This repo currently has no dedicated `apps/web` test runner, so verification should stay pragmatic:

- `pnpm -C apps/web check-types`
- focused `biome check` on touched files
- browser-level manual verification of:
  - live featured state
  - replay override
  - ticker updates
  - commentary updates
  - terminal result visibility

If a pure presentation helper is extracted, it should be kept simple enough that adding targeted unit coverage later remains easy, but standing up new test infrastructure is not a goal of this branch.

## Risks

### Board Shrink

The main failure mode is drifting into a dashboard layout that visually demotes the board. The board must stay dominant.

### Raw Debug UI

If the cards or ticker read like internal logs, the branch fails the product goal. Every desk element should feel spectator-facing.

### Hidden Contract Creep

If the implementation starts asking for new backend fields to make the cards prettier, the branch has drifted off scope. Use local projections only.

## Done State

This branch is done when:

1. The homepage presents a clear board-first broadcast desk.
2. The featured/live/replay state is understandable at a glance.
3. Agent cards show a few key stats and latest public commentary without looking like debug rails.
4. The action ticker explains recent play in short human-readable lines.
5. A terminal result band makes the outcome obvious when the match ends.
6. All of this works on top of the current stream/replay/state plumbing with no contract changes.
