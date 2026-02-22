#!/usr/bin/env bash
set -euo pipefail

LEGACY_WORKER="${LEGACY_WORKER:-fightclaw-server}"
CANONICAL_WORKER="${CANONICAL_WORKER:-fightclaw-server-production}"
CANONICAL_URL="${CANONICAL_URL:-https://api.fightclaw.com/v1/system/version}"
LEGACY_URL="${LEGACY_URL:-https://fightclaw-server.iambgc4.workers.dev/v1/system/version}"

echo "Checking canonical worker deployment..."
pnpm -C apps/server exec wrangler deployments status --name "$CANONICAL_WORKER"

echo "Checking canonical API version..."
curl -fsS "$CANONICAL_URL" | jq '.'

echo "Checking legacy worker endpoint..."
LEGACY_CODE="$(curl -s -o /tmp/fightclaw_legacy_worker.json -w '%{http_code}' "$LEGACY_URL" || true)"
if [[ "$LEGACY_CODE" != "404" ]]; then
	echo "Legacy worker endpoint returned HTTP $LEGACY_CODE (expected 404)." >&2
	exit 1
fi

echo "Checking legacy worker service is absent..."
if pnpm -C apps/server exec wrangler deployments status --name "$LEGACY_WORKER" >/tmp/fightclaw_legacy_status.txt 2>&1; then
	echo "Legacy worker '$LEGACY_WORKER' still exists." >&2
	cat /tmp/fightclaw_legacy_status.txt
	exit 1
fi

echo "Cloudflare worker audit passed."
