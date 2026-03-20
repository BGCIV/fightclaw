# Fightclaw Runtime Contract Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add one canonical Fightclaw runtime contract doc and cut the skill plus runner README over to it as the single runtime source of truth.

**Architecture:** Keep the branch documentation-only. Write one normative runtime contract artifact, then make two thin pointer edits so the ClawHub skill and OpenClaw runner README both adopt the same gateway-first mental model without duplicating protocol/runtime rules.

**Tech Stack:** Markdown, repo docs, SKILL.md, OpenClaw runner README

---

### Task 1: Write the canonical runtime contract document

**Files:**
- Create: `/Users/bgciv/Dev/fightclaw/.worktrees/runtime-contract/docs/fightclaw-runtime-contract.md`

**Step 1: Write the failing content checklist**

Draft the contract outline in the new doc with empty section headings only:
- Purpose and scope
- Runtime roles and boundaries
- Helper input contract
- Helper output contract
- Timing and continuation budget
- Fallback ladder
- Commentary rule
- Weak-box minimum guarantees
- Out of scope

**Step 2: Verify the draft is incomplete**

Run:

```bash
sed -n '1,220p' docs/fightclaw-runtime-contract.md
```

Expected: headings exist but the contract is not yet usable because the sections are still empty/incomplete.

**Step 3: Write the minimal complete contract**

Fill the doc with precise normative language that:
- defines the skill layer as instructional/orchestration only
- defines the local helper layer as the latency/legality/fallback boundary
- defines the server/engine layer as the authority layer
- states that legality is computed locally and validated authoritatively, not inferred from scratch by the model
- states that commentary is best-effort and must never block move submission
- states that weak boxes must still be able to complete the loop via bounded play and fallback

**Step 4: Review the artifact for duplication**

Run:

```bash
sed -n '1,260p' docs/fightclaw-runtime-contract.md
```

Expected: one concise canonical document, not a duplicated endpoint spec.

**Step 5: Commit**

```bash
git add docs/fightclaw-runtime-contract.md
git commit -m "docs: add fightclaw runtime contract"
```

### Task 2: Cut the Fightclaw skill over to the canonical contract

**Files:**
- Modify: `/Users/bgciv/Dev/fightclaw/.worktrees/runtime-contract/skills/fightclaw-arena/SKILL.md`

**Step 1: Write the failing review target**

Identify the stale runtime language to remove or rewrite:
- WS-primary match transport wording
- duplicated runtime/turn-loop semantics that now belong in the canonical contract

**Step 2: Verify the stale language exists**

Run:

```bash
rg -n "WS|WebSocket|WS-primary|HTTP fallback|runtime|turn loop" skills/fightclaw-arena/SKILL.md
```

Expected: the skill still contains stale or overly specific runtime wording.

**Step 3: Make the thin pointer edit**

Update the skill so it:
- points readers to `docs/fightclaw-runtime-contract.md` for live runtime semantics
- keeps onboarding/verification/queue/play flow guidance
- stops teaching WS-first transport language
- keeps the skill orchestration-first and user-facing

**Step 4: Verify the pointer and wording**

Run:

```bash
sed -n '1,220p' skills/fightclaw-arena/SKILL.md
```

Expected: the skill is thinner, points to the contract, and no longer teaches stale runtime language.

**Step 5: Commit**

```bash
git add skills/fightclaw-arena/SKILL.md
git commit -m "docs(skill): point fightclaw arena skill to runtime contract"
```

### Task 3: Cut the OpenClaw runner README over to the canonical contract

**Files:**
- Modify: `/Users/bgciv/Dev/fightclaw/.worktrees/runtime-contract/apps/openclaw-runner/README.md`

**Step 1: Write the failing review target**

Identify the README sections that currently explain runtime semantics directly instead of treating the contract as canonical.

**Step 2: Verify the direct runtime wording exists**

Run:

```bash
rg -n "gateway|fallback|publicThought|moveTimeoutMs|turn|runtime contract" apps/openclaw-runner/README.md
```

Expected: the README still contains runtime-semantics text that should become pointer-style.

**Step 3: Make the thin pointer edit**

Update the README so it:
- keeps usage examples intact
- points runtime semantics to `docs/fightclaw-runtime-contract.md`
- keeps only brief operator-oriented summaries where needed
- avoids duplicating the contract details

**Step 4: Verify clarity**

Run:

```bash
sed -n '1,260p' apps/openclaw-runner/README.md
```

Expected: the README remains practical for operators while clearly delegating runtime semantics to the canonical contract.

**Step 5: Commit**

```bash
git add apps/openclaw-runner/README.md
git commit -m "docs(runner): point openclaw runner to runtime contract"
```

### Task 4: Run documentation verification and finish

**Files:**
- Verify only the touched docs files

**Step 1: Run focused checks**

Run:

```bash
pnpm exec biome check docs/fightclaw-runtime-contract.md skills/fightclaw-arena/SKILL.md apps/openclaw-runner/README.md docs/plans/2026-03-19-fightclaw-runtime-contract-design.md docs/plans/2026-03-19-fightclaw-runtime-contract.md
```

Expected: PASS or only trivial formatting fixes.

**Step 2: Verify no stale WS-first line remains in the skill**

Run:

```bash
rg -n "WS-primary|WebSocket|HTTP fallback" skills/fightclaw-arena/SKILL.md apps/openclaw-runner/README.md docs/fightclaw-runtime-contract.md
```

Expected: no stale WS-primary guidance remains as the recommended mental model.

**Step 3: Verify clean git status**

Run:

```bash
git status --short
```

Expected: clean working tree after commits.

**Step 4: Commit final doc sweep if needed**

```bash
git add docs/fightclaw-runtime-contract.md skills/fightclaw-arena/SKILL.md apps/openclaw-runner/README.md
git commit -m "docs: align skill and runner with runtime contract"
```
