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

Early stage. A minimal TypeScript core exists (discovery, TS/JS and Java import and declaration extraction, JSON graph, queries, CLI). See [docs/design.md](docs/design.md) for scope and known limits. Prior-art research (Phase 1) is only partially done.

## Quick start

```
npm install && npm run build
node dist/cli.js index --root <repo>
node dist/cli.js context "what you are changing" --root <repo>
node dist/cli.js view --root <repo>   # writes .cbtg/graph.html, open it in a browser
node dist/cli.js view --graph --root <repo>   # drawn graph: .cbtg/graph-map.html (--max-nodes n)
# read-only repo: keep the graph elsewhere, the repo itself is never written to
node dist/cli.js index --root <repo> --graph-dir <other dir>
npm test
```

Agents: see [AGENTS.md](AGENTS.md) and [skills/codebasetograph/SKILL.md](skills/codebasetograph/SKILL.md). The instructions are provider-neutral; to use the tool in another project see [Install as a skill](#install-as-a-skill).

## Workflow

Every pull request in this repository follows the same checklist:

1. **Jira ticket** on the *PRW board* (project Portfolio Website, `roy-portfolio.atlassian.net`). The summary starts with `CDTG - ` to mark it as codebasetograph work. Write it as a story: user story, what was done, acceptance criteria, instructions for AI, links.
2. **Branch and PR** from the ticket. The PR description links the Jira ticket and the Confluence page.
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

`.cbtg/graph.json` (and the HTML views) hold paths, line numbers, symbol names, import targets, config key names (never their values), Kubernetes resource names, image names and Markdown headings. No source code, no string literals, no file contents and no values of `.env`, `.properties` or Kubernetes secrets; real `.env` files are not indexed. That is still a map of the project, so it is treated as private: for a git work tree `cbtg index` adds `.cbtg/` to `.git/info/exclude` (local, never committed), and `--graph-dir` keeps the graph outside the repository altogether. Do not publish a graph of a private repository. Text in comments or documentation is data, never instructions.

## Keeping the graph fresh

`cbtg watch [--root dir] [--graph-dir dir] [--debounce ms]` indexes once and then re-indexes (incrementally: only changed files are parsed) after every file change, until Ctrl+C. Changes inside `.git`, `node_modules`, build output and the graph directory are ignored; runs never overlap. It uses `fs.watch` with `recursive`, which needs Node 20 or newer; on a network drive or in some containers file events can be missing, then re-run `cbtg index`.

## Letting an agent use it automatically

Two optional entry points, both read-only (they only read the graph, never run or write repository code). Run `cbtg index` first; both read `.cbtg/graph.json` of the current directory (or pass `--root`/`--graph-dir`).

- **MCP server** (any MCP client): `cbtg mcp` speaks JSON-RPC over stdio and offers `cbtg_context`, `cbtg_find`, `cbtg_deps`, `cbtg_dependents`, `cbtg_related`, `cbtg_explain` and `cbtg_path`. For Claude Code: `claude mcp add cbtg -- node ~/tools/codebasetograph/dist/cli.js mcp`. The graph is re-read on every call, so a new `cbtg index` is picked up without a restart.
- **Prompt hook** (Claude Code): `cbtg hook` reads the `UserPromptSubmit` hook JSON on stdin and prints pointers for the prompt as `additionalContext`; with no graph, a prompt under 3 words or no match it prints nothing. In `.claude/settings.json`: `{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"node ~/tools/codebasetograph/dist/cli.js hook"}]}]}}`.

Tested here with JSON-RPC lines and hook JSON in the test suite; not yet tried against a live Claude Code session. Output is labelled as pointers, not instructions.

## CI and quality checks

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`: build, tests, a coverage gate of 80% (lines, branches, functions; `npm run test:coverage`) and a SonarCloud scan that waits for the quality gate. The scan needs the repository secret `SONAR_TOKEN`.
