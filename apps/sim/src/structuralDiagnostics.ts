import type { EngineEvent, MatchResult, StructuralDiagnostics } from "./types";

export function deriveStructuralDiagnostics(
	engineEvents: EngineEvent[],
	terminalReason: MatchResult["reason"],
): StructuralDiagnostics {
	let firstContactTurn: number | null = null;
	let firstDamageTurn: number | null = null;
	let firstKillTurn: number | null = null;

	for (const event of engineEvents) {
		if (event.type !== "attack") continue;

		if (firstContactTurn === null) {
			firstContactTurn = event.turn;
		}

		if (
			firstDamageTurn === null &&
			(event.outcome.damageDealt > 0 || event.outcome.damageTaken > 0)
		) {
			firstDamageTurn = event.turn;
		}

		if (
			firstKillTurn === null &&
			(event.outcome.attackerCasualties.length > 0 ||
				event.outcome.defenderCasualties.length > 0)
		) {
			firstKillTurn = event.turn;
		}
	}

	return {
		firstContactTurn,
		firstDamageTurn,
		firstKillTurn,
		terminalReason,
	};
}
