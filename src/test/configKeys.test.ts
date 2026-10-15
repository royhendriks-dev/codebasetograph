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

test("config keys: .properties and .env.example give key names only, never values or a real .env", async () => {
  const root = await fixture({
    "app/application.properties": `# comment\nquarkus.http.header."X-Frame".value=SECRETVALUE1\nquarkus.datasource.password: SECRETVALUE2\nquarkus.http.port=8080\nquarkus.http.port=9090\n`,
    ".env.example": `export API_TOKEN=SECRETVALUE3\nDB_HOST=localhost\n! not a key\n`,
    ".env": `REAL_SECRET=SECRETVALUE4\n`,
  });
  const { graph } = await indexRepo(root);
  const json = JSON.stringify(graph);
  for (const v of ["SECRETVALUE1", "SECRETVALUE2", "SECRETVALUE3", "SECRETVALUE4", "REAL_SECRET"]) assert.ok(!json.includes(v), v);
  assert.ok(findSymbols(graph, "quarkus.datasource.password").some((n) => n.path === "app/application.properties"));
  assert.equal(findSymbols(graph, "quarkus.http.port").length, 1);
  assert.ok(findSymbols(graph, "API_TOKEN").some((n) => n.path === ".env.example"));
  assert.ok(!graph.nodes.some((n) => n.path === ".env"));
});
