# Offline Kai Gateway Quality Report

## Result

The dominant failure class is **provider invocation timeout**, not parse failure.

The new offline probe harness reproduced the live Kai failure shape on AWS
without touching Cloudflare:

- `opening` -> `provider_invocation_failure`
- `follow-up` -> `provider_invocation_failure`
- `attack-pressure` -> `provider_invocation_failure`

Each failed at the same boundary:

- `OPENCLAW_TIMEOUT_SECONDS=8`
- `KAI_GATEWAY_PROBE_PROCESS_TIMEOUT_MS=12000`
- observed latency about `12028ms` to `12063ms`

Raising the process budget for `opening` to `26000ms` still ended the same way:

- `provider_invocation_failure`
- observed latency about `26048ms`

## Evidence

### 1. The Fightclaw gateway path times out offline on every curated state

AWS probe command:

```bash
OPENCLAW_BIN=/usr/local/bin/openclaw \
OPENCLAW_AGENT_ID=main \
OPENCLAW_TIMEOUT_SECONDS=8 \
KAI_GATEWAY_PROBE_PROCESS_TIMEOUT_MS=12000 \
corepack pnpm -C apps/openclaw-runner exec tsx scripts/kai-gateway-probe.ts
```

Observed result:

- all three fixtures returned `provider_invocation_failure`
- none returned raw provider output
- all three fell back to deterministic legal moves

### 2. Kai is not completely dead on AWS

A trivial direct prompt to the same OpenClaw agent succeeded:

```bash
timeout 40s /usr/local/bin/openclaw agent \
  --agent main \
  --json \
  --timeout 30 \
  --message 'Reply with exactly this JSON and nothing else: {"ok":true}'
```

Observed result:

- returned `{"ok":true}`
- `durationMs` about `3003`
- exit code `0`

That means the local OpenClaw runtime can answer simple prompts on this host.

### 3. The failure is tied to the real Fightclaw task prompt

Measured prompt sizes for the curated fixtures:

- `opening`: `7069` chars
- `follow-up`: `5708` chars
- `attack-pressure`: `6807` chars

The prompt is dominated by serialized legal moves:

- `opening`: `legalMoves` payload about `5873` chars
- `follow-up`: `legalMoves` payload about `4468` chars
- `attack-pressure`: `legalMoves` payload about `5560` chars

### 4. One narrow gateway compaction experiment did not help

I tested an uncommitted prompt compaction experiment that replaced full move
objects with compact indexed choices (`moveIndex` instead of `move`) and reran
the AWS probe.

Outcome:

- the failure class did **not** change
- `opening`, `follow-up`, and `attack-pressure` still timed out at the same
  `12000ms` boundary
- `opening` still timed out at `26000ms`

That experiment is not kept in the branch.

## Conclusion

This branch should remain **diagnostic-only** after the offline harness work.

What is proven:

- Kai’s live Fightclaw failures are not primarily JSON parse problems
- the offline AWS issue is broader than one tiny gateway normalization bug
- the current Fightclaw prompt/task load is enough to push Kai into provider
  invocation timeout on the tiny AWS box

What is **not** proven:

- that one small Fightclaw gateway change can make Kai reliable on this host

## Recommended Next Step

Do **not** keep cutting Fightclaw gateway code in this branch.

The next useful slice should be outside the Fightclaw transport layer:

- create a leaner Kai OpenClaw agent profile with much less workspace/tool
  context, or
- try the same offline probe against a second real OpenClaw agent such as
  `Mr. Smith`, or
- move the Kai runtime to a less resource-constrained host

The new offline harness is now in place to evaluate any of those options
without spending Cloudflare quota.
