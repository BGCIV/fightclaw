# Game Ended Alias Cutover Plan

1. Add RED tests for the hard cutover
   - Remove alias expectations from protocol/server unit tests.
   - Add assertions that live SSE output never contains `game_ended`.

2. Remove `game_ended` from shared contract types
   - Delete alias event types/schemas from `@fightclaw/protocol`.
   - Remove stale engine spectator schema support.

3. Remove alias emission from the server
   - Delete alias builder/export paths.
   - Stop emitting `game_ended` in MatchDO live/spectate flows.

4. Update consumers
   - Runner terminal handling uses only `match_ended`.
   - Web live and replay-follow listeners subscribe only to `match_ended`.

5. Update docs and verify stale references
   - Rewrite `CONTRACTS.md` language.
   - Run repository-wide reference check for `game_ended`.

6. Final verification
   - Focused Biome/typecheck.
   - Focused unit + durable tests for protocol/events/SSE/web-adjacent consumers.
