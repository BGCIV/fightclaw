type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

type CachedMove = {
	agentId: string;
	turn: number;
	stateVersion: number;
	moveId: string;
	timestamp: string;
	action?: string;
	move?: unknown;
};

type CachedThought = {
	agentId: string;
	turn: number;
	stateVersion: number;
	moveId: string;
	timestamp: string;
	text: string;
};

type MatchCacheEntry = {
	afterId: number;
	moves: CachedMove[];
	thoughts: CachedThought[];
	inflight: Promise<void> | null;
};

export type GatewayRecentMove = {
	turn: number;
	stateVersion: number;
	moveId: string;
	timestamp: string;
	action?: string;
	move?: unknown;
};

export type GatewayRecentThought = {
	turn: number;
	stateVersion: number;
	moveId: string;
	timestamp: string;
	text: string;
};

export type GatewayTurnContext = {
	current?: {
		turn?: number;
		actionsRemaining?: number;
		activePlayer?: string;
	};
	recentOwnMoves: GatewayRecentMove[];
	recentEnemyMoves: GatewayRecentMove[];
	recentOwnThoughts: GatewayRecentThought[];
	recentEnemyThoughts: GatewayRecentThought[];
};

export type MatchContextStoreOptions = {
	baseUrl: string;
	adminKey: string;
	fetchImpl?: FetchLike;
	recentLimit?: number;
	logPageLimit?: number;
	onError?: (error: Error) => void;
};

type BuildTurnContextInput = {
	matchId: string;
	agentId: string;
	state?: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;

const asFiniteNumber = (value: unknown): number | undefined => {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return value;
};

const asText = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

const extractCurrentState = (
	state: unknown,
):
	| { turn?: number; actionsRemaining?: number; activePlayer?: string }
	| undefined => {
	const stateRecord = asRecord(state);
	if (!stateRecord) return undefined;
	const maybeState = asRecord(stateRecord.state);
	const statePayload = maybeState ?? stateRecord;
	const game = asRecord(statePayload.game);
	const turn = asFiniteNumber(game?.turn) ?? asFiniteNumber(statePayload.turn);
	const actionsRemaining = asFiniteNumber(game?.actionsRemaining);
	const activePlayer =
		asText(game?.activePlayer) ?? asText(statePayload.activePlayer);
	if (
		turn === undefined &&
		actionsRemaining === undefined &&
		activePlayer === undefined
	) {
		return undefined;
	}
	return {
		...(turn === undefined ? {} : { turn }),
		...(actionsRemaining === undefined ? {} : { actionsRemaining }),
		...(activePlayer === undefined ? {} : { activePlayer }),
	};
};

export class MatchContextStore {
	private readonly baseUrl: string;

	private readonly fetchImpl: FetchLike;

	private readonly recentLimit: number;

	private readonly logPageLimit: number;

	private readonly onError?: (error: Error) => void;

	private readonly caches = new Map<string, MatchCacheEntry>();

	constructor(options: MatchContextStoreOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.adminKey = options.adminKey;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.recentLimit = Math.max(1, options.recentLimit ?? 8);
		this.logPageLimit = Math.max(1, options.logPageLimit ?? 500);
		this.onError = options.onError;
	}

	async buildTurnContext(
		input: BuildTurnContextInput,
	): Promise<GatewayTurnContext> {
		const entry = this.getOrCreateEntry(input.matchId);
		await this.refreshMatchLog(input.matchId, entry);
		const current = extractCurrentState(input.state);
		return {
			...(current ? { current } : {}),
			recentOwnMoves: this.selectMoves(entry.moves, input.agentId, true),
			recentEnemyMoves: this.selectMoves(entry.moves, input.agentId, false),
			recentOwnThoughts: this.selectThoughts(
				entry.thoughts,
				input.agentId,
				true,
			),
			recentEnemyThoughts: this.selectThoughts(
				entry.thoughts,
				input.agentId,
				false,
			),
		};
	}

	private getOrCreateEntry(matchId: string): MatchCacheEntry {
		const existing = this.caches.get(matchId);
		if (existing) return existing;
		const created: MatchCacheEntry = {
			afterId: 0,
			moves: [],
			thoughts: [],
			inflight: null,
		};
		this.caches.set(matchId, created);
		return created;
	}

	private async refreshMatchLog(
		matchId: string,
		entry: MatchCacheEntry,
	): Promise<void> {
		if (!entry.inflight) {
			entry.inflight = this.fetchLogDelta(matchId, entry)
				.catch((error) => {
					const normalized =
						error instanceof Error ? error : new Error(String(error));
					this.onError?.(
						new Error(
							`Failed fetching match log for ${matchId}: ${normalized.message}`,
						),
					);
				})
				.finally(() => {
					entry.inflight = null;
				});
		}
		await entry.inflight;
	}

	private async fetchLogDelta(
		matchId: string,
		entry: MatchCacheEntry,
	): Promise<void> {
		let cursor = entry.afterId;
		while (true) {
			const res = await this.fetchImpl(this.buildLogUrl(matchId, cursor), {
				method: "GET",
				headers: {
					accept: "application/json",
					"x-admin-key": this.adminKey,
				},
			});
			if (!res.ok) {
				throw new Error(`Match log request failed (${res.status}).`);
			}
			const payload = (await res.json().catch(() => null)) as unknown;
			const body = asRecord(payload);
			if (!body || !Array.isArray(body.events)) {
				throw new Error("Match log payload missing events array.");
			}

			const events = body.events;
			if (events.length === 0) {
				break;
			}

			let maxId = cursor;
			for (const event of events) {
				const row = asRecord(event);
				if (!row) continue;
				const eventId = asFiniteNumber(row.id);
				if (eventId === undefined || eventId <= cursor) continue;
				maxId = Math.max(maxId, eventId);
				this.ingestEvent(row, entry);
			}

			if (maxId <= cursor) break;
			cursor = maxId;
			entry.afterId = maxId;

			if (events.length < this.logPageLimit) {
				break;
			}
		}
	}

	private readonly adminKey: string;

	private buildLogUrl(matchId: string, afterId: number): string {
		const params = new URLSearchParams({
			afterId: String(afterId),
			limit: String(this.logPageLimit),
		});
		return `${this.baseUrl}/v1/matches/${encodeURIComponent(matchId)}/log?${params.toString()}`;
	}

	private ingestEvent(
		event: Record<string, unknown>,
		entry: MatchCacheEntry,
	): void {
		const eventType = asText(event.eventType);
		if (!eventType) return;
		const payload = asRecord(event.payload);
		if (!payload) return;
		const turn = asFiniteNumber(event.turn);
		if (turn === undefined) return;
		const fallbackTimestamp = asText(event.ts);
		if (eventType === "move_applied") {
			const agentId = asText(payload.agentId);
			const moveId = asText(payload.moveId);
			const stateVersion = asFiniteNumber(payload.stateVersion);
			const timestamp = asText(payload.ts) ?? fallbackTimestamp;
			const move = payload.move;
			const moveRecord = asRecord(move);
			const action =
				asText(moveRecord?.action) ??
				asText(moveRecord?.type) ??
				asText(payload.action) ??
				asText(payload.type);
			if (!agentId || !moveId || stateVersion === undefined || !timestamp)
				return;
			entry.moves.push({
				agentId,
				turn,
				stateVersion,
				moveId,
				timestamp,
				...(action ? { action } : {}),
				...(move === undefined ? {} : { move }),
			});
			this.trimBuffer(entry.moves);
			return;
		}
		if (eventType === "agent_thought") {
			const agentId = asText(payload.agentId);
			const moveId = asText(payload.moveId);
			const stateVersion = asFiniteNumber(payload.stateVersion);
			const text = asText(payload.text);
			const timestamp = asText(payload.ts) ?? fallbackTimestamp;
			if (
				!agentId ||
				!moveId ||
				stateVersion === undefined ||
				!text ||
				!timestamp
			) {
				return;
			}
			entry.thoughts.push({
				agentId,
				turn,
				stateVersion,
				moveId,
				timestamp,
				text,
			});
			this.trimBuffer(entry.thoughts);
		}
	}

	private trimBuffer<T>(items: T[]): void {
		const maxSize = this.recentLimit * 4;
		if (items.length <= maxSize) return;
		items.splice(0, items.length - maxSize);
	}

	private selectMoves(
		moves: CachedMove[],
		agentId: string,
		own: boolean,
	): GatewayRecentMove[] {
		return moves
			.filter((entry) =>
				own ? entry.agentId === agentId : entry.agentId !== agentId,
			)
			.slice(-this.recentLimit)
			.map((entry) => ({
				turn: entry.turn,
				stateVersion: entry.stateVersion,
				moveId: entry.moveId,
				timestamp: entry.timestamp,
				...(entry.action ? { action: entry.action } : {}),
				...(entry.move === undefined ? {} : { move: entry.move }),
			}));
	}

	private selectThoughts(
		thoughts: CachedThought[],
		agentId: string,
		own: boolean,
	): GatewayRecentThought[] {
		return thoughts
			.filter((entry) =>
				own ? entry.agentId === agentId : entry.agentId !== agentId,
			)
			.slice(-this.recentLimit)
			.map((entry) => ({
				turn: entry.turn,
				stateVersion: entry.stateVersion,
				moveId: entry.moveId,
				timestamp: entry.timestamp,
				text: entry.text,
			}));
	}
}
