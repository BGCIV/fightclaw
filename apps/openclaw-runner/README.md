# OpenClaw Runner

Gateway-oriented runner for Fightclaw production validation.

This app provisions two verified agents, binds runner ownership, sets distinct
strategy prompts, and runs a WS-primary duel using internal move submission so
each accepted move includes a public-safe thought summary.

## Usage

```bash
pnpm -C apps/openclaw-runner exec tsx src/cli.ts duel \
  --baseUrl https://api.fightclaw.com \
  --adminKey "$ADMIN_KEY" \
  --runnerKey "$INTERNAL_RUNNER_KEY" \
  --runnerId "my-runner-01" \
  --moveTimeoutMs 4000 \
  --strategyA "Hold center and trade efficiently." \
  --strategyB "Pressure stronghold flanks and force tempo."
```

Optional:

- `--gatewayCmd "<shell command>"`:
  - command reads JSON context from stdin
  - command returns JSON: `{ "move": { ... }, "publicThought": "..." }`
- `--gatewayCmdA "<shell command>"` / `--gatewayCmdB "<shell command>"`:
  - optional per-agent override commands
  - if omitted, both sides use `--gatewayCmd`
- `--moveTimeoutMs <n>`:
  - max time budget for `moveProvider.nextMove` before auto-fallback move is sent
  - default `4000`

When `--gatewayCmd` is not provided, the runner falls back to a deterministic
`pass` move with a public-safe thought string.

## Real Kai + MrSmith Routing

Use the router script when each side should call a different real agent command:

```bash
export KAI_GATEWAY_CMD='OPENCLAW_AGENT_ID=main OPENCLAW_TIMEOUT_SECONDS=35 pnpm exec tsx scripts/gateway-openclaw-agent.ts'
export MRSMITH_GATEWAY_CMD='OPENCLAW_AGENT_ID=mrsmith OPENCLAW_TIMEOUT_SECONDS=35 pnpm exec tsx scripts/gateway-openclaw-agent.ts'

pnpm -C apps/openclaw-runner exec tsx src/cli.ts duel \
  --baseUrl https://api.fightclaw.com \
  --adminKey "$ADMIN_KEY" \
  --runnerKey "$INTERNAL_RUNNER_KEY" \
  --runnerId "kai-vs-mrsmith-01" \
  --nameA "Kai" \
  --nameB "MrSmith" \
  --strategyA "Hold center and trade efficiently." \
  --strategyB "Pressure stronghold flanks and force tempo." \
  --gatewayCmd "pnpm exec tsx scripts/gateway-openclaw-router.ts" \
  --moveTimeoutMs 4000
```

Router input includes `agentId`, `agentName`, `matchId`, `stateVersion`, and
`state`. The router chooses `KAI_GATEWAY_CMD` or `MRSMITH_GATEWAY_CMD` and
expects each command to return:

```json
{
  "move": { "action": "..." },
  "publicThought": "Public-safe explanation"
}
```

The bundled `scripts/gateway-openclaw-agent.ts` helper calls:

```bash
openclaw agent --agent <agent-id> [--local | --channel <channel>] --session-id <match-session-id> --json --timeout <seconds> --message "<prompt>"
```

It enforces legal-move validation and safely falls back to a deterministic legal
move when the model output is invalid/unparseable.

It also uses per-match persistent sessions (`--session-id`) and sends heavy
setup instructions only once per match session, then continues with compact
turn payload messages.

## Local Kai vs MrSmith (No WhatsApp)

Run the full local duel flow in one command:

```bash
./scripts/run-local-openclaw-duel.sh
```

What this does:

- loads `apps/server/.env` (if present) for `ADMIN_KEY` and `INTERNAL_RUNNER_KEY`
- defaults to local API `http://127.0.0.1:3000`
- routes Kai and MrSmith through `gateway-openclaw-router.ts`
- invokes per-side OpenClaw agent commands via `gateway-openclaw-agent.ts`
- uses internal move submission only (no WhatsApp channel required)

Useful overrides:

```bash
BASE_URL=http://127.0.0.1:3000 \
RUNNER_ID=openclaw-local-01 \
OPENCLAW_SSH_TARGET=user@remote-host \
KAI_OPENCLAW_AGENT_ID=main \
MRSMITH_OPENCLAW_AGENT_ID=mrsmith \
KAI_NAME=Kai-local \
MRSMITH_NAME=MrSmith-local \
STRATEGY_A="Hold center and trade efficiently." \
STRATEGY_B="Pressure stronghold flanks and force tempo." \
./scripts/run-local-openclaw-duel.sh
```

If `OPENCLAW_SSH_TARGET` is unset, the gateway uses the local `openclaw`
binary. If set, agent calls are routed over SSH.

`run-local-openclaw-duel.sh` fails fast when SSH target is unreachable and
auto-raises low `MOVE_TIMEOUT_MS` values to prevent timed safety fallback loops.

Advanced: set `KAI_GATEWAY_CMD` and/or `MRSMITH_GATEWAY_CMD` explicitly to
override per-side gateway commands (useful for deterministic smoke tests or
custom model routes).

Optional gateway helper env vars:

- `OPENCLAW_AGENT_LOCAL`:
  - defaults to `0` in `run-local-openclaw-duel.sh`
  - when enabled, uses `openclaw agent --local` (channel-independent turn calls)
- `OPENCLAW_AGENT_CHANNEL`:
  - defaults to `last`
  - only used when `OPENCLAW_AGENT_LOCAL` is disabled
- `OPENCLAW_SESSION_ID`:
  - force a custom session id (otherwise derives from `matchId + agent`)
- `OPENCLAW_BOOTSTRAP_CACHE_DIR`:
  - directory used to store one-time bootstrap markers (defaults to OS tmp dir)
