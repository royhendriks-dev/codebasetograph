import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { indexRepo } from "../build.js";
import { overview, renderOverviewMarkdown } from "../overview.js";
import { installGit, WORKFLOW_FILE, workflow } from "../install.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-ov-"));
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), c);
  }
  return root;
}

const repo = {
  "frontend/src/api.ts": "import { x } from 'rxjs';\nexport const SECRET_ROUTE = '/api/hidden/route';\n",
  "frontend/src/app.ts": "import { SECRET_ROUTE } from './api';\nexport class App {}\n",
  "frontend/src/app.spec.ts": "import { App } from './app';\n",
  "backend/src/main/java/a/HiddenResource.java": "package a;\nimport jakarta.ws.rs.Path;\n@Path(\"/api/hidden\")\npublic class HiddenResource { @Path(\"route\") public String get() { return \"\"; } }\n",
  "k8s/app.yaml": "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  containers:\n  - name: c\n    image: x\n    env:\n    - name: A\n      valueFrom:\n        secretKeyRef:\n          name: very-secret-name\n          key: k\n",
  "README.md": "# Readme\n",
};

test("overview: folder groups and counts, links between folders, no file, symbol, route or secret names", async () => {
  const root = await fixture(repo);
  const { graph } = await indexRepo(root);
  const o = overview(graph);
  assert.deepEqual(o.groups.map((g) => g.id), ["(root)", "backend", "frontend", "k8s"]);
  const fe = o.groups.find((g) => g.id === "frontend")!;
  assert.deepEqual([fe.files, fe.testFiles, fe.externalImports], [3, 1, 1]);
  assert.deepEqual(fe.languages, { ts: 3 });
  assert.deepEqual(o.links, [{ from: "frontend", to: "backend", count: 1 }], "the route link crosses folders; links inside a folder are not listed");
  assert.equal(o.totals.files, 6);
  const text = JSON.stringify(o) + renderOverviewMarkdown(o);
  for (const leak of ["api.ts", "SECRET_ROUTE", "HiddenResource", "/api/hidden", "very-secret-name", "App"]) assert.ok(!text.includes(leak), `no ${leak}`);
  const md = renderOverviewMarkdown(o);
  assert.match(md, /```mermaid\nflowchart LR\n/);
  assert.match(md, /g2 -->\|1\| g1/);
  assert.match(md, /\| frontend \| 3 \| 1 \| \d+ \| ts 3 \| 1 \|/);
});

test("overview: folder names cannot break out of the Mermaid label", () => {
  const md = renderOverviewMarkdown({ version: 1, root: "r", totals: { files: 1, symbols: 0, links: 0 }, links: [],
    groups: [{ id: 'x"]-->evil[<b>', files: 1, testFiles: 0, symbols: 0, languages: {}, externalImports: 0 }] });
  assert.ok(md.includes('g0["x__--_evil__b_<br/>1 files, 0 symbols"]'));
});

test("cli: view --overview writes overview.json and GRAPH.md", async () => {
  const root = await fixture(repo);
  await indexRepo(root);
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "cli.js");
  const out = path.join(root, "out");
  await promisify(execFile)(process.execPath, [cli, "view", "--overview", "--root", root, "--out", out]);
  assert.equal(JSON.parse(await fs.readFile(path.join(out, "overview.json"), "utf8")).version, 1);
  assert.match(await fs.readFile(path.join(out, "GRAPH.md"), "utf8"), /^# Code graph: /);
});

test("install git: views branch is configurable and validated; views are committed only on push", async () => {
  const root = await fixture({ "a.ts": "export const a = 1;\n" });
  await installGit(root, { viewsBranch: "develop" });
  const wf = await fs.readFile(path.join(root, WORKFLOW_FILE), "utf8");
  assert.ok(wf.includes("push:\n    branches: [develop]"));
  assert.ok(wf.includes("if: github.event_name == 'push'\n"), "view step runs only after a merge");
  assert.ok(wf.includes("github.event_name == 'push' && '.cbtg/graph.json .cbtg/graph.html .cbtg/graph-map.html .cbtg/overview.json .cbtg/GRAPH.md' || '.cbtg/graph.json'"));
  assert.match(await fs.readFile(path.join(root, ".gitattributes"), "utf8"), /\.cbtg\/graph-map\.html linguist-generated=true merge=binary/);
  assert.throws(() => workflow("https://example.com/r.git", "main", "dev]\n  evil"), /invalid branch name/);
});
