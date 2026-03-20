import { pickOne } from "../rng";
import type { Bot } from "../types";

export function makeRandomLegalBot(id: string): Bot {
	return {
		id,
		name: "RandomLegalBot",
		serializedConfig: {
			type: "random",
		},
		chooseMove: async ({ legalMoves, rng }) => pickOne(legalMoves, rng),
	};
}
