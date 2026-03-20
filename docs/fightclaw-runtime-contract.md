# Purpose and scope
This document is the canonical runtime boundary for Fightclaw. It defines how the instruction layer, local helper layer, and authority layer must relate during turn execution.

It describes runtime responsibilities and guarantees, not transport details, endpoint shapes, or engine internals.

# Runtime roles and boundaries
The instruction layer is instructional and orchestration-only. It may explain how to invoke the local helper path, but it must not define legality, authority, or fallback semantics.

The local helper layer is the latency, legality, and fallback boundary. It compiles compact state, applies local legality constraints, invokes providers, and guarantees bounded turn completion even when model quality is weak.

The server and engine layer is the authority layer. It owns authoritative legality, AP and action budget enforcement, state transitions, combat and economy resolution, and terminal conditions.

Legality is computed locally for planning and filtering, then validated authoritatively by the server or engine. The model must not infer legality from scratch as a substitute for that boundary.

# Helper input contract
The helper must accept compact, bounded input sufficient to produce one next-step decision. Input must include only the state needed to choose the next action, the relevant budget context, and any helper-local constraints required for deterministic fallback.

The helper may summarize or compile state, but it must not require the model to reconstruct hidden rules, long histories, or engine authority from raw prompts alone. The helper may be invoked repeatedly while the turn remains open, and each invocation must remain compatible with repeated move submission until turn control changes or `end_turn` or `pass` is sent.

# Helper output contract
The helper must return a bounded next-step decision that can be submitted repeatedly while the turn remains open. The helper must emit a concrete move, a constrained fallback move, or `end_turn` or `pass` when the turn should close.

Any commentary, explanation, or auxiliary text is secondary to the move decision and must never weaken the submission path.

# Timing and continuation budget
Turn handling must be bounded. The helper must make a decision within the configured continuation budget and must degrade cleanly when provider latency, weak reasoning, or partial failure occurs.

Continuation is a helper concern, not a model promise. If the primary path cannot finish in time, the helper must advance to the next fallback without waiting for ideal output.

# Fallback ladder
The helper must implement a deterministic fallback ladder. The ladder may use compact heuristic play, bounded search, cached or distilled state, and finally a safe default action if needed.

Each fallback step must preserve legality constraints and keep the loop moving. No fallback may depend on unbounded reasoning, fresh protocol discovery, or manual intervention.

# Commentary rule
Commentary is best effort only. It may enrich the turn experience, but it must never block, delay, or replace move submission.

If commentary cannot be produced within budget, the helper must still submit the move path normally.

# Weak-box minimum guarantees
Even weak boxes must be able to complete the loop. The runtime must therefore guarantee a bounded path from input to submission through compact planning and fallback, without requiring high-quality model output.

The minimum guarantee is not optimal play; it is continued participation. A weak box must still be able to produce a legal bounded action and hand it to the authority layer for validation.

# Out of scope
This document does not define wire formats, endpoint contracts, prompt templates, engine algorithms, or UI behavior.

It also does not replace authoritative game rules or server-side validation. Those remain owned by the engine and related canonical rule documents.
