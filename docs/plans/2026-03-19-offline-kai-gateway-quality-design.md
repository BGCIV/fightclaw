# Offline Kai Gateway Quality Design

## Goal

Debug Kai's `provider failure -> safe fallback -> end_turn` behavior offline on
the AWS host using synthetic local states, then land exactly one gateway-side
fix only if the harness proves a narrow root cause.

The branch should not spend Cloudflare quota unless the offline harness finds a
single plausible fix that is worth one real confirmation run.

## Why This Slice

The live system is now stable enough that the current failure is no longer a
transport mystery:

- a real production-style match started and finished
- `match_ended` persisted correctly
- homepage replay and public commentary worked
- the commentary lane showed the degradation clearly

That means the next valuable work is not more infra or engine tuning. It is
classifying Kai's runner/gateway failure shape precisely enough to stop
guessing.

## Branch Contract

This branch is diagnostic-plus-minimal-fix with a hard gate.

Allowed:

- offline synthetic-state harness on AWS
- gateway-boundary instrumentation and classification
- one narrow gateway-side fix if the harness proves a single root cause
- one local verification pass
- at most one real validation run after the fix

Not allowed:

- broad prompt redesign
- new multi-action planning policy work
- engine or geometry tuning
- UI work
- server contract changes
- generic "agent quality" cleanup

## Recommended Approach

Build a small harness that feeds curated synthetic states into the existing
`gateway-openclaw-agent.ts` path on AWS and records what actually happens at
each stage.

The harness should classify, per probe:

- raw provider outcome
- latency
- whether text was extracted
- whether JSON was parseable
- whether the chosen move normalized cleanly
- whether the normalized move was legal
- whether the gateway fell back, and why
- the final emitted `publicThought`

This stays at the real gateway boundary. We do not want a mock parser study or
a generic LLM benchmark; we want to exercise the exact script that the beta run
uses.

## Synthetic State Set

Use a deliberately tiny curated set instead of a broad corpus.

At minimum:

- opening state: the first call shape from `createInitialState(...)`
- post-one-action follow-up state: after one legal non-terminal action, to
  mirror the second-call failure shape
- attack-pressure state: a state with a clearly legal attack, to test whether
  the model can continue pressure instead of bailing
- terminal-pressure state if needed: a state where a decisive line is obvious

The point is not coverage. The point is reproducing the observed live failure
shape under repeatable local conditions.

## Minimal Fix Gate

Only ship a fix if the harness shows one narrow primary cause.

Examples of acceptable minimal fixes:

- response-shape normalization at the gateway boundary
- text extraction hardening for the provider payload
- one prompt wrapper change that makes JSON-only replies materially more stable
- one timeout or process-boundary fix
- one stdin/stdout contract fix

Examples of fixes that do not belong here:

- broad prompt rewrite
- new strategic heuristics
- new planner behavior outside the gateway boundary
- engine-side scoring or balance changes

If the harness shows the failures are broad or inconsistent, end the branch as
diagnostic-only with a clear report.

## Success Criteria

This branch succeeds if:

1. the AWS harness reproduces the offline failure shape on synthetic states
2. the primary failure class can be named precisely
3. if a narrow cause exists, one narrow fix is landed
4. offline reruns show the failure class materially reduced or removed
5. one real validation run confirms the change without reopening transport
   issues

## Failure Criteria

Do not promote a fix from this branch if:

- the harness cannot reproduce the shape reliably
- the cause is broad model weakness rather than one gateway-side defect
- the fix requires touching engine/server/UI surfaces
- the only improvement comes from large prompt/policy rewrites
