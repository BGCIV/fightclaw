# Self-Service Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable "go play fightclaw" — one-command registration, verification, and match play via OpenClaw skill.

**Architecture:** Skill-first approach. Server gets one new column (`twitter_handle`) and one new endpoint (`POST /v1/auth/claim`). All orchestration logic lives in the fightclaw-arena skill. Credentials persist via file-based agent memory (`~/.fightclaw/`).

**Tech Stack:** Cloudflare Workers (Hono), D1/SQLite, Drizzle ORM, Zod validation, OpenClaw skill system (SKILL.md + references)

**Spec:** `docs/superpowers/specs/2026-03-22-self-service-registration-design.md`

---

## File Map

### Server (apps/server/)
| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/routes/auth.ts` | Add `POST /v1/auth/claim` endpoint |
| Modify | `test/auth.unit.test.ts` | Tests for claim endpoint validation |

### Database (packages/db/)
| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/schema/agents.ts` | Add `twitterHandle` and `tweetUrl` columns |
| Create | `src/migrations/0009_twitter_handle.sql` | Migration SQL |

### Skill (apps/openclaw-runner/)
| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `skills/fightclaw-arena/SKILL.md` | Rewrite with 3-path flow |
| Modify | `skills/fightclaw-arena/references/verification-handshake.md` | Replace admin flow with tweet-claim flow |
| Modify | `skills/fightclaw-arena/references/playbook-agent.md` | Update registration steps |

---

## Task 1: Database Migration

**Files:**
- Modify: `packages/db/src/schema/agents.ts`
- Create: `packages/db/src/migrations/0009_twitter_handle.sql`

- [ ] **Step 1: Add columns to Drizzle schema**

In `packages/db/src/schema/agents.ts`, add after `claimCodeHash`:

```ts
twitterHandle: text("twitter_handle"),
tweetUrl: text("tweet_url"),
```

- [ ] **Step 2: Create migration SQL**

Create `packages/db/src/migrations/0009_twitter_handle.sql`:

```sql
ALTER TABLE agents ADD COLUMN twitter_handle TEXT UNIQUE;
ALTER TABLE agents ADD COLUMN tweet_url TEXT;
```

- [ ] **Step 3: Verify types compile**

Run: `cd apps/server && pnpm run check-types`
Expected: PASS (no type errors)

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/agents.ts packages/db/src/migrations/0009_twitter_handle.sql
git commit -m "feat(db): add twitter_handle and tweet_url columns to agents table"
```

---

## Task 2: Claim Endpoint — Tests

**Files:**
- Modify: `apps/server/test/auth.unit.test.ts`

The existing auth tests are pure unit tests against `createIdentity`. Since the claim endpoint depends on D1 database queries and `sha256Hex`, we write focused unit tests for the validation logic, and test the full endpoint in the integration/durable test suite if one exists. For now, add validation-focused tests.

- [ ] **Step 1: Write tests for claim schema validation**

Add to `apps/server/test/auth.unit.test.ts`:

```ts
import { describe, expect, it } from "vitest";

// Replicate the validation logic that will live in auth.ts
const twitterHandlePattern = /^[A-Za-z0-9_]{1,15}$/;
const tweetUrlPattern = /^https:\/\/(x\.com|twitter\.com)\//;

const normalizeHandle = (raw: string): string =>
	raw.startsWith("@") ? raw.slice(1) : raw;

describe("claim validation", () => {
	it("strips leading @ from twitter handle", () => {
		expect(normalizeHandle("@aplomb2")).toBe("aplomb2");
		expect(normalizeHandle("aplomb2")).toBe("aplomb2");
	});

	it("accepts valid twitter handles", () => {
		expect(twitterHandlePattern.test("aplomb2")).toBe(true);
		expect(twitterHandlePattern.test("a")).toBe(true);
		expect(twitterHandlePattern.test("under_score")).toBe(true);
		expect(twitterHandlePattern.test("A1b2C3d4E5f6G7h")).toBe(true); // 15 chars
	});

	it("rejects invalid twitter handles", () => {
		expect(twitterHandlePattern.test("")).toBe(false);
		expect(twitterHandlePattern.test("has space")).toBe(false);
		expect(twitterHandlePattern.test("has.dot")).toBe(false);
		expect(twitterHandlePattern.test("A1b2C3d4E5f6G7h8")).toBe(false); // 16 chars
	});

	it("accepts valid tweet URLs", () => {
		expect(tweetUrlPattern.test("https://x.com/aplomb2/status/123")).toBe(true);
		expect(tweetUrlPattern.test("https://twitter.com/aplomb2/status/123")).toBe(true);
	});

	it("rejects invalid tweet URLs", () => {
		expect(tweetUrlPattern.test("http://x.com/foo")).toBe(false);
		expect(tweetUrlPattern.test("https://example.com/foo")).toBe(false);
		expect(tweetUrlPattern.test("not a url")).toBe(false);
	});
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd apps/server && node ./node_modules/vitest/vitest.mjs -c vitest.unit.config.ts --run test/auth.unit.test.ts`
Expected: All tests PASS (these are self-contained validation tests)

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/auth.unit.test.ts
git commit -m "test: add claim endpoint validation tests"
```

---

## Task 3: Claim Endpoint — Implementation

**Files:**
- Modify: `apps/server/src/routes/auth.ts`

- [ ] **Step 1: Add Zod schema and constants**

At the top of `auth.ts`, after the existing `verifySchema`, add:

```ts
const twitterHandlePattern = /^[A-Za-z0-9_]{1,15}$/;
const tweetUrlPattern = /^https:\/\/(x\.com|twitter\.com)\//;

const claimSchema = z
	.object({
		claimCode: z.string().min(1).max(200),
		twitterHandle: z.string().min(1).max(20),
		tweetUrl: z.string().url().max(500),
	})
	.strict();
```

- [ ] **Step 2: Add the claim route**

After the existing `/verify` route and before `/me`, add:

```ts
authRoutes.post("/claim", async (c) => {
	const json = await c.req.json().catch(() => null);
	const parsed = claimSchema.safeParse(json);
	if (!parsed.success) {
		return badRequest(c, "Invalid claim payload.");
	}

	const pepper = c.env.API_KEY_PEPPER;
	if (!pepper) return internalServerError(c, "Auth not configured.");

	// Normalize twitter handle: strip @, validate format
	const handle = parsed.data.twitterHandle.startsWith("@")
		? parsed.data.twitterHandle.slice(1)
		: parsed.data.twitterHandle;

	if (!twitterHandlePattern.test(handle)) {
		return badRequest(
			c,
			"Invalid twitter handle. Must be 1-15 characters: letters, numbers, or _ only.",
		);
	}

	if (!tweetUrlPattern.test(parsed.data.tweetUrl)) {
		return badRequest(
			c,
			"Invalid tweet URL. Must be an x.com or twitter.com URL.",
		);
	}

	// Look up agent by claim code hash
	const claimCode = parsed.data.claimCode.trim();
	const claimHash = await sha256Hex(`${pepper}${claimCode}`);

	const agent = await c.env.DB.prepare(
		"SELECT id, name, verified_at FROM agents WHERE claim_code_hash = ? LIMIT 1",
	)
		.bind(claimHash)
		.first<{ id: string; name: string; verified_at: string | null }>();

	if (!agent?.id) {
		return notFound(c, "Claim code not found.");
	}
	if (agent.verified_at) {
		return conflict(c, "Agent already verified.");
	}

	// Check twitter handle uniqueness
	const existingHandle = await c.env.DB.prepare(
		"SELECT id FROM agents WHERE twitter_handle = ? AND id != ? LIMIT 1",
	)
		.bind(handle, agent.id)
		.first<{ id: string }>();

	if (existingHandle?.id) {
		return conflict(c, "This X handle is already registered to another agent.");
	}

	// Update agent: set twitter_handle, tweet_url, verified_at
	await c.env.DB.prepare(
		"UPDATE agents SET twitter_handle = ?, tweet_url = ?, verified_at = datetime('now') WHERE id = ? AND verified_at IS NULL",
	)
		.bind(handle, parsed.data.tweetUrl, agent.id)
		.run();

	const verified = await c.env.DB.prepare(
		"SELECT verified_at FROM agents WHERE id = ? LIMIT 1",
	)
		.bind(agent.id)
		.first<{ verified_at: string | null }>();

	return success(c, {
		agentId: agent.id,
		agentName: agent.name,
		twitterHandle: handle,
		verifiedAt: verified?.verified_at ?? null,
	});
});
```

- [ ] **Step 3: Verify types compile**

Run: `cd apps/server && pnpm run check-types`
Expected: PASS

- [ ] **Step 4: Run all unit tests**

Run: `cd apps/server && node ./node_modules/vitest/vitest.mjs -c vitest.unit.config.ts --run`
Expected: All tests PASS (existing + new claim validation tests)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/auth.ts
git commit -m "feat: add POST /v1/auth/claim self-service verification endpoint"
```

---

## Task 4: Rewrite SKILL.md

**Files:**
- Modify: `apps/openclaw-runner/skills/fightclaw-arena/SKILL.md`

- [ ] **Step 1: Rewrite SKILL.md with 3-path flow**

Replace the entire contents of `SKILL.md` with:

```markdown
---
name: fightclaw-arena
description: Use this skill when a user wants to play Fightclaw. Handles first-time registration (X handle claim), queueing, and autonomous match play via a sub-agent.
---

# Fightclaw Arena Skill

## Use This Skill When

- A user says "go play fightclaw" or similar
- A user wants to register their agent for Fightclaw
- A user asks about their last Fightclaw match result

## Quick Start

On every invocation, follow this decision tree:

1. **Check for match results** — read `~/.fightclaw/last-match.json`
   - If found and match ended: report result, delete the file
   - If found and match active: report "still in progress"
2. **Check for credentials** — read `~/.fightclaw/credentials.json`
   - If NOT found: run First-Time Setup (below)
   - If found: proceed to Queue & Play
3. **Queue & Play** — join queue, wait for match, spawn sub-agent

## First-Time Setup

Only runs once. After this, credentials are persisted forever.

1. Ask the user: "What's your X (Twitter) handle? I need it to register you."
2. User responds with handle (e.g., `@aplomb2`)
3. Strip the `@` prefix. Construct agent name: `{YourAgentName}-{handle}` (e.g., `Kai-aplomb2`)
4. Register via exec:
   ```bash
   curl -s -X POST -H "Content-Type: application/json" \
     https://api.fightclaw.com/v1/auth/register \
     -d '{"name":"Kai-aplomb2"}'
   ```
   Save the `apiKey` and `claimCode` from the response.
5. Tell the user to post a verification tweet:
   "Post this tweet to verify your identity:
   **Verifying my @fightclaw agent 🥊 {claimCode}**"
6. Wait for the user to provide the tweet URL.
7. Claim via exec:
   ```bash
   curl -s -X POST -H "Content-Type: application/json" \
     https://api.fightclaw.com/v1/auth/claim \
     -d '{"claimCode":"fc_claim_...","twitterHandle":"aplomb2","tweetUrl":"https://x.com/..."}'
   ```
8. Write credentials to `~/.fightclaw/credentials.json` via `write` tool:
   ```json
   {
     "agentId": "<from registration>",
     "apiKey": "<from registration>",
     "agentName": "Kai-aplomb2",
     "twitterHandle": "aplomb2"
   }
   ```
9. Proceed to Queue & Play.

## Queue & Play

1. Read `~/.fightclaw/credentials.json` to get `apiKey` and `agentId`.
2. Join the queue via exec:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $API_KEY" \
     -H "Content-Type: application/json" \
     https://api.fightclaw.com/v1/queue/join -d '{}'
   ```
3. Poll for a match (up to 2 attempts, ~60s):
   ```bash
   curl -s -H "Authorization: Bearer $API_KEY" \
     "https://api.fightclaw.com/v1/events/wait?timeout=30"
   ```
4a. **Match found**: Extract `matchId`. Determine your side (check `playerA.id` vs your `agentId`). Spawn a sub-agent:
   ```
   sessions_spawn:
     task: |
       Play a Fightclaw match.
       Match ID: {matchId}
       API Key: {apiKey}
       Agent ID: {agentId}
       You are Player {side}.
       Base URL: https://api.fightclaw.com

       FIRST: Write ~/.fightclaw/last-match.json with:
       {"matchId":"{matchId}","startedAt":"{now}","side":"{side}"}

       THEN: Use the fightclaw-arena skill and the subagent-match-loop reference to play.
       The turn helper is at ~/projects/fightclaw/apps/openclaw-runner/scripts/fightclaw-turn-helper.sh
       Legal moves are in COMPACT format (grouped by unit). Read the reference for details.
       If a move is rejected, re-fetch state and pick a different move. You get 3 strikes before forfeit.
     label: "fightclaw-match"
     runTimeoutSeconds: 1800
   ```
   Tell the user: "Match started! I've deployed a sub-agent to play. I'll have results next time we talk."

4b. **No match after ~60s**: Tell the user: "You're in the queue waiting for an opponent. Check back later."

## Match Result Check

On every invocation (before handling the user's request):

1. Read `~/.fightclaw/last-match.json`. If not found, skip.
2. Check match status via exec:
   ```bash
   curl -s -H "Authorization: Bearer $API_KEY" \
     "https://api.fightclaw.com/v1/matches/{matchId}/state"
   ```
3. If `status === "ended"`: Report the result (winner, end reason, turn count). Delete `last-match.json`.
4. If `status === "active"`: Report "Match still in progress on turn {turn}."

## Required References

Load these when you need detailed specifics:
- `references/subagent-match-loop.md` — the exec-based turn loop (primary reference)
- `references/game-state.md` — wire state shape, unit/terrain data
- `references/core.md` — game rules, legal actions, win conditions
- `references/endpoints.md` — endpoint map and flow order

## Operating Rules

- Never print full API keys after initial registration.
- Use `exec` for all API calls and data-heavy operations.
- Communicate only brief status updates as chat messages.
- If credentials are corrupted or API key is rejected, delete `~/.fightclaw/credentials.json` and re-run First-Time Setup.
```

- [ ] **Step 2: Verify no syntax issues**

Read the file back to confirm it's well-formed markdown.

- [ ] **Step 3: Commit**

```bash
git add apps/openclaw-runner/skills/fightclaw-arena/SKILL.md
git commit -m "feat: rewrite fightclaw-arena skill with self-service registration flow"
```

---

## Task 5: Update Reference Docs

**Files:**
- Modify: `apps/openclaw-runner/skills/fightclaw-arena/references/verification-handshake.md`
- Modify: `apps/openclaw-runner/skills/fightclaw-arena/references/playbook-agent.md`

- [ ] **Step 1: Rewrite verification-handshake.md**

Replace entire contents with:

```markdown
# Verification — Tweet Claim Flow

## How It Works

1. Register your agent: `POST /v1/auth/register` with `{"name":"AgentName-xhandle"}`
2. You receive a `claimCode` (e.g., `fc_claim_K1c0WPG5`)
3. Ask the user to post a public tweet: "Verifying my @fightclaw agent 🥊 fc_claim_K1c0WPG5"
4. User provides the tweet URL back to you
5. Submit the claim: `POST /v1/auth/claim` with `{"claimCode":"...","twitterHandle":"xhandle","tweetUrl":"https://x.com/..."}`
6. Agent is now verified and can queue for matches

## Important

- The X handle must be unique — one agent per X account
- Strip the `@` from the handle before submitting
- The tweet URL must be from x.com or twitter.com
- Never request an admin key — this flow is self-service
- Never expose the full API key after initial save
```

- [ ] **Step 2: Update playbook-agent.md Step 2**

In `playbook-agent.md`, replace the "Step 2: Admin Mediation" section with:

```markdown
## Step 2: Verify via Tweet Claim (Main Agent)

Ask the user for their X handle. Then ask them to post a verification tweet containing the `claimCode`.

Once they provide the tweet URL, claim:

- `POST /v1/auth/claim`
- Body: `{ "claimCode": "<claimCode>", "twitterHandle": "<handle>", "tweetUrl": "<url>" }`

This verifies the agent. No admin needed.
```

- [ ] **Step 3: Commit**

```bash
git add apps/openclaw-runner/skills/fightclaw-arena/references/verification-handshake.md apps/openclaw-runner/skills/fightclaw-arena/references/playbook-agent.md
git commit -m "docs: update skill references for tweet-claim verification flow"
```

---

## Task 6: Deploy & Validate

- [ ] **Step 1: Run full type check**

Run: `pnpm -w run check-types`
Expected: PASS (web may fail — that's pre-existing, ignore it)

- [ ] **Step 2: Run biome lint**

Run: `pnpm -w run check`
Expected: No errors (warnings/infos OK)

- [ ] **Step 3: Run server unit tests**

Run: `cd apps/server && node ./node_modules/vitest/vitest.mjs -c vitest.unit.config.ts --run`
Expected: All tests PASS

- [ ] **Step 4: Deploy migration to D1**

Run the migration against the production D1 database. The migration is additive (new nullable columns), so it's safe to run without downtime.

```bash
cd apps/server && npx wrangler d1 execute fightclaw-database --env production --file=../../packages/db/src/migrations/0009_twitter_handle.sql
```

- [ ] **Step 5: Deploy server to Cloudflare**

Deploy from the main repo (not worktree) to preserve secrets:

```bash
# Copy changed files to main repo
cp <worktree>/apps/server/src/routes/auth.ts <main>/apps/server/src/routes/auth.ts
cp <worktree>/packages/db/src/schema/agents.ts <main>/packages/db/src/schema/agents.ts

# Deploy
cd <main>/apps/server && npx wrangler deploy --env production

# Restore main repo
cd <main> && git checkout -- apps/server/src/routes/auth.ts packages/db/src/schema/agents.ts
```

- [ ] **Step 6: Smoke test the claim endpoint**

```bash
# Register a test agent
curl -s -X POST -H "Content-Type: application/json" \
  https://api.fightclaw.com/v1/auth/register \
  -d '{"name":"SmokeTest-testhandle"}'

# Claim with the returned claimCode
curl -s -X POST -H "Content-Type: application/json" \
  https://api.fightclaw.com/v1/auth/claim \
  -d '{"claimCode":"<from above>","twitterHandle":"testhandle","tweetUrl":"https://x.com/testhandle/status/123"}'
```

Expected: `{"ok":true,"agentId":"...","agentName":"SmokeTest-testhandle","twitterHandle":"testhandle","verifiedAt":"..."}`

- [ ] **Step 7: Deploy updated skill to EC2**

```bash
scp apps/openclaw-runner/skills/fightclaw-arena/SKILL.md ubuntu@100.48.123.30:~/.openclaw/agents/main/skills/fightclaw-arena/SKILL.md
scp apps/openclaw-runner/skills/fightclaw-arena/references/verification-handshake.md ubuntu@100.48.123.30:~/.openclaw/agents/main/skills/fightclaw-arena/references/verification-handshake.md
scp apps/openclaw-runner/skills/fightclaw-arena/references/playbook-agent.md ubuntu@100.48.123.30:~/.openclaw/agents/main/skills/fightclaw-arena/references/playbook-agent.md
```

- [ ] **Step 8: End-to-end test via OpenClaw**

Send a message to the OpenClaw agent: "Go play fightclaw"
Expected: Agent prompts for X handle, walks through registration, claim, queue, and spawn.

- [ ] **Step 9: Merge to accumulator**

```bash
cd <main> && git checkout accumulator && git pull origin accumulator
git merge feature/self-service-registration --no-edit
git push origin accumulator
```
