#!/usr/bin/env bash
# Fightclaw turn helper for OpenClaw sub-agents.
#
# Combines state fetch + legal move computation into a single exec call.
# Also supports submitting a move and returning the updated state.
#
# Usage:
#   fightclaw-turn-helper.sh state <base_url> <match_id> <api_key>
#     → Fetches state + computes legal moves, outputs JSON summary
#
#   fightclaw-turn-helper.sh move <base_url> <match_id> <api_key> <expected_version> <move_json>
#     → Submits a move, then fetches updated state + legal moves
#
# Requires: node, curl, uuidgen (or /proc/sys/kernel/random/uuid)
# Requires: fightclaw-legal-moves.mjs in same directory as this script

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LEGAL_MOVES_BIN="${LEGAL_MOVES_BIN:-$SCRIPT_DIR/../dist/fightclaw-legal-moves.mjs}"

gen_uuid() {
  if command -v uuidgen &>/dev/null; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  elif [ -f /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    node -e "console.log(crypto.randomUUID())"
  fi
}

fetch_state_and_moves() {
  local base_url="$1" match_id="$2" api_key="$3"

  # Fetch match state
  local state_response
  state_response=$(curl -sf -H "Authorization: Bearer $api_key" "$base_url/v1/matches/$match_id/state" 2>&1) || {
    echo "{\"error\":\"Failed to fetch match state\",\"raw\":\"$(echo "$state_response" | head -c 200)\"}"
    return 1
  }

  # Extract game object from envelope
  local game
  game=$(echo "$state_response" | node -e "
    const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const s=d?.state;
    if(!s) { console.log(JSON.stringify({error:'No state in response'})); process.exit(1); }
    console.log(JSON.stringify({
      stateVersion: s.stateVersion,
      status: s.status,
      winnerAgentId: s.winnerAgentId || null,
      endReason: s.endReason || null,
      game: s.game
    }));
  " 2>&1) || {
    echo "{\"error\":\"Failed to parse state\",\"raw\":\"$(echo "$state_response" | head -c 200)\"}"
    return 1
  }

  # Check if match ended
  local status
  status=$(echo "$game" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.status)" 2>/dev/null)
  if [ "$status" = "ended" ]; then
    echo "$game"
    return 0
  fi

  # Compute legal moves
  local game_state
  game_state=$(echo "$game" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(JSON.stringify(d.game))" 2>/dev/null)

  local legal_output
  legal_output=$(echo "$game_state" | node "$LEGAL_MOVES_BIN" 2>&1) || {
    echo "{\"error\":\"Legal moves computation failed\",\"raw\":\"$(echo "$legal_output" | head -c 200)\"}"
    return 1
  }

  # Combine state summary + legal moves into single output
  node -e "
    const state = JSON.parse(process.argv[1]);
    const legal = JSON.parse(process.argv[2]);
    const game = state.game;
    const pA = game.players?.A;
    const pB = game.players?.B;
    console.log(JSON.stringify({
      stateVersion: state.stateVersion,
      status: state.status,
      turn: game.turn,
      activePlayer: game.activePlayer,
      actionsRemaining: game.actionsRemaining,
      playerA: { id: pA?.id, gold: pA?.gold, wood: pA?.wood, vp: pA?.vp, units: pA?.units?.length || 0 },
      playerB: { id: pB?.id, gold: pB?.gold, wood: pB?.wood, vp: pB?.vp, units: pB?.units?.length || 0 },
      legalMoveCount: legal.legalMoveCount,
      legalMoves: legal.legalMoves
    }));
  " "$game" "$legal_output"
}

submit_and_refetch() {
  local base_url="$1" match_id="$2" api_key="$3" expected_version="$4" move_json="$5"

  local move_id
  move_id=$(gen_uuid)

  # Submit the move
  local submit_body="{\"moveId\":\"$move_id\",\"expectedVersion\":$expected_version,\"move\":$move_json}"
  local submit_response
  submit_response=$(curl -sf -X POST \
    -H "Authorization: Bearer $api_key" \
    -H "Content-Type: application/json" \
    "$base_url/v1/matches/$match_id/move" \
    -d "$submit_body" 2>&1) || {
    echo "{\"error\":\"Move submission failed\",\"httpResponse\":\"$(echo "$submit_response" | head -c 300)\"}"
    return 1
  }

  # Brief pause for server to process
  sleep 0.3

  # Fetch updated state + legal moves
  fetch_state_and_moves "$base_url" "$match_id" "$api_key"
}

CMD="${1:-}"
shift || true

case "$CMD" in
  state)
    fetch_state_and_moves "$@"
    ;;
  move)
    submit_and_refetch "$@"
    ;;
  *)
    echo "{\"error\":\"Unknown command: $CMD. Use 'state' or 'move'.\"}"
    exit 1
    ;;
esac
