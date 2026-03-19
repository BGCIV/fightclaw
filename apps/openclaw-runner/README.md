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
  --strategyPresetA objective_beta \
  --strategyPresetB objective_beta
```

Optional:

- `--strategyA <text>` / `--strategyB <text>`:
  - inline private strategy text
  - use this or the matching `--strategyPreset*` flag, but not both
- `--strategyPresetA <name>` / `--strategyPresetB <name>`:
  - publish a checked-in `hex_conquest` preset artifact before the duel starts
  - current preset names come from `apps/sim/presets/hex_conquest/*.json`
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
  --strategyPresetA objective_beta \
  --strategyPresetB objective_beta \
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
openclaw agent --agent <agent-id> --json --timeout <seconds> --message "<prompt>"
```

It enforces legal-move validation and safely falls back to a deterministic legal
move when the model output is invalid/unparseable.
