import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { handleLine, handleRpc, hookOutput, TOOLS } from "../agent.js";
import { indexRepo } from "../build.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-"));
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), c);
  }
  return root;
}

const repo = { "src/limiter.ts": `export class LoginRateLimiter {}`, "src/auth.ts": `import { LoginRateLimiter } from "./limiter";\nexport const auth = new LoginRateLimiter();`, "src/a/dup.ts": `export const dup = 1;`, "src/b/dup.ts": `export const dup = 2;` };
const call = async (root: string, name: string, args: Record<string, unknown>) => {
  const res = (await handleRpc({ id: 1, method: "tools/call", params: { name, arguments: args } }, root)) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return res.result;
};

test("mcp: initialize, tools/list, notifications, unknown methods and bad json", async () => {
  const root = await fixture(repo);
  const init = (await handleRpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, root)) as { result: { protocolVersion: string; capabilities: object } };
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(await handleRpc({ method: "notifications/initialized" }, root), undefined);
  assert.deepEqual(await handleRpc({ id: 2, method: "ping" }, root), { jsonrpc: "2.0", id: 2, result: {} });
  const list = (await handleRpc({ id: 3, method: "tools/list" }, root)) as { result: { tools: Array<{ name: string }> } };
  assert.equal(list.result.tools.length, TOOLS.length);
  assert.match(JSON.stringify(await handleRpc({ id: 4, method: "nope" }, root)), /-32601/);
  assert.match(JSON.stringify(await handleRpc({ id: 5, method: "tools/call", params: { name: "nope" } }, root)), /-32602/);
  assert.match((await handleLine("{not json", root)) ?? "", /-32700/);
  assert.equal(await handleLine(JSON.stringify({ method: "notifications/initialized" }), root), undefined);
});

test("mcp: tools answer from the graph, report a missing graph and ambiguous names", async () => {
  const root = await fixture(repo);
  assert.equal((await call(root, "cbtg_find", { term: "x" })).isError, true);
  await indexRepo(root);
  assert.match((await call(root, "cbtg_context", { task: "login rate limiter" })).content[0].text, /src\/limiter\.ts/);
  assert.match((await call(root, "cbtg_find", { term: "LoginRate" })).content[0].text, /LoginRateLimiter \(class\)/);
  assert.match((await call(root, "cbtg_deps", { file: "src/auth.ts" })).content[0].text, /src\/limiter\.ts:1 \[resolved\]/);
  assert.match((await call(root, "cbtg_dependents", { file: "src/limiter.ts" })).content[0].text, /src\/auth\.ts/);
  assert.match((await call(root, "cbtg_related", { file: "src/auth.ts", depth: 1 })).content[0].text, /src\/limiter\.ts \(distance 1\)/);
  assert.match((await call(root, "cbtg_explain", { target: "auth.ts" })).content[0].text, /-> src\/limiter\.ts/);
  assert.match((await call(root, "cbtg_explain", { target: "dup.ts" })).content[0].text, /ambiguous/);
  assert.match((await call(root, "cbtg_explain", { target: "zzz" })).content[0].text, /not found/);
  assert.match((await call(root, "cbtg_path", { from: "src/auth.ts", to: "src/limiter.ts" })).content[0].text, /imports src\/limiter\.ts/);
  assert.match((await call(root, "cbtg_path", { from: "src/auth.ts", to: "dup.ts" })).content[0].text, /ambiguous/);
  assert.match((await call(root, "cbtg_path", { from: "zzz", to: "src/auth.ts" })).content[0].text, /not found/);
  assert.match((await call(root, "cbtg_path", { from: "src/a/dup.ts", to: "src/limiter.ts" })).content[0].text, /no path/);
  assert.match((await call(root, "cbtg_find", { term: "nothing-like-this" })).content[0].text, /nothing found/);
  assert.match((await call(root, "cbtg_find", { term: "LoginRate" })).content[0].text, /not instructions/);
});

test("hook: adds task context for a prompt, and nothing without graph, usable prompt or match", async () => {
  const root = await fixture(repo);
  const prompt = JSON.stringify({ prompt: "change the login rate limiter please" });
  assert.equal(await hookOutput(prompt, root), "");
  await indexRepo(root);
  const out = JSON.parse(await hookOutput(prompt, root)) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /src\/limiter\.ts/);
  assert.equal(await hookOutput(JSON.stringify({ prompt: "hello" }), root), "");
  assert.equal(await hookOutput(JSON.stringify({ prompt: "zzzz qqqq wwww xxxx" }), root), "");
  assert.equal(await hookOutput("not json", root), "");
});

test("cli: mcp speaks JSON-RPC lines on stdio and hook prints context", async () => {
  const root = await fixture(repo);
  const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "cli.js");
  await indexRepo(root);
  const run = (cmd: string, input: string) => new Promise<string>((resolve, reject) => {
    const p = spawn(process.execPath, [cli, cmd, "--root", root]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", () => resolve(out));
    p.stdin.end(input);
  });
  const lines = (await run("mcp", [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cbtg_find", arguments: { term: "limiter" } } }), "", JSON.stringify({ method: "notifications/initialized" })].join("\n") + "\n")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /LoginRateLimiter \(class\)/);
  assert.match(await run("hook", JSON.stringify({ prompt: "change the login rate limiter please" })), /additionalContext/);
  assert.equal(await run("hook", "garbage"), "");
});
