import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { indexRepo, loadGraph, serializeGraph } from "../build.js";
import { historyForGraph, messageWords, readGitHistory } from "../history.js";
import { context, historyRanking } from "../query.js";
import { renderReport, runGitBenchmark, taskTitle, tasksFromGit } from "../bench.js";

const run = promisify(execFile);
const git = (root: string, ...args: string[]) => run("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args]);

/** A git repository built commit by commit: each step writes files, then commits them with the message. */
async function repo(steps: Array<[string, Record<string, string>]>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-git-"));
  await git(root, "init", "-q", "-b", "main");
  for (const [message, files] of steps) {
    for (const [p, c] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
      await fs.writeFile(path.join(root, p), c);
    }
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", message);
  }
  return root;
}

const app = {
  "src/boot-screen.ts": "export class BootScreen { wait = 15; }\n",
  "src/desktop.ts": "import { BootScreen } from './boot-screen';\nexport class Desktop {}\n",
  "src/texts.ts": "export const TEXTS = {};\n",
};

test("history: message words skip trailers, URLs, stop words, numbers and hashes but keep a subject with a colon", () => {
  const words = messageWords("Logging: k3s-logs naar Loki (#119)\n\nZie https://example.com/x en commit 4fa6c61b.\nCo-Authored-By: Someone <a@b.c>\nSigned-off-by: x");
  assert.deepEqual(words, ["logging", "k3s", "logs", "loki", "zie", "commit"]);
});

test("history: index stores words and indexed files per commit; a commit that only touches the graph is dropped", async () => {
  const root = await repo([
    ["Eerste versie van het bureaublad", app],
    ["Opstartscherm: knoppen duidelijker", { "src/boot-screen.ts": "export class BootScreen { wait = 10; }\n", "notes.bin": "x" }],
    ["chore: update code graph (cbtg)", { ".cbtg/graph.json": "{}" }],
  ]);
  const { graph } = await indexRepo(root);
  assert.equal(graph.history?.length, 2);
  assert.deepEqual(graph.history![0].files, ["src/boot-screen.ts"], "only indexed files are kept");
  assert.ok(graph.history![0].words.includes("opstartscherm"));
  assert.ok(!graph.history!.some((c) => c.words.includes("chore")));
  const reloaded = await loadGraph(root);
  assert.deepEqual(reloaded?.history, graph.history, "history survives serialisation");
  assert.match(serializeGraph(graph), /\n"history":\[\n\{"id":/);
});

test("history: context finds a file whose names share no word with the task, via earlier commit messages", async () => {
  const root = await repo([
    ["Eerste versie van het bureaublad", app],
    ["Opstartscherm: knoppen duidelijker", { "src/boot-screen.ts": "export class BootScreen { wait = 10; }\n" }],
    ["Opstartscherm wacht 5 seconden", { "src/boot-screen.ts": "export class BootScreen { wait = 5; }\n" }],
  ]);
  const { graph } = await indexRepo(root);
  assert.equal(historyRanking(graph, ["opstartscherm"]).get("src/boot-screen.ts")?.words.has("opstartscherm"), true);
  const c = context(graph, "opstartscherm sneller", 800);
  assert.equal(c.items[0].path, "src/boot-screen.ts");
  assert.match(c.text, /boot-screen\.ts \[inferred\] changed in earlier commits about opstartscherm/);
  assert.deepEqual(c.shown, c.items.slice(0, c.shown.length));
  const off = (await indexRepo(root, path.join(root, "..", path.basename(root) + "-nohist"), { history: "off" })).graph;
  assert.equal(off.history, undefined);
  assert.equal(context(off, "opstartscherm sneller", 800).text, "no matches");
});

test("history: merge keeps commits git no longer shows (shallow clone), git mode does not; no git means no history", async () => {
  const root = await repo([["Eerste versie van het bureaublad", app]]);
  const gp = path.join(root, ".cbtg", "graph.json");
  const first = (await indexRepo(root)).graph;
  const g = JSON.parse(await fs.readFile(gp, "utf8"));
  g.history.push({ id: "aaaaaaaaaaaa", time: 1, words: ["oud"], files: ["src/texts.ts"] }, { id: "bbbbbbbbbbbb", time: 2, words: ["weg"], files: ["src/gone.ts"] });
  await fs.writeFile(gp, JSON.stringify(g));
  const merged = (await indexRepo(root)).graph;
  assert.deepEqual(merged.history!.map((c) => c.id), [first.history![0].id, "aaaaaaaaaaaa"], "kept, newest first; a deleted file's commit is dropped");
  assert.equal((await indexRepo(root, undefined, { history: "git" })).graph.history!.length, 1);
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "cbtg-nogit-"));
  assert.deepEqual(await readGitHistory(plain), []);
  assert.deepEqual(historyForGraph([{ id: "c", time: 1, words: [], files: ["a.ts"] }], { "a.ts": {} as never }), [], "a commit without words is dropped");
});

test("bench --from-git: tasks from history, searched in the state before each commit, worktree removed afterwards", async () => {
  const root = await repo([
    ["Eerste versie van het bureaublad", app],
    ["Opstartscherm: knoppen duidelijker", { "src/boot-screen.ts": "export class BootScreen { wait = 10; }\n" }],
    ["PRW-12 Opstartscherm wacht 5 seconden (#7)", { "src/boot-screen.ts": "export class BootScreen { wait = 5; }\n", "src/new.ts": "export const n = 1;\n" }],
    ["build(deps): bump typescript", { "src/texts.ts": "export const TEXTS = { a: 1 };\n" }],
  ]);
  const tasks = await tasksFromGit(root);
  assert.deepEqual(tasks.map((t) => t.task), ["Opstartscherm wacht 5 seconden", "Opstartscherm: knoppen duidelijker"], "dependency bumps and the root commit are no tasks");
  assert.equal(tasks[0].id, "PR7");
  assert.deepEqual(tasks[0].relevant, ["src/boot-screen.ts"], "an added file is not ground truth");
  const rows = await runGitBenchmark(root, { maxFiles: 3 });
  assert.equal(rows.length, 2);
  const pr7 = rows.find((r) => r.id === "PR7")!;
  assert.equal(pr7.graph.firstHit, 1, "found through the earlier commit about the same screen");
  assert.ok(!pr7.graph.files.includes("src/new.ts"), "the file the commit adds does not exist yet");
  const without = await runGitBenchmark(root, { maxFiles: 3, history: false });
  assert.equal(without.find((r) => r.id === "PR7")!.graph.firstHit, 0);
  assert.match(renderReport(rows), /At least one relevant file among the opened files: grep baseline \d+%, graph context \d+%/);
  const { stdout } = await run("git", ["-C", root, "worktree", "list"]);
  assert.equal(stdout.trim().split("\n").length, 1, "temporary worktree removed");
});

test("bench: task titles lose ticket prefixes and a trailing PR number", () => {
  assert.equal(taskTitle("PRTF - Sitemap.xml (#117)"), "Sitemap.xml");
  assert.equal(taskTitle("PRW-104 Graph in git"), "Graph in git");
  assert.equal(taskTitle("Snake: tabwissel"), "Snake: tabwissel");
});

test("cli: bench --from-git prints the report, also with --no-history", async () => {
  const root = await repo([
    ["Eerste versie van het bureaublad", app],
    ["Opstartscherm: knoppen duidelijker", { "src/boot-screen.ts": "export class BootScreen { wait = 10; }\n" }],
    ["Opstartscherm wacht 5 seconden", { "src/boot-screen.ts": "export class BootScreen { wait = 5; }\n" }],
  ]);
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "cli.js");
  for (const extra of [[], ["--no-history"]]) {
    const { stdout } = await run(process.execPath, [cli, "bench", "--from-git", "--root", root, "--tasks", "5", ...extra]);
    assert.match(stdout, /^Benchmark: 2 task\(s\)/);
    assert.match(stdout, /Mean reciprocal rank/);
  }
});
