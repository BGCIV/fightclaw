import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxPath = path.resolve("node_modules/.bin/tsx");

const runCli = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
	return await new Promise<{
		code: number | null;
		stdout: string;
		stderr: string;
	}>((resolve, reject) => {
		const child = spawn(tsxPath, [cliPath, ...args], {
			cwd: path.dirname(path.dirname(cliPath)),
			env: {
				...process.env,
				...env,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ code, stdout, stderr });
		});
	});
};

let server: ReturnType<typeof createServer> | null = null;
let baseUrl = "";
const requests: Array<{
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}> = [];

before(async () => {
	server = createServer(async (req, res) => {
		const body = await new Promise<string>((resolve) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			});
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		});

		requests.push({
			method: req.method ?? "GET",
			url: req.url ?? "",
			headers: req.headers as Record<string, string | string[] | undefined>,
			body,
		});

		if (req.method === "POST" && req.url === "/v1/auth/verify") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					agentId: "agent-123",
					verifiedAt: "2026-03-19T15:00:00.000Z",
				}),
			);
			return;
		}

		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: false, error: "not found" }));
	});

	await new Promise<void>((resolve) => {
		server?.listen(0, "127.0.0.1", () => {
			const address = server?.address();
			if (!address || typeof address === "string") {
				throw new Error("Failed to bind verify test server.");
			}
			baseUrl = `http://127.0.0.1:${address.port}`;
			resolve();
		});
	});
});

after(async () => {
	await new Promise<void>((resolve) => {
		server?.close(() => resolve());
	});
});

test("verify command posts claim code and admin key then prints JSON", async () => {
	const result = await runCli(
		[
			"verify",
			"--baseUrl",
			baseUrl,
			"--claimCode",
			"ABCD-EFGH",
			"--adminKey",
			"admin-key",
		],
		{ NODE_ENV: "test" },
	);

	assert.equal(result.code, 0);
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.method, "POST");
	assert.equal(requests[0]?.url, "/v1/auth/verify");
	assert.equal(requests[0]?.headers["x-admin-key"], "admin-key");
	assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
		claimCode: "ABCD-EFGH",
	});
	assert.deepEqual(JSON.parse(result.stdout), {
		agentId: "agent-123",
		verifiedAt: "2026-03-19T15:00:00.000Z",
	});
});

test("verify command throws when claimCode is missing", async () => {
	const result = await runCli(
		["verify", "--baseUrl", baseUrl, "--adminKey", "admin-key"],
		{ NODE_ENV: "test" },
	);

	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /verify requires --claimCode/);
});

test("verify command throws when adminKey is missing", async () => {
	const result = await runCli(
		["verify", "--baseUrl", baseUrl, "--claimCode", "ABCD-EFGH"],
		{ NODE_ENV: "test", ADMIN_KEY: "" },
	);

	assert.notEqual(result.code, 0);
	assert.match(
		result.stderr,
		/verify requires --adminKey or ADMIN_KEY env var/,
	);
});
