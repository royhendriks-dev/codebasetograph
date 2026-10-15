import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { watchRepo } from "../watch.js";
import { loadGraph } from "../build.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-"));
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), c);
  }
  return root;
}

/** Resolves when `ready()` is true, polling; fails after `ms`. */
async function until(ready: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("watch: a changed or new file is re-indexed, ignored folders are not, abort stops it", async () => {
  const root = await fixture({ "src/a.ts": `export const a = 1;` });
  const lines: string[] = [];
  const ctl = new AbortController();
  const done = watchRepo({ root, debounceMs: 50, signal: ctl.signal, onIndex: (l) => lines.push(l) });
  await until(() => lines.length >= 1);
  assert.match(lines[0], /indexed 1 files/);
  await fs.mkdir(path.join(root, "node_modules/x"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules/x/ignored.ts"), `export const x = 1;`);
  await fs.writeFile(path.join(root, "src/b.ts"), `import { a } from "./a"; export const b = a;`);
  await until(() => lines.some((l) => /indexed 2 files/.test(l)));
  const g = await loadGraph(root);
  assert.ok(g!.nodes.some((n) => n.path === "src/b.ts"));
  assert.ok(!g!.nodes.some((n) => n.path?.includes("node_modules")));
  ctl.abort();
  await done;
});

test("watch: an already aborted signal indexes once and returns; indexing errors are reported, not thrown", async () => {
  const root = await fixture({ "src/a.ts": `export const a = 1;` });
  const ctl = new AbortController();
  ctl.abort();
  const lines: string[] = [];
  await watchRepo({ root, signal: ctl.signal, onIndex: (l, ok) => lines.push(`${ok}:${l}`) });
  assert.match(lines[0], /^true:indexed 1 files/);
  const file = path.join(root, "src/a.ts"); // a file is no repository: indexing fails and is reported
  const errs: Array<[boolean, string]> = [];
  await watchRepo({ root: file, signal: ctl.signal, onIndex: (l, ok) => errs.push([ok, l]) });
  assert.equal(errs.length, 1);
  assert.equal(errs[0][0], false);
});

test("cli: watch indexes, re-indexes after a change and stops on SIGINT", async () => {
  const root = await fixture({ "src/a.ts": `export const a = 1;` });
  const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "cli.js");
  const p = spawn(process.execPath, [cli, "watch", "--root", root, "--debounce", "50"]);
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => p.on("close", resolve));
  await until(() => /indexed 1 files/.test(out));
  await fs.writeFile(path.join(root, "src/b.ts"), `export const b = 2;`);
  await until(() => /indexed 2 files/.test(out));
  p.kill("SIGINT");
  assert.equal(await exited, 0);
});
