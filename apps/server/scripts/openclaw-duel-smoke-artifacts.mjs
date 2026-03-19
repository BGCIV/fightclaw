import { writeFileSync } from "node:fs";
import path from "node:path";

const toArtifactSnapshot = (snapshot, fallbackLabel) => {
	if (snapshot && typeof snapshot === "object") {
		return snapshot;
	}
	return {
		ok: false,
		status: null,
		error: `${fallbackLabel}_not_captured`,
		text: "",
		json: null,
	};
};

const writeJson = (filePath, value) => {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

export const createSmokeArtifactBundle = ({ dir, logFiles }) => {
	const matchIdFile = path.join(dir, "match-id.txt");
	const finalLogFile = path.join(dir, "final-log.json");
	const finalStateFile = path.join(dir, "final-state.json");
	const summaryFile = path.join(dir, "summary.json");

	let matchId = null;
	let finalLog = toArtifactSnapshot(null, "final_log");
	let finalState = toArtifactSnapshot(null, "final_state");

	const flushMatchId = () => {
		writeFileSync(matchIdFile, matchId ? `${matchId}\n` : "", "utf8");
	};

	const flushFinalLog = () => {
		writeJson(finalLogFile, finalLog);
	};

	const flushFinalState = () => {
		writeJson(finalStateFile, finalState);
	};

	flushMatchId();
	flushFinalLog();
	flushFinalState();

	return {
		setMatchId(value) {
			matchId =
				typeof value === "string" && value.trim().length > 0
					? value.trim()
					: null;
			flushMatchId();
		},
		setFinalLogSnapshot(snapshot) {
			finalLog = toArtifactSnapshot(snapshot, "final_log");
			flushFinalLog();
		},
		setFinalStateSnapshot(snapshot) {
			finalState = toArtifactSnapshot(snapshot, "final_state");
			flushFinalState();
		},
		async persistFailureArtifacts(failureMessage) {
			flushMatchId();
			flushFinalLog();
			flushFinalState();
			const summary = {
				failureMessage,
				matchId,
				matchIdFile,
				finalLogFile,
				finalStateFile,
				logFiles,
				finalLog,
				finalState,
			};
			writeJson(summaryFile, summary);
			return {
				matchId,
				matchIdFile,
				finalLogFile,
				finalStateFile,
				summaryFile,
			};
		},
	};
};
