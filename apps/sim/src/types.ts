import type {
	AgentId,
	EngineConfigInput,
	EngineEvent,
	GameState,
	MatchState,
	Move,
	TerminalState,
} from "@fightclaw/engine";

export type {
	AgentId,
	EngineConfigInput,
	EngineEvent,
	GameState,
	MatchState,
	Move,
	TerminalState,
};

export type MatchResult = {
	seed: number;
	turns: number;
	winner: AgentId | null;
	illegalMoves: number;
	reason: "terminal" | "maxTurns" | "illegal";
	structuralDiagnostics?: StructuralDiagnostics;
	turnPacingDiagnostics?: TurnPacingDiagnostics;
	log?: MatchLog;
};

export type StructuralDiagnostics = {
	firstContactTurn: number | null;
	firstDamageTurn: number | null;
	firstKillTurn: number | null;
	terminalReason: MatchResult["reason"];
};

export type TurnPacingDiagnostics = {
	meanActionsPerTurn: number;
	oneActionTurnRate: number;
	attackRate: number;
	objectiveTakeRate: number;
	meaningfulTickerDensity: number;
};

export type MatchLog = {
	seed: number;
	players: [AgentId, AgentId];
	moves: Move[];
	engineEvents: EngineEvent[];
	finalState?: MatchState;
};

export type SerializedBotConfig = {
	type: "random" | "greedy" | "aggressive" | "mockllm";
	llmConfig?: {
		strategy?: string;
		inline?: string;
		file?: string;
		archetype?: string;
	};
};

export type Bot = {
	id: AgentId;
	name: string;
	serializedConfig?: SerializedBotConfig;
	chooseMove: (ctx: {
		state: MatchState;
		legalMoves: Move[];
		turn: number;
		rng: () => number;
	}) => Promise<Move> | Move;
	chooseTurn?: (ctx: {
		state: MatchState;
		legalMoves: Move[];
		turn: number;
		rng: () => number;
	}) => Promise<Move[]>;
	chooseTurnWithMeta?: (ctx: {
		state: MatchState;
		legalMoves: Move[];
		turn: number;
		rng: () => number;
	}) => Promise<{
		moves: Move[];
		prompt?: string;
		rawOutput?: string;
		model?: string;
	}>;
};
