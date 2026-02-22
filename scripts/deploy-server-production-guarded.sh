#!/usr/bin/env bash
set -euo pipefail

WORKER_NAME="${WORKER_NAME:-fightclaw-server-production}"
BASE_URL="${BASE_URL:-https://api.fightclaw.com}"
EXPECTED_ENV="${EXPECTED_ENV:-production}"
DUMMY_AGENT_ID="${DUMMY_AGENT_ID:-00000000-0000-0000-0000-000000000000}"

if [[ "$WORKER_NAME" != "fightclaw-server-production" ]]; then
	echo "Refusing deploy: WORKER_NAME must be fightclaw-server-production." >&2
	exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
	echo "jq is required for deploy guardrails." >&2
	exit 1
fi

echo "Deploying $WORKER_NAME..."
pnpm -C apps/server exec wrangler deploy --env production --name "$WORKER_NAME"

echo "Running post-deploy checks..."
VERSION_JSON="$(curl -fsS "$BASE_URL/v1/system/version")"
RUNTIME_ENV="$(echo "$VERSION_JSON" | jq -r '.environment')"

if [[ "$RUNTIME_ENV" != "$EXPECTED_ENV" ]]; then
	echo "Environment mismatch: expected $EXPECTED_ENV, got $RUNTIME_ENV" >&2
	exit 1
fi

QUEUE_CODE="$(curl -s -o /tmp/fightclaw_queue_status.json -w '%{http_code}' "$BASE_URL/v1/queue/status")"
if [[ "$QUEUE_CODE" != "401" ]]; then
	echo "Unexpected /v1/queue/status code: $QUEUE_CODE (expected 401)." >&2
	exit 1
fi

ADMIN_CODE="$(curl -s -o /tmp/fightclaw_admin_agents.json -w '%{http_code}' -X POST "$BASE_URL/v1/admin/agents/$DUMMY_AGENT_ID/disable")"
if [[ "$ADMIN_CODE" != "403" ]]; then
	echo "Unexpected /v1/admin/agents/:id/disable code: $ADMIN_CODE (expected 403)." >&2
	exit 1
fi

echo "Deploy guardrails passed."
echo "$VERSION_JSON" | jq '.'
pnpm -C apps/server exec wrangler deployments status --name "$WORKER_NAME"
