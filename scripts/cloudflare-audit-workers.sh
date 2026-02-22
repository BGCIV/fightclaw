#!/usr/bin/env bash
set -euo pipefail

LEGACY_WORKER="${LEGACY_WORKER:-fightclaw-server}"
CANONICAL_WORKER="${CANONICAL_WORKER:-fightclaw-server-production}"
CANONICAL_URL="${CANONICAL_URL:-https://api.fightclaw.com/v1/system/version}"
LEGACY_URL="${LEGACY_URL:-https://fightclaw-server.iambgc4.workers.dev/v1/system/version}"
CANONICAL_WORKERS_DEV_URL="${CANONICAL_WORKERS_DEV_URL:-https://fightclaw-server-production.iambgc4.workers.dev/v1/system/version}"
EXPECTED_ENV="${EXPECTED_ENV:-production}"
DUMMY_AGENT_ID="${DUMMY_AGENT_ID:-00000000-0000-0000-0000-000000000000}"

require_cmd() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "Missing required command: $1" >&2
		exit 1
	fi
}

check_set_contains() {
	local label="$1"
	local expected_list="$2"
	local actual_list="$3"

	local missing
	missing="$(comm -23 <(printf "%s\n" "$expected_list" | sort -u) <(printf "%s\n" "$actual_list" | sort -u) || true)"
	if [[ -n "$missing" ]]; then
		echo "Missing required $label entries:" >&2
		echo "$missing" >&2
		exit 1
	fi
}

require_cmd curl
require_cmd jq
require_cmd comm
require_cmd sort

echo "Checking canonical worker deployment..."
DEPLOYMENT_JSON="$(pnpm -C apps/server exec wrangler deployments status --name "$CANONICAL_WORKER" --json)"
VERSION_ID="$(echo "$DEPLOYMENT_JSON" | jq -r '.versions[0].version_id // empty')"
if [[ -z "$VERSION_ID" ]]; then
	echo "Unable to resolve active version for $CANONICAL_WORKER." >&2
	exit 1
fi

echo "Active version: $VERSION_ID"

echo "Checking deployed bindings and secrets..."
VERSION_JSON="$(pnpm -C apps/server exec wrangler versions view "$VERSION_ID" --name "$CANONICAL_WORKER" --json)"
ACTUAL_BINDINGS="$(echo "$VERSION_JSON" | jq -r '.resources.bindings[] | "\(.name):\(.type)"')"
EXPECTED_BINDINGS=$'DB:d1\nMATCH:durable_object_namespace\nMATCHMAKER:durable_object_namespace\nOBS:analytics_engine\nCF_VERSION_METADATA:version_metadata\nCORS_ORIGIN:plain_text\nMATCHMAKING_ELO_RANGE:plain_text\nTURN_TIMEOUT_SECONDS:plain_text\nSENTRY_ENVIRONMENT:plain_text\nSENTRY_TRACES_SAMPLE_RATE:plain_text\nADMIN_KEY:secret_text\nAPI_KEY_PEPPER:secret_text\nINTERNAL_RUNNER_KEY:secret_text\nPROMPT_ENCRYPTION_KEY:secret_text'
check_set_contains "binding" "$EXPECTED_BINDINGS" "$ACTUAL_BINDINGS"

ACTUAL_SECRETS="$(pnpm -C apps/server exec wrangler secret list --name "$CANONICAL_WORKER" | jq -r '.[].name')"
EXPECTED_SECRETS=$'ADMIN_KEY\nAPI_KEY_PEPPER\nINTERNAL_RUNNER_KEY\nPROMPT_ENCRYPTION_KEY'
check_set_contains "secret" "$EXPECTED_SECRETS" "$ACTUAL_SECRETS"

EXTRA_SECRETS="$(comm -13 <(printf "%s\n" "$EXPECTED_SECRETS" | sort -u) <(printf "%s\n" "$ACTUAL_SECRETS" | sort -u) || true)"
if [[ -n "$EXTRA_SECRETS" ]]; then
	echo "Unexpected extra secrets found on $CANONICAL_WORKER:" >&2
	echo "$EXTRA_SECRETS" >&2
	exit 1
fi

echo "Checking canonical API version..."
VERSION_ENDPOINT_JSON="$(curl -fsS "$CANONICAL_URL")"
echo "$VERSION_ENDPOINT_JSON" | jq '.'
RUNTIME_ENV="$(echo "$VERSION_ENDPOINT_JSON" | jq -r '.environment // empty')"
if [[ "$RUNTIME_ENV" != "$EXPECTED_ENV" ]]; then
	echo "Environment mismatch: expected $EXPECTED_ENV, got ${RUNTIME_ENV:-<empty>}." >&2
	exit 1
fi

echo "Checking auth guardrails on queue/admin endpoints..."
QUEUE_CODE="$(curl -s -o /tmp/fightclaw_queue_status.json -w '%{http_code}' "https://api.fightclaw.com/v1/queue/status")"
if [[ "$QUEUE_CODE" != "401" ]]; then
	echo "Unexpected /v1/queue/status code: $QUEUE_CODE (expected 401)." >&2
	exit 1
fi
ADMIN_CODE="$(curl -s -o /tmp/fightclaw_admin_agents.json -w '%{http_code}' -X POST "https://api.fightclaw.com/v1/admin/agents/$DUMMY_AGENT_ID/disable")"
if [[ "$ADMIN_CODE" != "403" ]]; then
	echo "Unexpected /v1/admin/agents/:id/disable code: $ADMIN_CODE (expected 403)." >&2
	exit 1
fi

echo "Checking legacy worker endpoint..."
LEGACY_CODE="$(curl -s -o /tmp/fightclaw_legacy_worker.json -w '%{http_code}' "$LEGACY_URL" || true)"
if [[ "$LEGACY_CODE" != "404" ]]; then
	echo "Legacy worker endpoint returned HTTP $LEGACY_CODE (expected 404)." >&2
	exit 1
fi

echo "Checking canonical workers.dev endpoint is disabled..."
CANONICAL_WORKERS_DEV_CODE="$(curl -s -o /tmp/fightclaw_canonical_workers_dev.json -w '%{http_code}' "$CANONICAL_WORKERS_DEV_URL" || true)"
if [[ "$CANONICAL_WORKERS_DEV_CODE" != "404" ]]; then
	echo "Canonical workers.dev endpoint returned HTTP $CANONICAL_WORKERS_DEV_CODE (expected 404)." >&2
	exit 1
fi

echo "Checking legacy worker service is absent..."
if pnpm -C apps/server exec wrangler deployments status --name "$LEGACY_WORKER" >/tmp/fightclaw_legacy_status.txt 2>&1; then
	echo "Legacy worker '$LEGACY_WORKER' still exists." >&2
	cat /tmp/fightclaw_legacy_status.txt
	exit 1
fi

if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
	echo "Checking Pages project inventory..."
	PAGES_JSON="$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects")"
	PAGES_PROJECT_COUNT="$(echo "$PAGES_JSON" | jq -r '[.result[] | select(.name=="fightclaw")] | length')"
	if [[ "$PAGES_PROJECT_COUNT" != "1" ]]; then
		echo "Expected exactly one Pages project named 'fightclaw', found $PAGES_PROJECT_COUNT." >&2
		exit 1
	fi
fi

echo "Cloudflare worker audit passed."
