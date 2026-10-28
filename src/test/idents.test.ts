import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFile } from "../parse.js";
import { parseJava } from "../java.js";
import { identWords, rankByIdents } from "../idents.js";
import type { Graph } from "../model.js";

test("idents: names are split into words, strings and comments are left out", () => {
  const f = parseFile("src/boot.ts", `// secretcomment\nexport function startBoot(screenTimer: number) { const label = "hiddenstring"; return screenTimer + label.length; }\n`);
  assert.ok(f.idents?.includes("boot") && f.idents.includes("screen") && f.idents.includes("timer"));
  assert.ok(!f.idents?.includes("secretcomment") && !f.idents?.includes("hiddenstring"));
});

test("idents: java identifiers are collected", async () => {
  const f = await parseJava("A.java", `package a;\n// nopecomment\npublic class A { private int retryCount; void sendMail() { String s = "nopestring"; } }\n`);
  assert.ok(f.idents?.includes("retry") && f.idents.includes("mail"));
  assert.ok(!f.idents?.includes("nopecomment") && !f.idents?.includes("nopestring"));
});

test("identWords: capped, short words and numbers dropped", () => {
  const w = identWords(["a", "x1", "fooBar", "fooBar", "123"]);
  assert.deepEqual(w, ["bar", "foo"]);
  assert.equal(identWords(Array.from({ length: 400 }, (_, i) => `word${"abcdefghij"[i % 10]}${i}x`)).length <= 150, true);
});

test("rankByIdents: rare words and stems rank a file, tests count less", () => {
  const mk = (path: string, idents: string[]) => ({ path, hash: "", parseError: false, symbols: [], imports: [], idents });
  const g = { files: {
    "a.ts": mk("a.ts", ["timer", "common"]), "b.ts": mk("b.ts", ["common", "other"]), "c.ts": mk("c.ts", ["common"]),
    "a.spec.ts": mk("a.spec.ts", ["timer"]),
  } } as unknown as Graph;
  const r = rankByIdents(g, ["timers", "common"]);
  assert.equal(r[0].path, "a.ts");
  assert.ok(r.findIndex((x) => x.path === "a.spec.ts") > 0);
  assert.deepEqual(rankByIdents(g, []), []);
});
