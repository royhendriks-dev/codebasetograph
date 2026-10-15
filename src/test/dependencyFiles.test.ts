import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { indexRepo } from "../build.js";
import { findSymbols } from "../query.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-"));
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), c);
  }
  return root;
}

const edgesOf = (g: Awaited<ReturnType<typeof indexRepo>>["graph"], from: string) =>
  g.edges.filter((e) => e.from === `file:${from}` && e.kind !== "declares").map((e) => [e.to, e.evidence]).sort();

test("package.json: dependencies are extracted package edges, scripts are symbols, versions and commands are not kept", async () => {
  const root = await fixture({
    "package.json": `{\n "scripts": { "build": "tsc --secret-flag", "test": "node --test" },\n "dependencies": { "rxjs": "^7.0.0" },\n "devDependencies": { "typescript": "5.0.0" }\n}\n`,
    "broken/package.json": `{ not json`,
  });
  const { graph } = await indexRepo(root);
  assert.deepEqual(edgesOf(graph, "package.json"), [["pkg:rxjs", "extracted"], ["pkg:typescript", "extracted"]]);
  assert.ok(findSymbols(graph, "script:build").some((n) => n.path === "package.json"));
  assert.ok(!JSON.stringify(graph).includes("secret-flag"));
  assert.ok(!JSON.stringify(graph).includes("^7.0.0"));
});

test("pom.xml: modules link to child poms, in-repo artifacts are inferred links, external ones are package nodes", async () => {
  const root = await fixture({
    "pom.xml": `<project><parent><artifactId>boot-parent</artifactId></parent><artifactId>root</artifactId>\n<!-- <module>commented</module> -->\n<modules><module>core</module><module>web</module><module>gone</module></modules></project>`,
    "core/pom.xml": `<project><artifactId>core</artifactId><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId></dependency><dependency><groupId>\${g}</groupId><artifactId>\${x}</artifactId></dependency></dependencies></project>`,
    "web/pom.xml": `<project><artifactId>web</artifactId><dependencies><dependency><groupId>acme</groupId><artifactId>core</artifactId></dependency><dependency><groupId>acme</groupId><artifactId>core</artifactId></dependency></dependencies></project>`,
  });
  const { graph } = await indexRepo(root);
  assert.ok(findSymbols(graph, "root").some((n) => n.detail === "maven artifact" && n.path === "pom.xml"));
  assert.deepEqual(edgesOf(graph, "pom.xml"), [["file:core/pom.xml", "resolved"], ["file:gone/pom.xml", "unresolved"], ["file:web/pom.xml", "resolved"]]);
  assert.deepEqual(edgesOf(graph, "web/pom.xml"), [["file:core/pom.xml", "inferred"]]);
  assert.deepEqual(edgesOf(graph, "core/pom.xml"), [["pkg:maven:junit:junit", "extracted"]]);
});
