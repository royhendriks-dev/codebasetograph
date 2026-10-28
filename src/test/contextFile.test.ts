import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { indexRepo } from "../build.js";
import { componentBundle } from "../angular.js";
import { withDefaults } from "../config.js";
import { addNeighbours, renderFileLine, type FileHit } from "../contextFormat.js";
import { dependencies, linkLines } from "../query.js";

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

test("addNeighbours gives neighbours and the bundle a share of the score; renderFileLine shows at most 3 symbols", async () => {
  const root = await fixture({
    "src/x.component.ts": `import { S } from './s.service';\nexport class XComponent {}\n`,
    "src/x.component.html": `<p></p>`,
    "src/s.service.ts": `export class S {}\n`,
  });
  const { graph } = await indexRepo(root);
  const hit: FileHit = { path: "src/x.component.ts", score: 10, symbols: [], fileMatch: true, evidence: "extracted", why: "" };
  const out = addNeighbours(graph, [hit]);
  assert.deepEqual(out.map((h) => h.path), ["src/x.component.ts", "src/s.service.ts", "src/x.component.html"]);
  assert.equal(out[1].score, 5);
  assert.equal(out[1].evidence, "resolved");
  assert.equal(out[2].evidence, "inferred");
  const syms = ["a", "b", "c", "d", "e"].map((name, i) => ({ id: `sym:p#${name}`, kind: "symbol" as const, name, path: "p", detail: "function", lines: [i + 1, i + 2] as [number, number], exported: i === 0 }));
  assert.equal(renderFileLine({ path: "p", score: 1, symbols: syms, fileMatch: false, evidence: "extracted", why: "" }), "- p [extracted] function a:1*, function b:2, function c:3 (+2 more)");
  assert.equal(renderFileLine(out[1]), "- src/s.service.ts [resolved] linked with src/x.component.ts");
});
