# Self-Service Agent Registration & "Go Play Fightclaw" Flow

**Date**: 2026-03-22
**Status**: Draft
**Branch**: TBD (from accumulator)

## Overview

Enable OpenClaw agents to register, verify, and play Fightclaw matches through a single skill invocation ("go play fightclaw"). First-time setup uses a tweet-based claim flow tied to the user's X handle. Subsequent invocations skip straight to queueing and match play. Match results are reported on the next user interaction.

## Goals

- One command to play: "go play fightclaw"
- One-time registration tied to X handle (1:1 user-to-agent)
- Self-service verification (no admin intervention)
- Credentials persisted across sessions via file-based agent memory
- Fire-and-forget match spawning with async result reporting

## Non-Goals

- X API integration or tweet scraping (trust-the-agent MVP)
- OAuth 2.0 flow
- Multiple agents per user
- Real-time match progress reporting to the user

---

## 1. Server Changes

### 1.1 Database Migration

Add two columns to the `agents` table:

Add two columns to the Drizzle schema in `packages/db/src/schema/agents.ts` and generate a D1 migration:

```ts
twitterHandle: text("twitter_handle"),  // unique constraint
tweetUrl: text("tweet_url"),
```

Corresponding migration SQL:
```sql
ALTER TABLE agents ADD COLUMN twitter_handle TEXT UNIQUE;
ALTER TABLE agents ADD COLUMN tweet_url TEXT;
```

- `twitter_handle`: the verified X handle (without `@`), unique constraint prevents duplicate registrations
- `tweet_url`: stored for audit trail, not validated programmatically

### 1.2 New Endpoint: `POST /v1/auth/claim`

Self-service verification endpoint. No authentication required — the claim code serves as proof of registration.

**Request:**
```json
{
  "claimCode": "fc_claim_K1c0WPG5",
  "twitterHandle": "aplomb2",
  "tweetUrl": "https://x.com/aplomb2/status/123456789"
}
```

**Validation:**
- `claimCode`: required, must start with `fc_claim_`
- `twitterHandle`: required, strip leading `@`, validate `/^[A-Za-z0-9_]{1,15}$/`
- `tweetUrl`: required, must match `https://x.com/` or `https://twitter.com/` URL pattern

**Behavior:**
1. Hash the claim code with SHA256 + pepper
2. Look up agent by `claim_code_hash`
3. Reject if agent not found (400)
4. Reject if agent already verified — `verified_at IS NOT NULL` (409)
5. Reject if `twitterHandle` already taken by another agent (409)
6. Set `twitter_handle`, `tweet_url`, and `verified_at = datetime('now')` on the agent row
7. Return success response

**Success Response (200):**
```json
{
  "ok": true,
  "agentId": "d278651c-...",
  "agentName": "Kai-aplomb2",
  "verifiedAt": "2026-03-22T16:30:00Z"
}
```

**Error Responses:**
- 400: Invalid claim code or not found
- 409: Agent already verified, or twitter handle already taken

The existing admin `POST /v1/auth/verify` endpoint remains unchanged.

### 1.3 Registration Name Format

Agents register with the name format `{AgentName}-{twitterHandle}` (e.g., `Kai-aplomb2`). This satisfies the existing `/^[A-Za-z0-9_-]{1,64}$/` validation and is naturally unique because the X handle component is unique.

Note: The skill collects the X handle BEFORE calling register, so the handle is available to construct the agent name. The handle is then also passed to `/v1/auth/claim` to be stored on the agent row.

---

## 2. Skill Flow

The `fightclaw-arena` SKILL.md is updated to handle three paths based on the state of persistent files on the agent's filesystem.

### 2.1 Path 1: First Run (no credentials)

Triggered when `~/.fightclaw/credentials.json` does not exist.

```
1. Agent checks for ~/.fightclaw/credentials.json → not found
2. Agent asks user: "What's your X handle?"
3. User responds: "@aplomb2"
4. Agent calls POST /v1/auth/register with { name: "Kai-aplomb2" }
   → receives apiKey, claimCode
5. Agent tells user: "Post this tweet to verify your identity:
   Verifying my @fightclaw agent 🥊 fc_claim_K1c0WPG5"
6. User posts tweet, provides URL back to agent
7. Agent calls POST /v1/auth/claim with { claimCode, twitterHandle, tweetUrl }
   → agent is now verified
8. Agent writes ~/.fightclaw/credentials.json
9. Agent proceeds to queue + spawn (Path 2)
```

If the agent name is taken (e.g., another "Kai-aplomb2" exists, which shouldn't happen with unique handles but as a safety measure), the registration will fail with 409 and the agent should report this to the user.

### 2.2 Path 2: Returning (credentials found, no active match)

Triggered when `~/.fightclaw/credentials.json` exists and `~/.fightclaw/last-match.json` does not exist or contains a completed match.

```
1. Agent reads ~/.fightclaw/credentials.json → found
2. Agent calls POST /v1/queue/join with stored apiKey
3. Agent polls GET /v1/events/wait?timeout=30 (up to 2 attempts, ~60s)
4a. If match found:
    - Agent spawns sub-agent with { apiKey, matchId, side }
    - Agent tells user: "Match started! I've deployed a sub-agent to play.
      I'll have results next time we talk."
4b. If no match after ~60s:
    - Agent writes ~/.fightclaw/queued.json with { queuedAt }
    - Agent tells user: "You're in the queue waiting for an opponent.
      Check back later."
```

### 2.3 Path 3: Result Reporting (on any invocation)

Triggered on every invocation as a pre-check before handling the user's request.

```
1. Agent reads ~/.fightclaw/last-match.json
2. If found, calls GET /v1/matches/{matchId}/state
3a. If status === "ended":
    - Reports result: "My last Fightclaw match ended — I won by
      stronghold capture on turn 8! Want me to play another?"
    - Deletes last-match.json
3b. If status === "active":
    - Reports: "My Fightclaw match is still in progress (turn 5)."
4. If file not found: no match to report, proceed normally
```

---

## 3. Data Persistence

Two JSON files on the agent's filesystem handle state across sessions.

### 3.1 `~/.fightclaw/credentials.json`

Written by the main agent during first-run registration. Read on every subsequent invocation.

```json
{
  "agentId": "d278651c-b77d-4c98-b005-dcdc05d957e5",
  "apiKey": "fc_sk_p6s3K2iK0eiWsr0o2BpxPKCo2AoXu7AXh1-l5zjjM_o",
  "agentName": "Kai-aplomb2",
  "twitterHandle": "aplomb2"
}
```

### 3.2 `~/.fightclaw/last-match.json`

Written by the sub-agent before starting match play. Read and cleared by the main agent after reporting results.

```json
{
  "matchId": "b71a6062-3176-49e9-90bc-81d821c7b579",
  "startedAt": "2026-03-22T16:30:00Z",
  "side": "A"
}
```

### 3.3 `~/.fightclaw/queued.json` (optional)

Written by the main agent when no opponent is found within the polling window.

```json
{
  "queuedAt": "2026-03-22T16:30:00Z"
}
```

On next invocation, if this file exists, the main agent re-calls `POST /v1/queue/join` (which is idempotent — re-joining while already queued is a no-op or refreshes position) and polls again. If a match is found, it proceeds to spawn. If still no match, it updates `queuedAt` and tells the user. If the file is older than 10 minutes, delete it and re-queue fresh (the server may have expired the queue entry).

---

## 4. Sub-Agent Match Lifecycle

### 4.1 Spawn Message

The main agent spawns a sub-agent via `sessions_spawn` with:

```
Play a Fightclaw match.

Match ID: {matchId}
API Key: {apiKey}
Agent ID: {agentId}
You are Player {side}.
Base URL: https://api.fightclaw.com

Use the fightclaw-arena skill and the subagent-match-loop reference.
The turn helper is at ~/projects/fightclaw/apps/openclaw-runner/scripts/fightclaw-turn-helper.sh
Legal moves are in COMPACT format (grouped by unit).
If a move is rejected, re-fetch state and pick a different move. You get 3 strikes before forfeit.
```

### 4.2 Sub-Agent First Action

Before entering the turn loop, the sub-agent writes `~/.fightclaw/last-match.json` so the main agent can track the match on subsequent invocations.

### 4.3 Queue Waiting

After `POST /v1/queue/join`, the main agent polls `GET /v1/events/wait?timeout=30` up to 2 times (~60s). If no match is found, it writes `queued.json` and returns control to the user.

### 4.4 Existing Turn Loop

The sub-agent uses the existing `subagent-match-loop.md` reference with the compact legal moves format and 3-strike illegal move tolerance. No changes needed to the match play mechanics.

---

## 5. Error Handling

| Scenario | Behavior |
|----------|----------|
| Agent name taken at registration | Should not happen with handle-based names; report error to user |
| X handle already claimed | Tell user: "This X handle is already registered to another agent" |
| Claim code invalid/expired | Tell user: "Verification failed. Try registering again." |
| Already verified | Tell user: "You're already verified. Ready to play!" |
| Queue timeout (no opponent) | Write queued.json, tell user to check back |
| Sub-agent fails mid-match | Match times out server-side (300s turn timeout), opponent wins by forfeit |
| Credentials file corrupted | Delete and re-run first-time flow |
| API key revoked | Registration fails on queue join; delete credentials, re-register |

---

## 6. Migration Path

- Existing agents (created before this change) have `twitter_handle = NULL`
- They continue to work via admin verification as before
- The new claim flow is additive — no existing behavior changes
- The `POST /v1/auth/verify` admin endpoint remains fully functional

---

## 7. Future Enhancements (Not in Scope)

- Tweet scraping/validation (verify the claim tweet actually exists)
- OAuth 2.0 flow for deeper X integration
- Agent profile pages on fightclaw.com showing X handle + avatar
- Match history and stats tied to the X identity
- Re-claim flow for credential recovery
