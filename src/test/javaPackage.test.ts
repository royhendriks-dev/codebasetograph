import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { indexRepo } from "../build.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-"));
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), c);
  }
  return root;
}

test("java: same-package use without import is linked as inferred references", async () => {
  const root = await fixture({
    "src/com/acme/Repo.java": `package com.acme;\npublic class Repo { }\n`,
    "src/com/acme/Service.java": `package com.acme;\nimport java.util.List;\npublic class Service { private Repo repo; List<String> x; Service self; }\n`,
    "src/com/other/Alien.java": `package com.other;\npublic class Alien { Repo repo; }\n`,
  });
  const { graph } = await indexRepo(root);
  const links = graph.edges.filter((e) => e.kind === "references");
  assert.deepEqual(links.map((e) => [e.from, e.to, e.evidence]), [["file:src/com/acme/Service.java", "file:src/com/acme/Repo.java", "inferred"]]);
});

test("java: a type already imported or extended gets no second same-package edge", async () => {
  const root = await fixture({
    "src/com/acme/Base.java": `package com.acme;\npublic class Base { }\n`,
    "src/com/acme/Child.java": `package com.acme;\npublic class Child extends Base { Base b; }\n`,
  });
  const { graph } = await indexRepo(root);
  const toBase = graph.edges.filter((e) => e.from === "file:src/com/acme/Child.java" && e.to === "file:src/com/acme/Base.java");
  assert.equal(toBase.length, 1);
  assert.equal(toBase[0].kind, "extends");
});
