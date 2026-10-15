import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { indexRepo } from "../build.js";
import { dependents, findSymbols } from "../query.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-"));
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), c);
  }
  return root;
}

test("markdown: headings are symbols (not inside code fences) and links to indexed files are resolved edges", async () => {
  const root = await fixture({
    "docs/guide.md": "# Guide\n\n## Deploy steps ##\n\n```sh\n# not a heading\n```\n\nSee [code](../src/a.ts#L1), [again](../src/a.ts), [site](https://x.io), [img](pic.png), [gone](missing.md), [abs](/etc/passwd), [up](../../x.md).\n",
    "src/a.ts": "export const a = 1;\n",
  });
  const { graph } = await indexRepo(root);
  assert.ok(findSymbols(graph, "Deploy steps").some((n) => n.path === "docs/guide.md" && n.detail === "md h2"));
  assert.equal(findSymbols(graph, "not a heading").length, 0);
  const links = graph.edges.filter((e) => e.from === "file:docs/guide.md" && e.kind === "references");
  assert.deepEqual(links.map((e) => [e.to, e.evidence]), [["file:src/a.ts", "resolved"]]);
  assert.ok(dependents(graph, "src/a.ts").some((e) => e.from === "file:docs/guide.md"));
});
