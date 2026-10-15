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

[Graphify](https://github.com/Graphify-Labs/graphify) is a research reference only. Its ideas are studied; its code, data models, APIs and interface are not copied, ported or used as a dependency.

## Status

Early stage. A minimal TypeScript core exists (discovery, TS/JS and Java import and declaration extraction, JSON graph, queries, CLI). See [docs/design.md](docs/design.md) for scope and known limits. Graphify research (Phase 1) is only partially done.

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

Agents: see [AGENTS.md](AGENTS.md) and [skills/codebasetograph/SKILL.md](skills/codebasetograph/SKILL.md). The instructions are provider-neutral.

## Workflow

Every pull request in this repository follows the same checklist:

1. **Jira ticket** on the *PRW board* (project Portfolio Website, `roy-portfolio.atlassian.net`). The summary starts with `CDTG - ` to mark it as codebasetograph work. Write it as a story: user story, what was done, acceptance criteria, instructions for AI, links.
2. **Branch and PR** from the ticket. The PR description links the Jira ticket and the Confluence page.
3. **Confluence page** per PR in the *Portfolio Website* space, folder `codebasetograph` > `Tickets`, titled `PRW-<n> CDTG - <summary>`. It records the Jira key, the PR number and status, what changed and why.
4. **Keep them in sync.** Create the ticket and page in the same session as the PR; update both when the PR merges (status Done, merge date).

Jira tickets and Confluence pages are written in Dutch, in the same format as the portfolio-website tickets, and end with "Geschreven door: <model>, via Claude Code, op <date>". The README is written in English.

## Letting an agent use it automatically

Two optional entry points, both read-only (they only read the graph, never run or write repository code). Run `cbtg index` first; both read `.cbtg/graph.json` of the current directory (or pass `--root`/`--graph-dir`).

- **MCP server** (any MCP client): `cbtg mcp` speaks JSON-RPC over stdio and offers `cbtg_context`, `cbtg_find`, `cbtg_deps`, `cbtg_dependents`, `cbtg_related`, `cbtg_explain` and `cbtg_path`. For Claude Code: `claude mcp add cbtg -- node ~/tools/codebasetograph/dist/cli.js mcp`. The graph is re-read on every call, so a new `cbtg index` is picked up without a restart.
- **Prompt hook** (Claude Code): `cbtg hook` reads the `UserPromptSubmit` hook JSON on stdin and prints pointers for the prompt as `additionalContext`; with no graph, a prompt under 3 words or no match it prints nothing. In `.claude/settings.json`: `{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"node ~/tools/codebasetograph/dist/cli.js hook"}]}]}}`.

Tested here with JSON-RPC lines and hook JSON in the test suite; not yet tried against a live Claude Code session. Output is labelled as pointers, not instructions.

## CI and quality checks

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`: build, tests, a coverage gate of 80% (lines, branches, functions; `npm run test:coverage`) and a SonarCloud scan that waits for the quality gate. The scan needs the repository secret `SONAR_TOKEN`.
