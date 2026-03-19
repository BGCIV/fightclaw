import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_STATE_ROOT = path.resolve(__dirname, "../.alchemy");
const DEFAULT_LEGACY_WORKER_NAME = "fightclaw-server";

const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));

const writeJson = (filePath, value) => {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const updateBindingScriptNames = (bindings, fromName, toName) => {
	if (!bindings || typeof bindings !== "object") return false;
	let changed = false;
	for (const value of Object.values(bindings)) {
		if (!value || typeof value !== "object") continue;
		if ("scriptName" in value && value.scriptName === fromName) {
			value.scriptName = toName;
			changed = true;
		}
	}
	return changed;
};

const findWorkerStateDirs = (stateRoot) => {
	if (!existsSync(stateRoot)) return [];
	const foundDirs = [];
	const queue = [stateRoot];

	while (queue.length > 0) {
		const currentDir = queue.pop();
		for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (entry.name === "out") continue;
				queue.push(path.join(currentDir, entry.name));
				continue;
			}

			if (entry.isFile() && entry.name === "server.json") {
				foundDirs.push(currentDir);
			}
		}
	}

	return foundDirs.sort();
};

export const repairLegacyWorkerState = ({
	stateDir,
	legacyWorkerName = DEFAULT_LEGACY_WORKER_NAME,
} = {}) => {
	if (!stateDir) {
		return {
			repaired: false,
			changedFiles: [],
			removedLegacyUrlState: false,
			canonicalWorkerName: null,
			stateDir: null,
		};
	}

	const serverFile = path.join(stateDir, "server.json");
	const legacyUrlFile = path.join(stateDir, "server", "url.json");
	const changedFiles = [];

	if (!existsSync(serverFile)) {
		return {
			repaired: false,
			changedFiles,
			removedLegacyUrlState: false,
			canonicalWorkerName: null,
			stateDir,
		};
	}

	const serverState = readJson(serverFile);
	const canonicalWorkerName =
		typeof serverState?.props?.name === "string" &&
		serverState.props.name.trim()
			? serverState.props.name.trim()
			: null;

	if (!canonicalWorkerName || canonicalWorkerName === legacyWorkerName) {
		return {
			repaired: false,
			changedFiles,
			removedLegacyUrlState: false,
			canonicalWorkerName,
			stateDir,
		};
	}

	let repaired = false;
	if (serverState?.output?.name === legacyWorkerName) {
		serverState.output.name = canonicalWorkerName;
		repaired = true;
	}

	if (
		updateBindingScriptNames(
			serverState?.output?.bindings,
			legacyWorkerName,
			canonicalWorkerName,
		)
	) {
		repaired = true;
	}

	if (repaired) {
		writeJson(serverFile, serverState);
		changedFiles.push(serverFile);
	}

	let removedLegacyUrlState = false;
	if (existsSync(legacyUrlFile)) {
		const legacyUrlState = readJson(legacyUrlFile);
		if (
			legacyUrlState?.props?.scriptName === legacyWorkerName ||
			legacyUrlState?.output?.url?.includes(`${legacyWorkerName}.`)
		) {
			rmSync(legacyUrlFile, { force: true });
			removedLegacyUrlState = true;
			changedFiles.push(legacyUrlFile);
		}
	}

	return {
		repaired: repaired || removedLegacyUrlState,
		changedFiles,
		removedLegacyUrlState,
		canonicalWorkerName,
		stateDir,
	};
};

export const repairLegacyWorkerStates = ({
	stateRoot = DEFAULT_STATE_ROOT,
	legacyWorkerName = DEFAULT_LEGACY_WORKER_NAME,
} = {}) => {
	const stateDirs = findWorkerStateDirs(stateRoot);
	const results = stateDirs.map((stateDir) =>
		repairLegacyWorkerState({
			stateDir,
			legacyWorkerName,
		}),
	);

	return {
		repaired: results.some((result) => result.repaired),
		removedLegacyUrlState: results.some(
			(result) => result.removedLegacyUrlState,
		),
		canonicalWorkerNames: [
			...new Set(
				results
					.map((result) => result.canonicalWorkerName)
					.filter((name) => typeof name === "string" && name.length > 0),
			),
		].sort(),
		changedFiles: results.flatMap((result) => result.changedFiles),
		results,
		stateDirs,
	};
};

const main = () => {
	const result = repairLegacyWorkerStates();
	if (!result.repaired) {
		console.log(
			JSON.stringify({
				ok: true,
				repaired: false,
				canonicalWorkerNames: result.canonicalWorkerNames,
				stateDirs: result.stateDirs,
			}),
		);
		return;
	}
	console.log(
		JSON.stringify({
			ok: true,
			repaired: true,
			canonicalWorkerNames: result.canonicalWorkerNames,
			removedLegacyUrlState: result.removedLegacyUrlState,
			changedFiles: result.changedFiles,
			stateDirs: result.stateDirs,
		}),
	);
};

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
