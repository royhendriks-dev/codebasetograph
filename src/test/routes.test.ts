import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { indexRepo } from "../build.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-routes-"));
  for (const [p, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), text);
  }
  return root;
}

test("routes: TS clients link to the JAX-RS resource whose route they call (inferred)", async () => {
  const root = await fixture({
    "backend/AuthResource.java": `package a;\nimport jakarta.ws.rs.*;\n@Path("/api/auth")\npublic class AuthResource {\n  @POST @Path("/login") public void login() {}\n  @GET @Path("session") public void session() {}\n}\n`,
    "backend/HighscoreResource.java": `package a;\n@Path("/api/{game}/highscores")\npublic class HighscoreResource { @GET public void top() {} }\n`,
    "backend/Plain.java": `package a;\npublic class Plain {}\n`,
    "web/auth.service.ts": `const AUTH_URL = '/api/auth';\nexport const x = AUTH_URL + '/login';\n`,
    "web/highscore.service.ts": "export const u = (game: string) => `/api/${game}/highscores`;\n",
    "web/too-short.ts": `export const a = '/api'; export const b = '/api/'; export const c = '/other/path';\n`,
    "web/auth.service.spec.ts": `const t = '/api/auth/login';\n`,
  });
  const { graph } = await indexRepo(root);
  const to = (from: string) => graph.edges.filter((e) => e.from === `file:${from}` && e.specifier?.startsWith("/")).map((e) => `${e.to.slice(5)} ${e.evidence}`);
  assert.deepEqual(to("web/auth.service.ts"), ["backend/AuthResource.java inferred"]);
  assert.deepEqual(to("web/highscore.service.ts"), ["backend/HighscoreResource.java inferred"]);
  assert.deepEqual(to("web/too-short.ts"), [], "one segment or no matching route: no edge");
  assert.deepEqual(to("web/auth.service.spec.ts"), [], "test files are not clients");
  assert.deepEqual(graph.files["backend/AuthResource.java"].routes, ["/api/auth", "/api/auth/login", "/api/auth/session"]);
  assert.equal(graph.files["backend/Plain.java"].routes, undefined);
});
