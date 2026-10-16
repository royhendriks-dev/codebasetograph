import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as vm from "node:vm";
import { indexRepo, loadGraph } from "../build.js";
import { parseFile } from "../parse.js";
import { context, dependents, findSymbols, nameTokens, sharesStem } from "../query.js";

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

test("view: HTML is self-contained and escapes hostile names", async () => {
  const { renderHtml } = await import("../view.js");
  const root = await fixture({ "src/</script><img src=x onerror=alert(1)>.ts": `export const a = 1;` });
  const { graph } = await indexRepo(root);
  const html = renderHtml(graph);
  assert.ok(html.includes("<title>codebasetograph</title>"));
  assert.ok(!html.includes("</script><img"), "name must not break out of the data script");
  assert.doesNotMatch(html, /https?:\/\//, "no external resources");
  assert.doesNotMatch(html, /innerHTML/);
});

test("view --graph: drawn graph data is limited, deduplicated, self-contained and escapes hostile names", async () => {
  const { renderGraphHtml, graphData } = await import("../viewGraph.js");
  const files: Record<string, string> = { "src/</script><img src=x onerror=alert(1)>.ts": `import "./hub";`, "src/hub.ts": `export const h = 1;`, "src/lonely.ts": `export const l = 1;`, "src/miss.ts": `import "./nope";` };
  for (let i = 0; i < 5; i++) files[`src/leaf${i}.ts`] = `import { h } from "./hub"; import { h as h2 } from "./hub";`;
  const root = await fixture(files);
  const { graph } = await indexRepo(root);
  const all = graphData(graph);
  assert.equal(all.nodes.some((n) => n.id === "src/lonely.ts"), false, "files without links are not drawn");
  assert.equal(all.edges.filter((e) => e.from === "src/leaf0.ts" && e.to === "src/hub.ts").length, 1, "duplicate edges collapse");
  assert.ok(all.edges.some((e) => e.evidence === "unresolved"), "unresolved links stay visible");
  assert.ok(all.nodes.every((n) => !n.id.startsWith("pkg:")), "no package nodes");
  const small = graphData(graph, 2);
  assert.equal(small.shown, 2);
  assert.ok(small.shown < small.connected, "truncation is reported");
  assert.ok(small.nodes.some((n) => n.id === "src/hub.ts"), "most connected file is kept");
  const html = renderGraphHtml(graph);
  assert.ok(!html.includes("</script><img"));
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /innerHTML/);
  const script = html.split("<script>")[1].split("</script>")[0];
  assert.doesNotThrow(() => new vm.Script(script), "inline script must be valid JavaScript");
  assert.equal(graphData({ ...graph, edges: [] }).shown, 0);
  const hub = all.nodes.find((n) => n.id === "src/hub.ts")!;
  assert.deepEqual(hub.syms.map((x) => x[0]), ["h"], "clicking a file can list its symbols");
  assert.ok(all.nodes.every((n) => n.syms.length <= 40));
});

test("dutch tasks: stop words are dropped and a glossary plus user synonyms map Dutch words to code words", async () => {
  const { taskWords, loadSynonyms } = await import("../words.js");
  assert.deepEqual(taskWords("de gebruiker wil inloggen"), ["gebruiker", "inloggen", "user", "login"]);
  assert.ok(taskWords("Wijzig het wachtwoord").includes("password"));
  assert.ok(taskWords("limiet instellen", { limiet: ["limiter"] }).includes("limiter"), "user synonyms are added");
  const root = await fixture({
    "src/login.ts": `export class LoginForm {}`, "src/limiter.ts": `export class Limiter {}`,
    "src/zzz.ts": `export const x = 1;`, "syn.json": `{ "begrenzing": ["limiter"] }`, "bad.json": `{ "a": "x" }`, "arr.json": `[]`,
  });
  const { graph } = await indexRepo(root);
  assert.equal(context(graph, "hoe kan een gebruiker inloggen", 800).items[0].path, "src/login.ts");
  assert.equal(context(graph, "begrenzing aanpassen", 800, await loadSynonyms(path.join(root, "syn.json"))).items[0].path, "src/limiter.ts");
  await assert.rejects(loadSynonyms(path.join(root, "bad.json")), /array of strings/);
  await assert.rejects(loadSynonyms(path.join(root, "arr.json")), /JSON object/);
});

test("cli: context --synonyms and bench --synonyms", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const root = await fixture({ "src/limiter.ts": `export class Limiter {}`, "src/zzz.ts": `export const x = 1;`, "syn.json": `{ "begrenzing": ["limiter"] }`,
    "tasks.json": `[{"id":"t","task":"begrenzing aanpassen","relevant":["src/limiter.ts"]}]` });
  const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "cli.js");
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [cli, ...args, "--root", root, "--synonyms", path.join(root, "syn.json")]);
  await run("index");
  assert.match((await run("context", "begrenzing aanpassen")).stdout, /src\/limiter\.ts/);
  assert.match((await run("bench", path.join(root, "tasks.json"))).stdout, /\| t \| graph context \| 1 \|.*\| 100% \|/);
});

test("tests are linked to their subject by naming convention (inferred), unless they import it", async () => {
  const root = await fixture({
    "src/foo.ts": `export const foo = 1;`, "src/foo.spec.ts": `describe("x", () => {});`,
    "src/bar.ts": `export const bar = 1;`, "src/bar.test.ts": `import { bar } from "./bar"; bar;`,
    "src/orphan.spec.ts": `describe("y", () => {});`,
    "src/main/java/a/Svc.java": `package a; public class Svc {}`, "src/test/java/a/SvcTest.java": `package a; class SvcTest {}`,
    "src/main/java/a/Dup.java": `package a; public class Dup {}`, "src/main/java/b/Dup.java": `package b; public class Dup {}`, "src/test/java/a/DupIT.java": `package a; class DupIT {}`,
  });
  const { graph } = await indexRepo(root);
  const edge = (from: string, to: string) => graph.edges.filter((e) => e.from === `file:${from}` && e.to === `file:${to}`);
  assert.equal(edge("src/foo.spec.ts", "src/foo.ts")[0]?.evidence, "inferred");
  assert.equal(edge("src/bar.test.ts", "src/bar.ts").length, 1, "a real import is not duplicated");
  assert.equal(edge("src/bar.test.ts", "src/bar.ts")[0].evidence, "resolved");
  assert.equal(edge("src/test/java/a/SvcTest.java", "src/main/java/a/Svc.java")[0]?.evidence, "inferred");
  assert.equal(graph.edges.some((e) => e.from === "file:src/orphan.spec.ts" && e.specifier === "test of"), false);
  assert.equal(graph.edges.some((e) => e.from === "file:src/test/java/a/DupIT.java" && e.specifier === "test of"), false, "ambiguous subject: no guess");
  assert.ok(dependents(graph, "src/foo.ts").some((e) => e.from === "file:src/foo.spec.ts"), "the test shows up as dependent");
});

test("graph-dir: the graph can live outside the repo, which then stays untouched", async () => {
  const root = await fixture({ "src/a.ts": `export const a = 1;`, "src/b.ts": `import { a } from "./a"; export const b = a;` });
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-out-"));
  const first = await indexRepo(root, out);
  assert.equal(first.stats.parsed, 2);
  await assert.rejects(fs.stat(path.join(root, ".cbtg")), "no .cbtg inside the repo");
  assert.ok((await loadGraph(root, out))?.files["src/b.ts"]);
  assert.equal(await loadGraph(root), undefined, "default location is untouched");
  const second = await indexRepo(root, out);
  assert.equal(second.stats.reused, 2, "incremental cache works from the custom dir");
});

test("cli: --graph-dir is honoured by index, view and queries", async () => {
  const root = await fixture({ "src/a.ts": `export const a = 1;`, "src/b.ts": `import { a } from "./a"; export const b = a;` });
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-cli-"));
  const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "cli.js");
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [cli, ...args, "--root", root, "--graph-dir", out]);
  assert.match((await run("index")).stdout, /indexed 2 files/);
  assert.match((await run("dependents", "src/a.ts")).stdout, /src\/b\.ts/);
  assert.match((await run("view", "--graph")).stdout, /graph-map\.html/);
  await fs.stat(path.join(out, "graph-map.html"));
  await assert.rejects(fs.stat(path.join(root, ".cbtg")), "repo stays untouched");
});

test("java: package, imports, annotations, methods, same-package and cross-package links", async () => {
  const root = await fixture({
    "src/main/java/app/user/UserService.java": `package app.user;\nimport java.util.List;\nimport jakarta.inject.Inject;\nimport app.api.Greeter;\n@ApplicationScoped\npublic class UserService extends BaseService implements Greeter {\n  public String hello() { return ""; }\n}\n`,
    "src/main/java/app/user/BaseService.java": `package app.user;\npublic abstract class BaseService {}\n`,
    "src/main/java/app/api/Greeter.java": `package app.api;\npublic interface Greeter {}\n`,
    "src/main/java/app/web/UserResource.java": `package app.web;\nimport app.user.UserService;\nimport app.api.*;\nimport static app.user.UserService.hello;\nimport org.other.Missing;\n@Path("/u")\npublic class UserResource { @GET public void get() {} }\n`,
    "target/gen/Skip.java": `package x; class Skip {}`,
    "src/main/java/app/Broken.java": `package app; public class { void ( `,
  });
  const { graph } = await indexRepo(root);
  assert.ok(!graph.files["target/gen/Skip.java"], "target/ is ignored");
  const svc = graph.nodes.find((n) => n.id === "sym:src/main/java/app/user/UserService.java#UserService")!;
  assert.equal(svc.detail, "class @ApplicationScoped");
  assert.ok(graph.nodes.some((n) => n.id.endsWith("UserService.java#UserService.hello")));
  assert.equal(graph.nodes.find((n) => n.id.endsWith("UserResource.java#UserResource"))!.detail, "class @Path");
  const edge = (from: string, kind: string, spec: string) => graph.edges.find((e) => e.from.endsWith(from) && e.kind === kind && e.specifier === spec);
  assert.equal(edge("UserResource.java", "imports", "app.user.UserService")?.evidence, "resolved");
  assert.equal(edge("UserResource.java", "imports", "app.user.UserService.hello")?.evidence, "resolved", "static import resolves to the type");
  assert.equal(edge("UserResource.java", "imports", "org.other.Missing")?.evidence, "inferred");
  assert.equal(edge("UserResource.java", "imports", "app.api")?.evidence, "inferred", "wildcard is inferred");
  assert.equal(edge("UserService.java", "extends", "BaseService")?.to, "file:src/main/java/app/user/BaseService.java", "same-package supertype");
  assert.equal(edge("UserService.java", "extends", "Greeter")?.evidence, "resolved");
  assert.equal(graph.files["src/main/java/app/Broken.java"].parseError, true);
  assert.deepEqual(dependents(graph, "src/main/java/app/user/UserService.java").map((e) => e.from.split("/").pop()).sort(), ["UserResource.java", "UserResource.java"]);
});

test("cache: facts from an older parser version are re-parsed", async () => {
  const root = await fixture({ "a.ts": `export const a = 1;` });
  await indexRepo(root);
  const gp = path.join(root, ".cbtg/graph.json");
  const g = JSON.parse(await fs.readFile(gp, "utf8"));
  g.files["a.ts"].parser = "ts-0";
  await fs.writeFile(gp, JSON.stringify(g));
  assert.equal((await indexRepo(root)).stats.parsed, 1);
});

test("context ranking: source ranks above specs; stopwords ignored; exported symbol beats private const", async () => {
  const root = await fixture({
    "src/auth.service.ts": `export class AuthService {}\nconst AUTH_URL = '/a';\n`,
    "src/auth.service.spec.ts": `import { AuthService } from './auth.service';\nconst AUTH_SPEC = 1;\n`,
    "tests/e2e/auth.ts": `export const x = 1;`,
  });
  const { graph } = await indexRepo(root);
  const { items } = context(graph, "how to change the auth service", 800);
  const first = items.findIndex((i) => i.path === "src/auth.service.ts");
  const spec = items.findIndex((i) => i.path === "src/auth.service.spec.ts");
  assert.equal(items[0].path, "src/auth.service.ts");
  assert.ok(first < spec, "source before spec");
  const { isTestPath } = await import("../query.js");
  assert.ok(isTestPath("a/b.spec.ts") && isTestPath("tests/e2e/auth.ts") && !isTestPath("src/auth.ts"));
});

test("config: workflow, compose, k8s, Dockerfile and SQL are indexed with honest evidence", async () => {
  const root = await fixture({
    ".github/workflows/ci.yml": `name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@abc123\n      - uses: ./.github/actions/setup\n  deploy:\n    uses: ./.github/workflows/missing.yml\n`,
    "compose.yaml": `services:\n  backend:\n    build:\n      context: ./backend\n    depends_on: [db]\n  db:\n    image: postgres:16\n  web:\n    build: ./web\n  api:\n    image: \${API_IMAGE:-local-api:dev}\n`,
    "backend/Dockerfile": `FROM maven:3.9 AS build\nRUN true\nFROM eclipse-temurin:21\nCOPY --from=build /a /b\nFROM build AS again\n`,
    "k8s/backend.yaml": `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: backend\nspec:\n  template:\n    spec:\n      containers:\n        - name: app\n          image: ghcr.io/x/backend:1.2.3\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: backend\n`,
    "db/V1__init.sql": `CREATE TABLE IF NOT EXISTS page_view (id int);\ncreate unique index idx_pv on page_view(id);\n`,
    "bad.yml": `a: [unclosed\n  b: : :`,
  });
  const { graph } = await indexRepo(root);
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const id of ["sym:.github/workflows/ci.yml#job:test", "sym:.github/workflows/ci.yml#job:deploy", "sym:compose.yaml#service:backend",
    "sym:backend/Dockerfile#stage:build", "sym:k8s/backend.yaml#Deployment/backend", "sym:k8s/backend.yaml#Service/backend",
    "sym:db/V1__init.sql#page_view", "sym:db/V1__init.sql#idx_pv"]) assert.ok(ids.has(id), id);
  const ev = (from: string, spec: string) => graph.edges.find((e) => e.from === `file:${from}` && e.specifier === spec)?.evidence;
  assert.equal(ev("compose.yaml", "backend/Dockerfile"), "resolved");
  assert.equal(ev("compose.yaml", "web/Dockerfile"), "unresolved");
  assert.equal(ev("compose.yaml", "postgres"), "inferred");
  assert.equal(ev("compose.yaml", "local-api"), "inferred", "${VAR:-default} uses the default image");
  assert.equal(ev(".github/workflows/ci.yml", "actions/checkout"), "inferred");
  assert.equal(ev(".github/workflows/ci.yml", ".github/workflows/missing.yml"), "unresolved");
  assert.equal(ev("k8s/backend.yaml", "ghcr.io/x/backend"), "inferred");
  assert.equal(ev("backend/Dockerfile", "maven"), "inferred");
  assert.equal(graph.edges.some((e) => e.from === "file:backend/Dockerfile" && e.specifier === "build"), false, "FROM <stage> is not an image");
  assert.equal(graph.files["bad.yml"].parseError, true);
});

test("k8s: kustomization resources and Secret/ConfigMap/PVC/ServiceAccount references link across files", async () => {
  const root = await fixture({
    "k8s/kustomization.yaml": `resources:\n  - backend.yaml\n  - secrets.yaml\n  - ./overlay\n  - missing.yaml\n  - https://example.com/x.yaml\npatches:\n  - path: patch.yaml\n`,
    "k8s/overlay/kustomization.yaml": `resources: []\n`,
    "k8s/patch.yaml": `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: backend\n`,
    "k8s/secrets.yaml": `apiVersion: v1\nkind: Secret\nmetadata:\n  name: db-secret\n`,
    "k8s/backend.yaml": `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: backend\nspec:\n  template:\n    spec:\n      serviceAccountName: runner\n      containers:\n        - name: app\n          image: \${IMG}\n          env:\n            - name: P\n              valueFrom:\n                secretKeyRef:\n                  name: db-secret\n                  key: p\n          envFrom:\n            - configMapRef:\n                name: app-config\n      volumes:\n        - name: d\n          persistentVolumeClaim:\n            claimName: data\n`,
    "compose.yaml": `services:\n  web:\n    build: ./web\n    image: \${WEB_IMAGE}\n`,
  });
  const { graph } = await indexRepo(root);
  const ev = (from: string, spec: string) => graph.edges.find((e) => e.from === `file:${from}` && e.specifier === spec)?.evidence;
  assert.equal(ev("k8s/kustomization.yaml", "k8s/backend.yaml"), "resolved");
  assert.equal(ev("k8s/kustomization.yaml", "k8s/overlay"), "resolved", "directory resolves to its kustomization file");
  assert.equal(graph.edges.find((e) => e.specifier === "k8s/overlay")?.to, "file:k8s/overlay/kustomization.yaml");
  assert.equal(ev("k8s/kustomization.yaml", "k8s/patch.yaml"), "resolved");
  assert.equal(ev("k8s/kustomization.yaml", "k8s/missing.yaml"), "unresolved");
  assert.equal(graph.edges.some((e) => e.specifier?.includes("example.com")), false, "remote resources are skipped");
  assert.equal(ev("k8s/backend.yaml", "Secret/db-secret"), "inferred");
  assert.equal(ev("k8s/backend.yaml", "ConfigMap/app-config"), "unresolved");
  assert.equal(ev("k8s/backend.yaml", "PersistentVolumeClaim/data"), "unresolved");
  assert.equal(ev("k8s/backend.yaml", "ServiceAccount/runner"), "unresolved");
  assert.equal(graph.edges.some((e) => e.from === "file:k8s/backend.yaml" && e.specifier === "${IMG}"), false, "unknown image is not a package");
  assert.equal(graph.edges.some((e) => e.from === "file:compose.yaml" && e.specifier?.includes("WEB_IMAGE")), false, "build + image: the image is only a tag");
});

test("nginx: .conf files expose locations, upstreams and the headers they set", async () => {
  const root = await fixture({
    "web/default.conf": `upstream api { server backend:8080; }\nserver {\n  server_name example.test;\n  location /api/ { proxy_pass http://api; }\n  location ~* \\.(?:js|css)$ {\n    add_header Content-Security-Policy "default-src 'none'" always; # comment\n    add_header Content-Security-Policy "again";\n  }\n}\n`,
  });
  const { graph } = await indexRepo(root);
  const names = graph.nodes.filter((n) => n.path === "web/default.conf" && n.kind === "symbol").map((n) => n.name).sort();
  assert.deepEqual(names, ["header:Content-Security-Policy", "location:/api/", "location:\\.(?:js|css)$", "server_name:example.test", "upstream:api"]);
  const { items } = context(graph, "tighten the content security policy header", 800);
  assert.equal(items[0].path, "web/default.conf");
});

test("config: pathological nesting does not crash the indexer", async () => {
  const root = await fixture({ "deep.yml": "a: " + "[".repeat(20000) + "\n", "ok.yml": "k: v\n" });
  const { graph } = await indexRepo(root);
  assert.ok(graph.files["ok.yml"]);
  assert.equal(graph.files["deep.yml"].parseError, true);
});

test("angular: templateUrl/styleUrl resolve, template tags link to unique component selectors (inferred)", async () => {
  const root = await fixture({
    "src/app/shell.ts": `import { Component } from '@angular/core';\n@Component({ selector: 'app-shell', templateUrl: 'shell.html', styleUrls: ['./shell.scss', './nope.scss'] })\nexport class Shell {}\n`,
    "src/app/shell.html": `<app-login></app-login>\n<app-dup/>\n<mat-icon></mat-icon>\n<div></div>`,
    "src/app/shell.scss": `:host { display: block; }`,
    "src/app/login.ts": `import { Component } from '@angular/core';\n@Component({ selector: 'app-login', template: '<app-icon></app-icon>', styleUrl: './login.css' })\nexport class Login {}\n`,
    "src/app/login.css": `a{}`,
    "src/app/icon.ts": `@Component({ selector: 'app-icon', template: '' })\nexport class Icon {}\n`,
    "src/app/dup1.ts": `@Component({ selector: 'app-dup', template: '' })\nexport class Dup1 {}\n`,
    "src/app/dup2.ts": `@Component({ selector: 'app-dup', template: '' })\nexport class Dup2 {}\n`,
    "src/app/odd.ts": `@Component({ selector: '[appOdd], app-x y', template: '<app-shell></app-shell>' })\nexport class Odd {}\n`,
  });
  const { graph } = await indexRepo(root);
  const e = (from: string, spec: string) => graph.edges.find((x) => x.from === `file:${from}` && x.specifier === spec);
  assert.equal(e("src/app/shell.ts", "./shell.html")?.evidence, "resolved");
  assert.equal(e("src/app/shell.ts", "./shell.html")?.kind, "references");
  assert.equal(e("src/app/shell.ts", "./shell.scss")?.evidence, "resolved");
  assert.equal(e("src/app/shell.ts", "./nope.scss")?.evidence, "unresolved");
  assert.equal(e("src/app/login.ts", "./login.css")?.evidence, "resolved");
  assert.equal(e("src/app/shell.html", "<app-login>")?.to, "file:src/app/login.ts");
  assert.equal(e("src/app/shell.html", "<app-login>")?.evidence, "inferred");
  assert.equal(e("src/app/login.ts", "<app-icon>")?.to, "file:src/app/icon.ts", "inline template");
  assert.equal(e("src/app/shell.html", "<app-dup>"), undefined, "ambiguous selector is not linked");
  assert.equal(e("src/app/shell.html", "<mat-icon>"), undefined, "unknown (library) tag is not linked");
  assert.equal(e("src/app/odd.ts", "<app-shell>")?.to, "file:src/app/shell.ts");
});

test("tsconfig: paths (with extends and baseUrl) resolve, misses are unresolved, other bare imports stay packages", async () => {
  const root = await fixture({
    "tsconfig.base.json": `// comment allowed\n{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/app/*"], "@env": ["src/env.ts"], "@gone/*": ["nowhere/*"] } } }`,
    "tsconfig.json": `{ "extends": "./tsconfig.base.json" }`,
    "src/app/core/svc.ts": `export const svc = 1;`,
    "src/app/core/index.ts": `export const idx = 1;`,
    "src/env.ts": `export const env = 1;`,
    "src/lib/util.ts": `export const util = 1;`,
    "src/main.ts": `import { svc } from '@app/core/svc';\nimport { idx } from '@app/core';\nimport { env } from '@env';\nimport { x } from '@gone/x';\nimport { util } from 'src/lib/util';\nimport { r } from 'rxjs';\n`,
    "pkg/tsconfig.json": `{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }`,
    "pkg/src/a.ts": `export const a = 1;`,
    "pkg/main.ts": `import { a } from '~/a';\n`,
    "bad/tsconfig.json": `{not json`,
  });
  const { graph } = await indexRepo(root);
  const e = (from: string, spec: string) => graph.edges.find((x) => x.from === `file:${from}` && x.specifier === spec);
  assert.equal(e("src/main.ts", "@app/core/svc")?.to, "file:src/app/core/svc.ts");
  assert.equal(e("src/main.ts", "@app/core/svc")?.evidence, "resolved");
  assert.equal(e("src/main.ts", "@app/core")?.to, "file:src/app/core/index.ts", "directory alias resolves to index");
  assert.equal(e("src/main.ts", "@env")?.evidence, "resolved");
  assert.equal(e("src/main.ts", "@gone/x")?.evidence, "unresolved", "alias matched but no file");
  assert.equal(e("src/main.ts", "src/lib/util")?.evidence, "resolved", "baseUrl lookup");
  assert.equal(e("src/main.ts", "rxjs")?.evidence, "inferred");
  assert.equal(e("pkg/main.ts", "~/a")?.to, "file:pkg/src/a.ts", "nearest tsconfig wins");
  assert.equal(graph.aliases?.length, 2, "root (via extends) and pkg; invalid JSON is ignored");
});

test("bench: baseline and graph are compared on the same file cap, report lists both", async () => {
  const root = await fixture(angular);
  const { graph } = await indexRepo(root);
  const tasksFile = path.join(root, "tasks.json");
  await fs.writeFile(tasksFile, JSON.stringify([{ id: "svc", task: "change the user service load", relevant: ["src/app/user.service.ts"] }]));
  const { loadTasks, runBenchmark, renderReport } = await import("../bench.js");
  const rows = await runBenchmark(root, graph, await loadTasks(tasksFile), { maxFiles: 2, budget: 400 });
  assert.equal(rows.length, 1);
  for (const side of [rows[0].baseline, rows[0].graph]) {
    assert.ok(side.files.length <= 2);
    assert.equal(side.recall, 1);
    assert.ok(side.tokens > 0 && side.lines > 0);
  }
  const report = renderReport(rows, { maxFiles: 2, budget: 400 });
  assert.match(report, /grep baseline/);
  assert.match(report, /graph context/);
  assert.match(report, /mean/);
});

test("bench: invalid task files are rejected with a readable error", async () => {
  const root = await fixture({ "bad.json": `{}`, "bad2.json": `[{"task":"x","relevant":[]}]`, "ok.json": `[{"task":"x","relevant":["a.ts"]}]` });
  const { loadTasks } = await import("../bench.js");
  await assert.rejects(loadTasks(path.join(root, "bad.json")), /JSON array/);
  await assert.rejects(loadTasks(path.join(root, "bad2.json")), /non-empty/);
  assert.equal((await loadTasks(path.join(root, "ok.json")))[0].id, "t1");
  const { renderReport } = await import("../bench.js");
  assert.match(renderReport([]), /0 task/);
});

test("explain/path: names resolve without guessing, paths follow resolved links only", async () => {
  const root = await fixture({
    "a/util.ts": `export function helper() {}\nexport const shared = 1;`,
    "b/util.ts": `export const shared = 2;`,
    "src/main.ts": `import { helper } from '../a/util';\nimport { z } from 'zod';`,
    "src/other.ts": `import './main';`,
    "src/island.ts": `import { z } from 'zod';`,
  });
  const { graph } = await indexRepo(root);
  const { resolveTarget, explain, shortestPath } = await import("../query.js");
  const ok = resolveTarget(graph, "helper");
  assert.equal(ok.status, "ok");
  const amb = resolveTarget(graph, "shared");
  assert.equal(amb.status, "ambiguous");
  assert.equal(amb.status === "ambiguous" && amb.candidates.length, 2);
  assert.equal(resolveTarget(graph, "a/util.ts").status, "ok");
  const none = resolveTarget(graph, "helpr");
  assert.equal(none.status, "none");
  const node = (input: string) => { const r = resolveTarget(graph, input); assert.equal(r.status, "ok"); return (r as Extract<typeof r, { status: "ok" }>).node; };
  assert.equal(explain(graph, node("a/util.ts")).incoming.length, 1);
  const x = explain(graph, node("src/main.ts"));
  assert.deepEqual(x.symbols, []);
  assert.equal(x.outgoing.length, 2);
  const p = shortestPath(graph, "src/other.ts", "a/util.ts");
  assert.deepEqual(p?.map((s) => s.path), ["src/other.ts", "src/main.ts", "a/util.ts"]);
  assert.equal(p?.[1].direction, "imports");
  assert.equal(shortestPath(graph, "src/island.ts", "a/util.ts"), undefined); // both only share an inferred package
  assert.deepEqual(shortestPath(graph, "src/main.ts", "src/main.ts")?.length, 1);
});

test("links: deps, related and path follow config references and Java supertypes, only resolved ones in path", async () => {
  const root = await fixture({
    "docker-compose.yml": `services:\n  api:\n    build: ./api\n`,
    "api/Dockerfile": `FROM node:20\n`,
    "src/main/java/a/Base.java": `package a;\npublic class Base {}\n`,
    "src/main/java/a/Impl.java": `package a;\npublic class Impl extends Base {}\n`,
  });
  const { graph } = await indexRepo(root);
  const { dependencies, dependents, related, shortestPath } = await import("../query.js");
  assert.deepEqual(dependencies(graph, "docker-compose.yml").map((e) => [e.kind, e.to, e.evidence]), [["references", "file:api/Dockerfile", "resolved"]]);
  assert.equal(dependents(graph, "api/Dockerfile").length, 1);
  assert.deepEqual(related(graph, "api/Dockerfile").map((r) => r.path), ["docker-compose.yml"]);
  assert.deepEqual(shortestPath(graph, "docker-compose.yml", "api/Dockerfile")?.map((s) => s.path), ["docker-compose.yml", "api/Dockerfile"]);
  assert.deepEqual(shortestPath(graph, "src/main/java/a/Impl.java", "src/main/java/a/Base.java")?.map((s) => s.path), ["src/main/java/a/Impl.java", "src/main/java/a/Base.java"]);
});

test("query: identifier tokens, stem matching and rare words ranking", async () => {
  assert.deepEqual(nameTokens("LoginRateLimiter.java"), ["login", "rate", "limiter", "java"]);
  assert.deepEqual(nameTokens("HTTPServer"), ["http", "server"]);
  assert.equal(sharesStem("lang", "language"), true);
  assert.equal(sharesStem("failure", "failures"), true);
  assert.equal(sharesStem("log", "login"), false, "stems under 4 characters never match");
  const root = await fixture({
    "src/Lang.ts": "export enum Lang { Nl, En }\n",
    "src/request-a.ts": "export const requestA = 1;\n",
    "src/request-b.ts": "export const requestB = 1;\n",
    "src/request-c.ts": "export const requestC = 1;\n",
  });
  const { graph } = await indexRepo(root);
  assert.equal(context(graph, "switch the language", 800).items[0].path, "src/Lang.ts");
  assert.equal(context(graph, "request lang", 800).items[0].path, "src/Lang.ts", "a rare word outweighs a common one");
});

test("index: the default graph directory is excluded from git locally, once", async () => {
  const root = await fixture({ "src/a.ts": "export const a = 1;\n", ".git/info/exclude": "# local\n" });
  await indexRepo(root);
  await indexRepo(root);
  assert.equal(await fs.readFile(path.join(root, ".git", "info", "exclude"), "utf8"), "# local\n.cbtg/\n");
  const kept = await fixture({ "src/a.ts": "export const a = 1;\n", ".git/HEAD": "ref: refs/heads/main\n" });
  await indexRepo(kept, path.join(kept, "..", "elsewhere-graph"));
  await assert.rejects(fs.readFile(path.join(kept, ".git", "info", "exclude"), "utf8"), "a graph kept elsewhere touches nothing in the repo");
});
