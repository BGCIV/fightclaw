#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/apps/server/.env"

if [[ -f "$ENV_FILE" ]]; then
	set -a
	# shellcheck source=/dev/null
	source "$ENV_FILE"
	set +a
fi

BASE_URL="${BASE_URL:-https://api.fightclaw.com}"
RUNNER_ID="${RUNNER_ID:-openclaw-existing-runner}"
MOVE_TIMEOUT_MS="${MOVE_TIMEOUT_MS:-45000}"
OPENCLAW_TIMEOUT_SECONDS="${OPENCLAW_TIMEOUT_SECONDS:-35}"
OPENCLAW_AGENT_LOCAL="${OPENCLAW_AGENT_LOCAL:-0}"
OPENCLAW_AGENT_CHANNEL="${OPENCLAW_AGENT_CHANNEL:-last}"
KAI_OPENCLAW_AGENT_ID="${KAI_OPENCLAW_AGENT_ID:-main}"
MRSMITH_OPENCLAW_AGENT_ID="${MRSMITH_OPENCLAW_AGENT_ID:-mrsmith}"
KAI_NAME="${KAI_NAME:-Kai}"
MRSMITH_NAME="${MRSMITH_NAME:-MrSmith}"

if [[ -z "${ADMIN_KEY:-}" ]]; then
	echo "Missing ADMIN_KEY. Set it in apps/server/.env or environment." >&2
	exit 1
fi
if [[ -z "${INTERNAL_RUNNER_KEY:-}" ]]; then
	echo "Missing INTERNAL_RUNNER_KEY. Set it in apps/server/.env or environment." >&2
	exit 1
fi
if [[ -z "${KAI_AGENT_API_KEY:-}" ]]; then
	echo "Missing KAI_AGENT_API_KEY." >&2
	exit 1
fi
if [[ -z "${MRSMITH_AGENT_API_KEY:-}" ]]; then
	echo "Missing MRSMITH_AGENT_API_KEY." >&2
	exit 1
fi

OPENCLAW_SSH_TARGET="${OPENCLAW_SSH_TARGET:-}"
if [[ -n "${OPENCLAW_SSH_TARGET}" ]]; then
	echo "Using SSH-backed OpenClaw target: ${OPENCLAW_SSH_TARGET}"
	if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "${OPENCLAW_SSH_TARGET}" "echo OPENCLAW_SSH_OK" >/dev/null 2>&1; then
		echo "OpenClaw SSH target is unreachable: ${OPENCLAW_SSH_TARGET}" >&2
		echo "Fix network/host availability first; refusing to run fallback-only duel." >&2
		exit 1
	fi
else
	echo "Using local OpenClaw binary execution."
fi

export OPENCLAW_TIMEOUT_SECONDS
export OPENCLAW_AGENT_LOCAL
export OPENCLAW_AGENT_CHANNEL

MIN_MOVE_TIMEOUT_MS=$((OPENCLAW_TIMEOUT_SECONDS * 1000 + 5000))
if (( MOVE_TIMEOUT_MS < MIN_MOVE_TIMEOUT_MS )); then
	echo "MOVE_TIMEOUT_MS=${MOVE_TIMEOUT_MS} is too low for OPENCLAW_TIMEOUT_SECONDS=${OPENCLAW_TIMEOUT_SECONDS}."
	echo "Adjusting MOVE_TIMEOUT_MS to ${MIN_MOVE_TIMEOUT_MS} to avoid timed safety fallback loops."
	MOVE_TIMEOUT_MS="${MIN_MOVE_TIMEOUT_MS}"
fi

KAI_GATEWAY_CMD_DEFAULT="OPENCLAW_AGENT_ID=${KAI_OPENCLAW_AGENT_ID} OPENCLAW_SSH_TARGET=${OPENCLAW_SSH_TARGET} OPENCLAW_AGENT_LOCAL=${OPENCLAW_AGENT_LOCAL} OPENCLAW_AGENT_CHANNEL=${OPENCLAW_AGENT_CHANNEL} pnpm exec tsx scripts/gateway-openclaw-agent.ts"
MRSMITH_GATEWAY_CMD_DEFAULT="OPENCLAW_AGENT_ID=${MRSMITH_OPENCLAW_AGENT_ID} OPENCLAW_SSH_TARGET=${OPENCLAW_SSH_TARGET} OPENCLAW_AGENT_LOCAL=${OPENCLAW_AGENT_LOCAL} OPENCLAW_AGENT_CHANNEL=${OPENCLAW_AGENT_CHANNEL} pnpm exec tsx scripts/gateway-openclaw-agent.ts"
export KAI_GATEWAY_CMD="${KAI_GATEWAY_CMD:-$KAI_GATEWAY_CMD_DEFAULT}"
export MRSMITH_GATEWAY_CMD="${MRSMITH_GATEWAY_CMD:-$MRSMITH_GATEWAY_CMD_DEFAULT}"

CLI_ARGS=(
	--baseUrl "$BASE_URL"
	--adminKey "$ADMIN_KEY"
	--runnerKey "$INTERNAL_RUNNER_KEY"
	--runnerId "$RUNNER_ID"
	--apiKeyA "$KAI_AGENT_API_KEY"
	--apiKeyB "$MRSMITH_AGENT_API_KEY"
	--nameA "$KAI_NAME"
	--nameB "$MRSMITH_NAME"
	--gatewayCmd "pnpm exec tsx scripts/gateway-openclaw-router.ts"
	--moveTimeoutMs "$MOVE_TIMEOUT_MS"
)

echo "Starting existing-agent Kai vs MrSmith duel from queue/attach onward."
if [[ "${OPENCLAW_AGENT_LOCAL}" == "1" ]]; then
	echo "OpenClaw mode: local agent execution (channel-independent)."
else
	echo "OpenClaw mode: gateway channel routing via '${OPENCLAW_AGENT_CHANNEL}'."
fi

pnpm -C apps/openclaw-runner exec tsx src/cli.ts existing-duel \
	"${CLI_ARGS[@]}" \
	"$@"
