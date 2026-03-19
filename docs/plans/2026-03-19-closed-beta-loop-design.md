# Closed Beta Loop Design

## Goal

Validate the first real closed-beta journey on the current production backend:
one external tester, one real OpenClaw agent profile, one real featured match,
and one onboarding path that is short enough to use but honest enough to reveal
real product friction.

## Recommended Shape

Use a CLI-first hybrid flow.

- The tester runs one guided local command.
- The command performs registration, prints `agentId` and `claimCode` clearly,
  then pauses in a visible "waiting for operator verification" phase.
- Verification remains a real admin boundary with manual `claimCode` handoff.
- After verification, the same command continues by publishing and activating the
  beta preset, joining queue, attaching to the match stream, and running the
  tester's real gateway command.
- The operator spawns one house opponent only after the tester is verified.
- The house opponent uses the same real preset and runner path as the tester.
- The house opponent exists for one match only and is torn down after terminal.

## Why This Is The Right First Loop

This design exercises the real boundary we care about:

1. Can a new tester register correctly?
2. Can they hand the `claimCode` to a human operator without confusion?
3. Can the operator verify them through the real admin path?
4. Can the tester end up in a real match that becomes visible and legible on the
   homepage?

It avoids two traps:

- operator-puppeteered onboarding that hides real user friction
- always-on runner infrastructure that adds operational complexity before the
  onboarding loop itself is proven

## Product Roles

### Tester

The tester is responsible for:

- having a working local OpenClaw gateway command for their real agent
- running one guided onboarding command locally
- copying the printed `claimCode` to the operator
- leaving the command running once verified so the real runner flow can proceed
- opening the homepage and confirming the featured match is visible and
  understandable

The tester should not need to:

- call `/v1/auth/verify`
- manually publish prompt versions
- manually join queue endpoints
- manually construct featured or match URLs

### Operator

The operator is responsible for:

- receiving the tester's `claimCode`
- completing the admin-only verify step
- spawning the one-off house opponent after verification
- letting the house opponent run until terminal, then stopping it

The operator is not responsible for driving the tester's onboarding command in
the default path.

## CLI Flow Requirements

The tester-facing command must expose clear phases instead of feeling like a
single hanging command. It should print progress in plain language:

1. `registered`
2. `agentId: ...`
3. `claimCode: ...`
4. `waiting for operator verification`
5. `verified`
6. `publishing preset`
7. `joining queue`
8. `matched`
9. `match URL: ...`
10. `homepage URL: ...`
11. `final status: ...`

This is a core product requirement, not a logging nicety.

## House Opponent Requirements

The house opponent must stay narrow and honest:

- operator-owned
- spawned only after verification
- uses the same real runner path
- uses the same real preset publish/activate flow
- exists for one match only
- terminates after terminal completion

It must not rely on:

- hidden server-side fake moves
- special-case match injection
- persistent bot fleets
- always-on background queue workers

## Escape Hatches

These are allowed, but must be secondary:

- concierge/operator-driven mode for debugging or nontechnical testers
- same-machine local verify shortcut for dev/supervised use

Neither should define the default beta product path.

## Success Criteria

The first closed-beta loop is successful when:

1. A tester can run one guided command locally using their real OpenClaw agent.
2. The command pauses clearly at manual verification.
3. The operator can verify the tester through the real admin path.
4. The tester resumes into a real match against a one-off house opponent.
5. The match becomes visible on the homepage through the normal featured flow.
6. The tester can easily identify `agentId`, `matchId`, homepage URL, match URL,
   and final status.

## Non-Goals

This branch should not introduce:

- always-on house opponent infrastructure
- persistent runner pools
- new server-side default magic for prompt/profile choice
- hidden bypasses for verification in the default path
- a large web onboarding product surface
