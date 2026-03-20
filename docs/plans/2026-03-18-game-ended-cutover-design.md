# Game Ended Alias Cutover Design

## Goal

Remove `game_ended` from the public contract and codebase so `match_ended` is
the only terminal match event everywhere: protocol, server emission, clients,
replay/live consumers, docs, and tests.

## Why Now

The reconnect/resume pass is now stabilized, so the remaining terminal-event
surface should become simpler instead of carrying one last compatibility alias.
The repo explicitly prefers hard cutovers over backward compatibility, and
`game_ended` is now just redundant public surface area.

## In Scope

- Remove `game_ended` from `@fightclaw/protocol`.
- Remove alias builders and alias emission from server live paths.
- Update runner/client/web consumers to treat `match_ended` as the only
  terminal event.
- Remove stale `game_ended` references from docs and tests.
- Verify there are no stale references in CLI, web, or replay code.

## Out Of Scope

- Any reconnect/resume changes not required by alias removal.
- New endpoints or protocol redesign.
- UI redesign or spectator behavior changes beyond consuming `match_ended`.
- Featured stream changes.

## Exact Contract Surface

- Protocol union and schemas:
  - `packages/protocol/src/index.ts`
- Server builder/emission:
  - `apps/server/src/protocol/events.ts`
  - `apps/server/src/do/MatchDO.ts`
- Consumers:
  - `packages/agent-client/src/runner.ts`
  - `apps/web/src/routes/index.tsx`
  - `packages/engine/src/index.ts`
- Docs/tests:
  - `CONTRACTS.md`
  - `apps/server/test/events.unit.test.ts`
  - `apps/server/test/durable/sse.durable.test.ts`

## Success Criteria

- `MatchEventEnvelope` no longer includes `game_ended`.
- The server never emits `event: game_ended`.
- Runner, web live view, and replay-follow logic consume only `match_ended`.
- Docs describe only `match_ended` as terminal.
- `rg -n "game_ended"` is empty or limited to intentional historical prose that
  we explicitly choose to keep.
