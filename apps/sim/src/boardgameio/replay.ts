import { Engine } from "../engineAdapter";
import { createCombatScenario } from "../scenarios/combatScenarios";
import type { MatchState } from "../types";
import { sha256, stableStringify } from "./artifact";
import type { MatchArtifact, ReplayResult } from "./types";

/**
 * Replays a recorded match artifact, verifying per-ply pre- and post-state hashes and the final state hash.
 *
 * @param artifact - Recorded match artifact containing initial seed/participants (or scenario), the sequence of accepted moves with recorded pre/post hashes, and the expected final state hash
 * @returns `ok: true` with `finalStateHash` when replay matches the artifact; otherwise `ok: false` and an `error` message (the returned object may include `finalStateHash` when final verification fails)
 */
export function replayBoardgameArtifact(artifact: MatchArtifact): ReplayResult {
	let state: MatchState = artifact.scenario
		? createCombatScenario(
				artifact.seed,
				artifact.participants,
				artifact.scenario,
			)
		: Engine.createInitialState(artifact.seed, artifact.participants);

	for (const entry of artifact.acceptedMoves) {
		const preHash = hashState(state);
		if (preHash !== entry.preHash) {
			return {
				ok: false,
				error: `Pre-state hash mismatch at ply ${entry.ply}`,
			};
		}
		const result = Engine.applyMove(state, entry.engineMove);
		if (!result.ok) {
			return {
				ok: false,
				error: `Engine rejected move during replay at ply ${entry.ply}: ${result.reason}`,
			};
		}
		state = result.state;
		const postHash = hashState(state);
		if (postHash !== entry.postHash) {
			return {
				ok: false,
				error: `Post-state hash mismatch at ply ${entry.ply}`,
			};
		}
	}

	const finalStateHash = hashState(state);
	if (finalStateHash !== artifact.finalStateHash) {
		return {
			ok: false,
			error: "Final state hash mismatch",
			finalStateHash,
		};
	}

	return {
		ok: true,
		finalStateHash,
	};
}

/**
 * Produces a deterministic SHA-256 hash of a match state for integrity verification.
 *
 * @param state - The match state to hash
 * @returns The hex-encoded SHA-256 hash of the stable JSON representation of `state`
 */
function hashState(state: MatchState): string {
	return sha256(stableStringify(state));
}