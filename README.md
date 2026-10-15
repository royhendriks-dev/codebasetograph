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

Early stage. A minimal TypeScript core exists (discovery, TS/JS and Java import and declaration extraction, CI/compose/Kubernetes YAML references, JSON graph, queries, CLI). See [docs/design.md](docs/design.md) for scope and known limits. Graphify research (Phase 1) is only partially done.

## Quick start

```
npm install && npm run build
node dist/cli.js index --root <repo>
node dist/cli.js context "what you are changing" --root <repo>
node dist/cli.js view --root <repo>   # writes .cbtg/graph.html, open it in a browser
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

## CI and quality checks

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`: build, tests, a coverage gate of 80% (lines, branches, functions; `npm run test:coverage`) and a SonarCloud scan that waits for the quality gate. The scan needs the repository secret `SONAR_TOKEN`.
