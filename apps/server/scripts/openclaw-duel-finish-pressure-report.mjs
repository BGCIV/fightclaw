import { readFileSync } from "node:fs";
import path from "node:path";

const isObject = (value) => value !== null && typeof value === "object";

const isTerminalAction = (action) => action === "end_turn" || action === "pass";

export const extractTurnSummaries = (logPayload) => {
	const events = Array.isArray(logPayload?.events) ? logPayload.events : [];
	/** @type {Map<string, {turn:number|null, player:string|null, actions:string[], ended:boolean, hasAttack:boolean, matchId:string|null}>} */
	const turns = new Map();

	for (const event of events) {
		if (!isObject(event) || event.event !== "engine_events") continue;
		const payload = isObject(event.payload) ? event.payload : null;
		const move = isObject(payload?.move) ? payload.move : null;
		const action = typeof move?.action === "string" ? move.action : null;
		const engineEvents = Array.isArray(payload?.engineEvents)
			? payload.engineEvents
			: [];
		if (!action) continue;
		const taggedEvent = engineEvents.find(
			(entry) =>
				isObject(entry) &&
				typeof entry.turn === "number" &&
				typeof entry.player === "string",
		);
		const turn =
			typeof taggedEvent?.turn === "number" ? taggedEvent.turn : null;
		const player =
			typeof taggedEvent?.player === "string" ? taggedEvent.player : null;
		const key = `${player ?? "unknown"}:${turn ?? "unknown"}`;
		const current = turns.get(key) ?? {
			turn,
			player,
			actions: [],
			ended: false,
			hasAttack: false,
			matchId: typeof event.matchId === "string" ? event.matchId : null,
		};
		current.actions.push(action);
		if (action === "attack") current.hasAttack = true;
		if (
			engineEvents.some((entry) => isObject(entry) && entry.type === "turn_end")
		) {
			current.ended = true;
		}
		turns.set(key, current);
	}

	return Array.from(turns.values());
};

export const summarizeFinishPressure = (logPayload) => {
	const turns = extractTurnSummaries(logPayload);
	const completedTurns = turns.filter((turn) => turn.ended);
	const totalMoves = turns.reduce((sum, turn) => sum + turn.actions.length, 0);
	const explicitEndTurnMoves = turns.reduce(
		(sum, turn) =>
			sum + turn.actions.filter((action) => action === "end_turn").length,
		0,
	);
	const passMoves = turns.reduce(
		(sum, turn) =>
			sum + turn.actions.filter((action) => action === "pass").length,
		0,
	);
	const attackMoves = turns.reduce(
		(sum, turn) =>
			sum + turn.actions.filter((action) => action === "attack").length,
		0,
	);
	const nonTerminalMoves = turns.reduce(
		(sum, turn) =>
			sum + turn.actions.filter((action) => !isTerminalAction(action)).length,
		0,
	);
	const turnStats = completedTurns.map((turn) => {
		const nonTerminalActions = turn.actions.filter(
			(action) => !isTerminalAction(action),
		).length;
		const lastAction = turn.actions[turn.actions.length - 1] ?? null;
		return {
			turn: turn.turn,
			player: turn.player,
			actions: turn.actions,
			actionCount: turn.actions.length,
			nonTerminalActions,
			lastAction,
			endedByExplicitEndTurn: lastAction === "end_turn",
			immediateExplicitEndTurn:
				lastAction === "end_turn" && nonTerminalActions === 0,
			hasAttack: turn.hasAttack,
		};
	});
	const completedTurnCount = completedTurns.length;

	return {
		matchId:
			turns.find((turn) => typeof turn.matchId === "string")?.matchId ?? null,
		totalTurnsObserved: turns.length,
		completedTurns: completedTurnCount,
		totalMoves,
		nonTerminalMoves,
		completedNonTerminalMoves: turnStats.reduce(
			(sum, turn) => sum + turn.nonTerminalActions,
			0,
		),
		explicitEndTurnMoves,
		passMoves,
		attackMoves,
		turnsWithExplicitEndTurn: turnStats.filter(
			(turn) => turn.endedByExplicitEndTurn,
		).length,
		immediateExplicitEndTurns: turnStats.filter(
			(turn) => turn.immediateExplicitEndTurn,
		).length,
		turnsWithMultipleActions: turnStats.filter(
			(turn) => turn.nonTerminalActions >= 2,
		).length,
		turnsWithAttack: turnStats.filter((turn) => turn.hasAttack).length,
		averageNonTerminalActionsPerCompletedTurn:
			completedTurnCount > 0
				? Number(
						(
							turnStats.reduce(
								(sum, turn) => sum + turn.nonTerminalActions,
								0,
							) / completedTurnCount
						).toFixed(2),
					)
				: 0,
		turns: turnStats,
	};
};

export const readSmokeArtifactSummary = (artifactDir) => {
	const finalLogPath = path.join(artifactDir, "final-log.json");
	const raw = JSON.parse(readFileSync(finalLogPath, "utf8"));
	if (raw?.ok !== true) {
		throw new Error(`Smoke artifact log is not marked ok: ${finalLogPath}`);
	}
	if (!Array.isArray(raw?.json?.events)) {
		throw new Error(
			`Smoke artifact log is missing canonical events: ${finalLogPath}`,
		);
	}
	return summarizeFinishPressure(raw?.json ?? null);
};

export const combineFinishPressureSummaries = (summaries) => {
	const aggregate = {
		sampleCount: summaries.length,
		completedTurns: 0,
		totalMoves: 0,
		nonTerminalMoves: 0,
		completedNonTerminalMoves: 0,
		explicitEndTurnMoves: 0,
		passMoves: 0,
		attackMoves: 0,
		turnsWithExplicitEndTurn: 0,
		immediateExplicitEndTurns: 0,
		turnsWithMultipleActions: 0,
		turnsWithAttack: 0,
		averageNonTerminalActionsPerCompletedTurn: 0,
	};
	for (const summary of summaries) {
		aggregate.completedTurns += summary.completedTurns;
		aggregate.totalMoves += summary.totalMoves;
		aggregate.nonTerminalMoves += summary.nonTerminalMoves;
		aggregate.completedNonTerminalMoves += summary.completedNonTerminalMoves;
		aggregate.explicitEndTurnMoves += summary.explicitEndTurnMoves;
		aggregate.passMoves += summary.passMoves;
		aggregate.attackMoves += summary.attackMoves;
		aggregate.turnsWithExplicitEndTurn += summary.turnsWithExplicitEndTurn;
		aggregate.immediateExplicitEndTurns += summary.immediateExplicitEndTurns;
		aggregate.turnsWithMultipleActions += summary.turnsWithMultipleActions;
		aggregate.turnsWithAttack += summary.turnsWithAttack;
	}
	aggregate.averageNonTerminalActionsPerCompletedTurn =
		aggregate.completedTurns > 0
			? Number(
					(
						aggregate.completedNonTerminalMoves / aggregate.completedTurns
					).toFixed(2),
				)
			: 0;
	return aggregate;
};

const main = () => {
	const dirs = process.argv.slice(2);
	if (dirs.length === 0) {
		console.error(
			"Usage: node ./apps/server/scripts/openclaw-duel-finish-pressure-report.mjs <artifact-dir> [artifact-dir...]",
		);
		process.exit(1);
	}
	const reports = dirs.map((dir) => ({
		artifactDir: dir,
		...readSmokeArtifactSummary(dir),
	}));
	console.log(
		JSON.stringify(
			{
				reports,
				aggregate: combineFinishPressureSummaries(reports),
			},
			null,
			2,
		),
	);
};

if (import.meta.url === new URL(process.argv[1], "file:").href) {
	main();
}
