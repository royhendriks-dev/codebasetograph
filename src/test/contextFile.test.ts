import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { indexRepo } from "../build.js";
import { componentBundle } from "../angular.js";
import { withDefaults } from "../config.js";
import { context, dependencies, linkLines } from "../query.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-"));
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), c);
  }
  return root;
}

test("withDefaults uses the default of ${VAR:-x} and ${VAR-x}, and leaves ${VAR} alone", () => {
  assert.equal(withDefaults("${CTX:-./backend}"), "./backend");
  assert.equal(withDefaults("${CTX-./backend}/x"), "./backend/x");
  assert.equal(withDefaults("${CTX}"), "${CTX}");
  assert.equal(withDefaults("./plain"), "./plain");
});

test("compose: build context and dockerfile with ${VAR:-default} resolve to the real Dockerfile", async () => {
  const root = await fixture({
    "compose.yaml": "services:\n  api:\n    build:\n      context: ${API_DIR:-./backend}\n      dockerfile: ${API_FILE:-Dockerfile.dev}\n",
    "backend/Dockerfile.dev": "FROM node:20\n",
  });
  const { graph } = await indexRepo(root);
  const e = graph.edges.find((x) => x.from === "file:compose.yaml" && x.to === "file:backend/Dockerfile.dev");
  assert.equal(e?.evidence, "resolved");
  assert.equal(graph.edges.some((x) => x.specifier?.includes("${")), false, "no placeholder node left");
});

test("linkLines lists a file imported twice once, with every line", async () => {
  const root = await fixture({
    "a.ts": `import { x } from './b';\nimport type { T } from './b';\nconst l = () => import('./b');\nimport { y } from './missing';\nimport { z } from './missing2';\n`,
    "b.ts": `export const x = 1; export type T = 1;\n`,
  });
  const { graph } = await indexRepo(root);
  const raw = dependencies(graph, "a.ts");
  assert.ok(raw.filter((e) => e.to === "file:b.ts").length >= 2, "graph keeps one edge per import");
  const out = linkLines(raw, "to");
  assert.equal(out.filter((l) => l.startsWith("b.ts")).length, 1);
  assert.match(out.find((l) => l.startsWith("b.ts"))!, /^b\.ts:1,2,3 \[resolved\]$/);
  assert.equal(out.filter((l) => l.includes("[unresolved]")).length, 2, "different missing targets stay apart");
});

test("componentBundle finds template, style and spec next to a component .ts only", () => {
  const paths = ["src/a/x.component.ts", "src/a/x.component.html", "src/a/x.component.scss", "src/a/x.component.spec.ts", "src/a/y.component.html", "src/a/x.component.css"];
  assert.deepEqual(componentBundle(paths, "src/a/x.component.ts"), ["src/a/x.component.html", "src/a/x.component.scss", "src/a/x.component.css", "src/a/x.component.spec.ts"]);
  assert.deepEqual(componentBundle(paths, "src/a/x.component.spec.ts"), []);
  assert.deepEqual(componentBundle(paths, "src/a/x.component.html"), []);
});

test("context: one line per file with at most 3 symbols, and the Angular bundle follows its component", async () => {
  const root = await fixture({
    "src/panel.component.ts": `export class PanelComponent {}\nexport function zebraA() {}\nexport function zebraB() {}\nexport function zebraC() {}\nexport function zebraD() {}\n`,
    "src/panel.component.html": `<p></p>`,
    "src/panel.component.scss": `p {}`,
    "src/other.ts": `export const x = 1;\n`,
  });
  const { graph } = await indexRepo(root);
  const r = context(graph, "zebraA");
  const first = r.text.split("\n").filter((l) => l.startsWith("- src/panel.component.ts"));
  assert.equal(first.length, 1, "file listed once");
  assert.match(first[0], /\(\+\d+ more\)/);
  assert.equal((first[0].match(/function|class/g) ?? []).length, 3);
  assert.match(r.text, /- src\/panel\.component\.html \[inferred\] template, style or spec of src\/panel\.component\.ts/);
  assert.ok(r.text.includes("panel.component.scss"));
  assert.ok(!r.text.includes("other.ts"));
});
