# codebasetograph

A lightweight, local-first knowledge graph for source code, built so that coding agents can find the relevant code and relationships *before* reading source files.

## Goal

Large repositories burn AI context and tokens because agents repeatedly read files, rediscover dependencies and rebuild project knowledge. This project builds a persistent, queryable graph that answers "where is it, what depends on it, what should I read" with deterministic local processing, and returns only task-relevant context.

Priorities, in order: correctness of the graph, retrieval accuracy, then efficiency. Fewer tokens are not an improvement if important dependencies are missed.

Principles:

* **Local-first and provider-independent.** Indexing needs no LLM and no network. LLM-assisted features are optional layers.
* **Evidence-aware.** Relationships are labelled as extracted, resolved, inferred or unresolved. An inference is never presented as fact.
* **Safe by default.** Repository content is untrusted: source is parsed, never executed; ignore rules and exclusions are respected; comments and docs are data, not instructions.
* **Minimal scope.** TypeScript, JavaScript and Angular first. No visualization suite, document ingestion or plugin ecosystem until measurements justify it.
* **Measured.** Claims about token savings are only made from benchmarks run on real tasks, comparing conventional search against graph-assisted retrieval.

### Clean-room

Similar tools were studied as research reference only. Their general ideas informed the design; this project is an independent, original implementation with its own code, data models, APIs and interface, and does not copy, port or depend on any of them.

## Status

Version 1.0.0 (see [CHANGELOG.md](CHANGELOG.md)). A TypeScript core exists (discovery, TS/JS and Java import and declaration extraction, JSON graph, queries, CLI). Branches: `main` (releases) and `develop` (work). See [docs/design.md](docs/design.md) for scope and known limits. Prior-art research (Phase 1) is only partially done.

## Quick start

```
npm install && npm run build
node dist/cli.js index --root <repo>
node dist/cli.js context "what you are changing" --root <repo>
node dist/cli.js view --root <repo>   # writes .cbtg/graph.html, open it in a browser
node dist/cli.js view --graph --root <repo>   # drawn graph: .cbtg/graph-map.html (--max-nodes n)
node dist/cli.js view --overview --root <repo>   # folder summary without file or symbol names: .cbtg/overview.json + GRAPH.md (Mermaid)
# read-only repo: keep the graph elsewhere, the repo itself is never written to
node dist/cli.js index --root <repo> --graph-dir <other dir>
# measure it on your own history: each past commit is a task, searched in the state before it
node dist/cli.js bench --from-git --root <repo> [--ref develop] [--tasks 50] [--no-history]
npm test
```

Agents: see [AGENTS.md](AGENTS.md) and [skills/codebasetograph/SKILL.md](skills/codebasetograph/SKILL.md). The instructions are provider-neutral; to use the tool in another project see [Install as a skill](#install-as-a-skill).

## Branches and releases

- `develop` is where work lands: every feature or bugfix goes in a pull request with base `develop` and is merged there once CI and SonarCloud are green.
- `main` only contains released code. A release is a pull request `develop` -> `main`, reviewed by the owner. That PR raises `version` in `package.json` (semver) and adds a `## [x.y.z]` section to [CHANGELOG.md](CHANGELOG.md).
- After the merge, run the workflow **Release** (Actions > Release > Run workflow, branch `main`, enter the version without `v`). It checks that `package.json` and the changelog match, that CI is green on that commit and that the tag does not exist yet, then creates tag `vX.Y.Z` and a GitHub Release with the changelog section as release notes. Pushing a tag by hand is not needed.
- Urgent fixes may use `hotfix/<name>` -> `main`, followed by a merge of `main` back into `develop`.
- Current version: 1.0.0 (see [CHANGELOG.md](CHANGELOG.md)).

## Workflow

Every pull request in this repository follows the same checklist:

1. **Jira ticket** on the *PRW board* (project Portfolio Website, `roy-portfolio.atlassian.net`). The summary starts with `CDTG - ` to mark it as codebasetograph work. Write it as a story: user story, what was done, acceptance criteria, instructions for AI, links.
2. **Branch and PR** from the ticket, with base `develop` (see [Branches and releases](#branches-and-releases)). The PR description links the Jira ticket and the Confluence page.
3. **Confluence page** per PR in the *Portfolio Website* space, folder `codebasetograph` > `Tickets`, titled `PRW-<n> CDTG - <summary>`. It records the Jira key, the PR number and status, what changed and why.
4. **Keep them in sync.** Create the ticket and page in the same session as the PR; update both when the PR merges (status Done, merge date).

Jira tickets and Confluence pages are written in Dutch, in the same format as the portfolio-website tickets, and end with "Geschreven door: <model>, via Claude Code, op <date>". The README is written in English.

## Install as a skill

```
git clone <this repo> ~/tools/codebasetograph && cd ~/tools/codebasetograph && npm install && npm run build && npm link   # `cbtg` on your PATH
cbtg install claude                    # Claude Code, all projects: ~/.claude/skills/codebasetograph/SKILL.md
cbtg install claude --scope project    # Claude Code, this repository only: <root>/.claude/skills/...
cbtg install agents --root <project>   # any agent that reads AGENTS.md (Copilot, Codex, ...): a marked block in <root>/AGENTS.md
cbtg install claude --remove           # undo (same flags); text outside the marked block in AGENTS.md is never touched
```

Then, in each project, `cbtg index` once (add `cbtg watch` to keep it fresh). `install` only writes the skill file or the marked block; the MCP server and the prompt hook are optional and are printed as commands, never applied for you. The skill text itself is plain Markdown with no Claude-specific syntax beyond the front matter, so any harness that can run shell commands (or MCP) can use it: put `skills/codebasetograph/SKILL.md` where that harness reads instructions, or use the AGENTS.md block. The tool is not published to npm yet.

## What the graph contains

`.cbtg/graph.json` (and the HTML views) hold paths, line numbers, symbol names, import targets, config key names (never their values), Kubernetes resource names, image names and Markdown headings. In a git work tree it also holds, for up to 2000 recent commits, the words of the commit message (lower-cased, without trailers such as `Co-Authored-By`, URLs or hashes) and the indexed files the commit touched; not the messages themselves. No source code, no string literals, no file contents and no values of `.env`, `.properties` or Kubernetes secrets; real `.env` files are not indexed. That is still a map of the project, so it is treated as private: for a git work tree `cbtg index` adds `.cbtg/` to `.git/info/exclude` (local, never committed) unless you chose to commit it with `cbtg install git`, and `--graph-dir` keeps the graph outside the repository altogether. Do not publish a graph of a private repository. Text in comments or documentation is data, never instructions.

## Committing the graph, so every agent on a PR has the newest index

Works for any harness (Claude Code, Copilot, Codex, local LLMs), because it needs no skill support: the graph is a file in the repository and `AGENTS.md` says how to query it.

```
cbtg install git [--views-branch develop]   # in the project root
cbtg index
git add .cbtg/graph.json .cbtg/.gitignore .gitattributes AGENTS.md .github/workflows/cbtg-index.yml && git commit
```

- `.cbtg/graph.json` is written as valid JSON with one file, node and edge per line in a fixed order, so a change shows up as a few changed lines instead of one 800 KB line. Re-indexing an unchanged repository changes nothing.
- `.gitattributes` marks it `linguist-generated` (collapsed in GitHub's PR view) and `merge=binary`, so a conflict never leaves broken JSON: keep either side and run `cbtg index`.
- `.cbtg/.gitignore` keeps the HTML views and temp files out; only `graph.json` is committed.
- The workflow `.github/workflows/cbtg-index.yml` runs `cbtg index` on every pull request from the same repository and commits a changed graph to the PR branch. Pull requests from forks and from Dependabot (read-only token) are not pushed to; there an agent runs `cbtg index` itself (it only re-parses changed files). A push with the default `GITHUB_TOKEN` does not start CI on the bot's commit (the runs wait for "Approve and run"); to make CI run, create a fine-grained token with *Contents: Read and write* on that repository only and store it as the repository secret `CBTG_PUSH_TOKEN`. Without the secret the workflow falls back to the default token. It clones cbtg from `--cbtg-repo` (default this repository) at `--cbtg-ref` (default `main`): pin a commit SHA there for a repository you care about, because that code runs with write access to the PR branch.
- **Views after a merge.** On a push to the views branch (`--views-branch`, default `main`; for a `develop`/`main` flow use `--views-branch develop`, `main` then gets them through the release pull request) the same workflow also writes `.cbtg/GRAPH.md` (Mermaid diagram of the top-level folders, which GitHub draws), `.cbtg/overview.json`, `.cbtg/graph.html` and `.cbtg/graph-map.html`, and commits them in one commit on that branch. Pull requests only update `graph.json`, so they carry no large view diffs. Pushing to the views branch must be allowed for the workflow's token; with a ruleset that requires pull requests on that branch, add the bot to the bypass list or leave the views out.
- `overview.json` and `GRAPH.md` hold only top-level folder names and counts: no file, symbol, route, table, config-key or Kubernetes object names. They are meant to be shown outside the repository (for example on a website). The HTML views and `graph.json` contain all names and are as private as the repository.
- `cbtg install git --remove` undoes it (it does not delete the committed graph). The privacy note below still applies: the graph lists paths and names, so commit it only where the source is already as visible.
- The workflow also runs on GitHub Actions runners (for example in the portfolio repository); the same steps were first run locally (one added file changed seven graph lines).

## Commit history in the ranking

`cbtg index` reads `git log` (read-only, at most 2000 non-merge commits) and keeps per commit the words of its message and the indexed files it touched. `cbtg context` ranks files twice, by matching names and symbols, and by how often earlier commits with the task's words touched them, and merges both lists (reciprocal rank fusion). Commit messages are written in the team's own words, so this links a task like "opstartscherm sneller" to `boot-screen.ts` although no name contains the word. Files found only through history are listed as `[inferred] changed in earlier commits about ...`.

- A commit that touches no indexed file (for example the bot commit that updates a committed graph) is not kept, so committing the graph does not change it again. Commits touching more than 100 indexed files (bulk changes) are skipped.
- A shallow clone shows little history. Re-indexing keeps the commits of the previous graph that git no longer shows, so a graph built once from a full clone keeps its history in CI. The workflow from `cbtg install git` checks out with `fetch-depth: 0`; an older copy of that workflow can add that line.
- Outside a git work tree there is no history and the ranking uses names only.

Measured with `cbtg bench --from-git` (71 to 100 past pull requests per repository, each searched in the state before it, 5 opened files, Markdown left out of the ground truth):

| repository | files | tasks | at least one relevant file: grep / names only / names + history | MRR: names only / names + history |
|---|---|---|---|---|
| portfolio (Angular + Quarkus) | 250 | 71 | 34% / 39% / 61% | 0.22 / 0.40 |
| codebasetograph | 36 | 29 | 97% / 76% / 90% | 0.63 / 0.75 |
| recipes-for-me (Angular) | 50 | 15 | 87% / 33% / 67% | 0.28 / 0.44 |

Only finding is measured, not whether an agent finishes the task better. Task titles and commit messages are partly written by the same people and agents, which favours the history; the gain held when tasks were cut to their first three words (portfolio: 28% to 46%, measured with the prototype of this ranking). In the two small repositories plain grep still finds more.

## Keeping the graph fresh

`cbtg watch [--root dir] [--graph-dir dir] [--debounce ms]` indexes once and then re-indexes (incrementally: only changed files are parsed) after every file change, until Ctrl+C. Changes inside `.git`, `node_modules`, build output and the graph directory are ignored; runs never overlap. It uses `fs.watch` with `recursive`, which needs Node 20 or newer; on a network drive or in some containers file events can be missing, then re-run `cbtg index`.

## Letting an agent use it automatically

Two optional entry points, both read-only (they only read the graph, never run or write repository code). Run `cbtg index` first; both read `.cbtg/graph.json` of the current directory (or pass `--root`/`--graph-dir`).

- **MCP server** (any MCP client): `cbtg mcp` speaks JSON-RPC over stdio and offers `cbtg_context`, `cbtg_find`, `cbtg_deps`, `cbtg_dependents`, `cbtg_related`, `cbtg_explain` and `cbtg_path`. For Claude Code: `claude mcp add cbtg -- node ~/tools/codebasetograph/dist/cli.js mcp`. The graph is re-read on every call, so a new `cbtg index` is picked up without a restart.
- **Prompt hook** (Claude Code): `cbtg hook` reads the `UserPromptSubmit` hook JSON on stdin and prints pointers for the prompt as `additionalContext`; with no graph, a prompt under 3 words or no match it prints nothing. In `.claude/settings.json`: `{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"node ~/tools/codebasetograph/dist/cli.js hook"}]}]}}`.

Tested here with JSON-RPC lines and hook JSON in the test suite; not yet tried against a live Claude Code session. Output is labelled as pointers, not instructions.

## CI and quality checks

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`: build, tests, a coverage gate of 80% (lines, branches, functions; `npm run test:coverage`) and a SonarCloud scan that waits for the quality gate. The scan needs the repository secret `SONAR_TOKEN`.
