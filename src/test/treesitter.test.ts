import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { indexRepo } from "../build.js";
import { parseTreeSitter, treeSitterLangOf } from "../treesitter.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-"));
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), c);
  }
  return root;
}
const syms = (f: { symbols: Array<{ name: string; detail?: string }> }) => f.symbols.map((s) => `${s.name}:${s.detail}`);

test("treeSitterLangOf maps extensions and ignores the rest", () => {
  assert.equal(treeSitterLangOf("a/b.py"), "py");
  assert.equal(treeSitterLangOf("main.go"), "go");
  assert.equal(treeSitterLangOf("X.cs"), "cs");
  assert.equal(treeSitterLangOf("x.ts"), undefined);
  assert.equal(treeSitterLangOf("Makefile"), undefined);
});

test("python: classes, methods, functions, constants and imports", async () => {
  const f = await parseTreeSitter("py", "app/svc.py", `import os, a.b as c
from . import x
from ..pkg.mod import (y, z as w)
from m import *
@dec
class Foo(Base):
    def meth(self): pass
    @property
    def p(self): pass
def top(): pass
async def atop(): pass
MAX = 1
_priv = 2
`);
  assert.deepEqual(syms(f), ["Foo:class", "Foo.meth:method", "Foo.p:method", "top:function", "atop:function", "MAX:const", "_priv:variable"]);
  assert.equal(f.symbols.find((s) => s.name === "_priv")!.exported, false);
  assert.equal(f.symbols.find((s) => s.name === "top")!.exported, true);
  assert.deepEqual(f.imports.map((i) => [i.specifier, ...i.names]), [["os", "*"], ["a.b", "*"], [".", "x"], ["..pkg.mod", "y", "z"], ["m", "*"]]);
  assert.equal(f.parseError, false);
});

test("go: types, methods with receiver, vars, consts and imports", async () => {
  const f = await parseTreeSitter("go", "s/s.go", `package s
import "fmt"
import (
  a "github.com/x/y/z"
  _ "embed"
)
type S struct{ A int }
type I interface{ M() }
type T = int
func F() {}
func (s *S) Meth() {}
var V = 1
const C = 2
`);
  assert.deepEqual(syms(f), ["S:struct", "I:interface", "T:type", "F:function", "S.Meth:method", "V:var", "C:const"]);
  assert.deepEqual(f.imports.map((i) => i.specifier), ["fmt", "github.com/x/y/z", "embed"]);
  assert.equal(f.symbols.find((s) => s.name === "S.Meth")!.exported, true);
});

test("c#: namespaces, types, members and usings", async () => {
  const f = await parseTreeSitter("cs", "N/Foo.cs", `using System;
using static A.B;
using X = Y.Z;
namespace N.M {
  public class Foo : Base {
    public int P { get; set; }
    public void Meth() {}
    public Foo() {}
    class Inner {}
  }
  public interface IFoo { void M(); }
  public enum E { A }
  public record R(int A);
  public struct St {}
}
`);
  assert.deepEqual(syms(f), ["Foo:class", "Foo.P:property", "Foo.Meth:method", "Foo.Foo:constructor", "Foo.Inner:class", "IFoo:interface", "IFoo.M:method", "E:enum", "R:record", "St:struct"]);
  assert.deepEqual(f.imports.map((i) => [i.specifier, i.names[0]]), [["System", "*"], ["A.B", "static"], ["Y.Z", "alias"]]);
  assert.deepEqual(f.namespaces, ["N.M"]);
  assert.equal(f.symbols.find((s) => s.name === "Foo")!.exported, true);
  assert.equal(f.symbols.find((s) => s.name === "Foo.Inner")!.exported, false);
});

test("a syntax error is reported and does not throw", async () => {
  const f = await parseTreeSitter("py", "bad.py", "def (:\n  class\n");
  assert.equal(f.parseError, true);
});

test("python linking: relative and absolute resolved, src layout inferred, external as package", async () => {
  const root = await fixture({
    "pkg/__init__.py": "",
    "pkg/util.py": "def u(): pass\n",
    "pkg/sub/__init__.py": "",
    "pkg/sub/deep.py": "from .. import util\nfrom ..util import u\nfrom . import nothing\n",
    "pkg/main.py": "import pkg.util\nimport requests\nfrom pkg import sub\nimport helpers.tools\n",
    "src/helpers/tools.py": "x = 1\n",
    "src/helpers/__init__.py": "",
  });
  const { graph } = await indexRepo(root);
  const e = (from: string) => graph.edges.filter((x) => x.from === `file:${from}` && x.kind === "imports").map((x) => `${x.to}|${x.evidence}`);
  assert.deepEqual(e("pkg/sub/deep.py"), ["file:pkg/util.py|resolved", "file:pkg/sub/__init__.py|resolved"]);
  const main = e("pkg/main.py");
  assert.ok(main.includes("file:pkg/util.py|resolved"));
  assert.ok(main.includes("file:pkg/sub/__init__.py|resolved"));
  assert.ok(main.includes("pkg:requests|inferred"));
  assert.ok(main.includes("file:src/helpers/tools.py|inferred"));
});

test("go linking: import path ending in a repo directory links its files", async () => {
  const root = await fixture({
    "go.mod": "module example.com/app\n",
    "internal/store/store.go": "package store\nfunc New() {}\n",
    "internal/store/store_test.go": "package store\n",
    "cmd/app/main.go": `package main\nimport (\n "fmt"\n "example.com/app/internal/store"\n)\nfunc main() { store.New(); fmt.Println() }\n`,
  });
  const { graph } = await indexRepo(root);
  const out = graph.edges.filter((x) => x.from === "file:cmd/app/main.go" && x.kind === "imports").map((x) => `${x.to}|${x.evidence}`);
  assert.deepEqual(out, ["pkg:fmt|inferred", "file:internal/store/store.go|inferred"]);
});

test("c# linking: using links files that declare the namespace, System stays a package", async () => {
  const root = await fixture({
    "Models/User.cs": "namespace App.Models { public class User {} }\n",
    "Services/Svc.cs": "using System;\nusing App.Models;\nusing static App.Models.User;\nnamespace App.Services { public class Svc {} }\n",
  });
  const { graph } = await indexRepo(root);
  const out = graph.edges.filter((x) => x.from === "file:Services/Svc.cs" && x.kind === "imports").map((x) => `${x.to}|${x.evidence}`);
  assert.deepEqual(out, ["pkg:cs:System|inferred", "file:Models/User.cs|inferred", "file:Models/User.cs|inferred"]);
});

test("unchanged files are reused and a changed parser version forces a re-parse", async () => {
  const root = await fixture({ "a.py": "def f(): pass\n" });
  const first = await indexRepo(root);
  assert.equal(first.stats.parsed, 1);
  const second = await indexRepo(root);
  assert.deepEqual([second.stats.parsed, second.stats.reused], [0, 1]);
  assert.equal(second.graph.files["a.py"].lang, "py");
});
