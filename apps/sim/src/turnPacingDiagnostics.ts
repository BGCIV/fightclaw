import type { EngineEvent, MatchState, TurnPacingDiagnostics } from "./types";

function round(value: number, digits = 4): number {
	return Number(value.toFixed(digits));
}

function isActionEvent(event: EngineEvent): boolean {
	return (
		event.type === "move_unit" ||
		event.type === "attack" ||
		event.type === "recruit" ||
		event.type === "fortify" ||
		event.type === "upgrade"
	);
}

function isMeaningfulTickerEvent(event: EngineEvent): boolean {
	return (
		event.type === "attack" ||
		event.type === "recruit" ||
		event.type === "upgrade" ||
		event.type === "control_update"
	);
}

export function deriveTurnPacingDiagnostics(
	engineEvents: EngineEvent[],
	_state?: MatchState,
): TurnPacingDiagnostics {
	let totalTurns = 0;
	let totalActions = 0;
	let oneActionTurns = 0;
	let attacks = 0;
	let objectiveTakes = 0;
	let meaningfulEvents = 0;
	let currentTurnActions = 0;
	let turnOpen = false;

	const finalizeCurrentTurn = () => {
		if (!turnOpen) return;
		totalTurns += 1;
		totalActions += currentTurnActions;
		if (currentTurnActions === 1) {
			oneActionTurns += 1;
		}
		currentTurnActions = 0;
		turnOpen = false;
	};

	for (const event of engineEvents) {
		if (event.type === "turn_start") {
			finalizeCurrentTurn();
			turnOpen = true;
			currentTurnActions = 0;
			continue;
		}

		if (isActionEvent(event)) {
			if (!turnOpen) {
				turnOpen = true;
				currentTurnActions = 0;
			}
			currentTurnActions += 1;
			if (event.type === "attack") {
				attacks += 1;
			}
		}

		if (event.type === "control_update") {
			objectiveTakes += event.changes.filter(
				(change) => change.to !== null,
			).length;
		}

		if (isMeaningfulTickerEvent(event)) {
			if (event.type === "control_update") {
				meaningfulEvents += event.changes.length;
			} else {
				meaningfulEvents += 1;
			}
		}

		if (event.type === "turn_end" || event.type === "game_end") {
			finalizeCurrentTurn();
		}
	}

	finalizeCurrentTurn();

	if (totalTurns <= 0 || totalActions <= 0) {
		return {
			meanActionsPerTurn: 0,
			oneActionTurnRate: 0,
			attackRate: 0,
			objectiveTakeRate: 0,
			meaningfulTickerDensity: 0,
		};
	}

	return {
		meanActionsPerTurn: round(totalActions / totalTurns, 2),
		oneActionTurnRate: round(oneActionTurns / totalTurns, 4),
		attackRate: round(attacks / totalActions, 4),
		objectiveTakeRate: round(objectiveTakes / totalTurns, 4),
		meaningfulTickerDensity: round(meaningfulEvents / totalTurns, 2),
	};
}
