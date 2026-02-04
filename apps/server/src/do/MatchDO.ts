import { DurableObject } from "cloudflare:workers";

type MatchState = {
  turn: number;
  updatedAt: string;
  lastMove: Record<string, unknown> | null;
  stateVersion: number;
};

type MoveResult =
  | { ok: true; state: MatchState }
  | { ok: false; error: string };

type MovePayload = {
  moveId: string;
  expectedVersion: number;
  move: Record<string, unknown>;
};

type MoveResponse =
  | { ok: true; state: MatchState }
  | { ok: false; error: string; stateVersion?: number };

type IdempotencyEntry = {
  status: number;
  body: MoveResponse;
};

const IDEMPOTENCY_PREFIX = "move:";

export class MatchDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/move") {
      const body = await request.json().catch(() => null);
      if (!isMovePayload(body)) {
        return Response.json(
          { ok: false, error: "Move payload must include moveId, expectedVersion, and move." },
          { status: 400 },
        );
      }

      const idempotencyKey = `${IDEMPOTENCY_PREFIX}${body.moveId}`;
      const cached = await this.ctx.storage.get<IdempotencyEntry>(idempotencyKey);
      if (cached) {
        return Response.json(cached.body, { status: cached.status });
      }

      const state =
        (await this.ctx.storage.get<MatchState>("state")) ?? createInitialState();
      if (body.expectedVersion !== state.stateVersion) {
        const response = {
          ok: false,
          error: "Version mismatch.",
          stateVersion: state.stateVersion,
        } satisfies MoveResponse;
        await this.ctx.storage.put(idempotencyKey, { status: 409, body: response });
        return Response.json(response, { status: 409 });
      }

      const result = applyMove(state, body.move);

      if (!result.ok) {
        const response = { ok: false, error: result.error } satisfies MoveResponse;
        await this.ctx.storage.put(idempotencyKey, { status: 400, body: response });
        return Response.json(response, { status: 400 });
      }

      await this.ctx.storage.put("state", result.state);
      const response = { ok: true, state: result.state } satisfies MoveResponse;
      await this.ctx.storage.put(idempotencyKey, { status: 200, body: response });
      return Response.json(response);
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const state =
        (await this.ctx.storage.get<MatchState>("state")) ?? createInitialState();
      return Response.json({ state });
    }

    return new Response("Not found", { status: 404 });
  }
}

const createInitialState = (): MatchState => ({
  turn: 0,
  updatedAt: new Date().toISOString(),
  lastMove: null,
  stateVersion: 0,
});

const applyMove = (state: MatchState, move: unknown): MoveResult => {
  if (!isRecord(move)) {
    return { ok: false, error: "Move payload must be an object." };
  }

  return {
    ok: true,
    state: {
      ...state,
      turn: state.turn + 1,
      updatedAt: new Date().toISOString(),
      stateVersion: state.stateVersion + 1,
      lastMove: move,
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMovePayload = (value: unknown): value is MovePayload => {
  if (!isRecord(value)) return false;
  const moveId = value.moveId;
  const expectedVersion = value.expectedVersion;
  const move = value.move;
  return (
    typeof moveId === "string" &&
    moveId.length > 0 &&
    typeof expectedVersion === "number" &&
    Number.isInteger(expectedVersion) &&
    isRecord(move)
  );
};
