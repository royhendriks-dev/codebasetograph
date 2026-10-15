import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { indexRepo, loadGraph } from "../build.js";
import { parseFile } from "../parse.js";
import { context, dependents, findSymbols } from "../query.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-"));
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), c);
  }
  return root;
}

const angular = {
  "src/app/user.service.ts": `import { Injectable } from '@angular/core';\n@Injectable({ providedIn: 'root' })\nexport class UserService { load() {} }\n`,
  "src/app/user-list.component.ts": `import { Component } from '@angular/core';\nimport { UserService } from './user.service';\nimport { gone } from './missing';\n@Component({ selector: 'app-user-list', template: '' })\nexport class UserListComponent { constructor(private s: UserService) {} }\n`,
  "src/app/index.ts": `export * from './user.service';\n`,
  "node_modules/x/index.ts": `export const x = 1;`,
  "dist/out.js": `module.exports = 1;`,
  "src/types.d.ts": `export type T = 1;`,
  ".gitignore": `ignored/\n*.gen.ts\n`,
  "ignored/a.ts": `export const a = 1;`,
  "src/b.gen.ts": `export const b = 1;`,
};

test("parse: symbols, Angular roles, imports, re-exports, dynamic import, require", () => {
  const f = parseFile("a.ts", `import a, { b as c } from './x';\nexport * from './y';\nconst z = require('z');\nimport('./lazy');\n@Component({selector:'app-a'})\nexport class A {}\nexport interface I {}\nexport const k = 1;`);
  assert.deepEqual(f.imports.map((i) => [i.specifier, i.reexport, i.dynamic]), [["./x", false, false], ["./y", true, false], ["z", false, false], ["./lazy", false, true]]);
  assert.deepEqual(f.imports[0].names, ["default", "b"]);
  const byName = Object.fromEntries(f.symbols.map((s) => [s.name, s]));
  assert.equal(byName.A.detail, "component[app-a]");
  assert.equal(byName.I.detail, "interface");
  assert.equal(byName.k.exported, true);
});

test("parse: malformed source does not throw and flags the error", () => {
  const f = parseFile("bad.ts", `export class { import from ;; function (`);
  assert.equal(f.parseError, true);
});

test("index: ignore rules, evidence levels, stable ids", async () => {
  const root = await fixture(angular);
  const { graph } = await indexRepo(root);
  const paths = Object.keys(graph.files).sort();
  assert.deepEqual(paths, ["src/app/index.ts", "src/app/user-list.component.ts", "src/app/user.service.ts"]);
  const ev = (spec: string) => graph.edges.find((e) => e.specifier === spec)?.evidence;
  assert.equal(ev("./user.service"), "resolved");
  assert.equal(ev("./missing"), "unresolved");
  assert.equal(ev("@angular/core"), "inferred");
  assert.ok(graph.nodes.some((n) => n.id === "sym:src/app/user.service.ts#UserService"));
  assert.ok(graph.skipped.some((s) => s.path === "src/types.d.ts"));
});

test("query: find, dependents, context with budget", async () => {
  const root = await fixture(angular);
  const { graph } = await indexRepo(root);
  assert.equal(findSymbols(graph, "UserService")[0].id, "sym:src/app/user.service.ts#UserService");
  assert.deepEqual(dependents(graph, "src/app/user.service.ts").map((e) => e.from).sort(),
    ["file:src/app/index.ts", "file:src/app/user-list.component.ts"]);
  const c = context(graph, "change how the user service loads data", 800);
  assert.match(c.text, /user\.service\.ts:\d+-\d+/);
  assert.match(c.text, /unresolved import/);
  const tiny = context(graph, "user service", 5);
  assert.equal(tiny.truncated, true);
});

test("incremental: unchanged files reused, changed re-parsed, deleted removed, links refreshed", async () => {
  const root = await fixture(angular);
  await indexRepo(root);
  const again = await indexRepo(root);
  assert.deepEqual([again.stats.parsed, again.stats.reused], [0, 3]);

  await fs.writeFile(path.join(root, "src/app/user.service.ts"), `export class UserService {}\nexport class Extra {}\n`);
  await fs.rm(path.join(root, "src/app/index.ts"));
  const r = await indexRepo(root);
  assert.deepEqual([r.stats.parsed, r.stats.reused, r.stats.removed], [1, 1, 1]);
  assert.ok(r.graph.nodes.some((n) => n.id.endsWith("#Extra")));
  assert.ok(!r.graph.nodes.some((n) => n.id === "file:src/app/index.ts"));
  assert.ok(!r.graph.edges.some((e) => e.from === "file:src/app/index.ts"));
});

test("persistence: graph reloads; corrupt graph file triggers clean rebuild", async () => {
  const root = await fixture(angular);
  await indexRepo(root);
  assert.ok(await loadGraph(root));
  await fs.writeFile(path.join(root, ".cbtg/graph.json"), "{not json");
  assert.equal(await loadGraph(root), undefined);
  const r = await indexRepo(root);
  assert.equal(r.stats.parsed, 3);
});
