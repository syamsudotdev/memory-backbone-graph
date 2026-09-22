# Memory Backbone Graph

Memory Backbone Graph gives coding agents durable project memory that survives sessions, stays reviewable in Git, and needs no database server or additional AI call.

Knowledge that matters—decisions, constraints, preferences, and lessons—is stored as structured facts. Ownership remains with the project because canonical memory lives in Git. Recall brings back relevant facts and their provenance when prior context can affect a decision. Users decide what enters memory: only explicit or verified knowledge, never automatic transcripts. Provenance connects each fact to its source episode, agent, and session. Storage stays simple: reviewable CSV files hold canonical data, while local DuckDB handles queries. Integrations give Pi, Claude Code, and OpenCode the same recall and record workflow.

## Features

- Native Pi tools: `knowledge_append`, `knowledge_search`, and `knowledge_get`
- Claude Code plugin with a lifecycle hook and validated JSON command-line adapter
- OpenCode V2 plugin with native typed tools and context guidance
- Git-tracked CSV files as the source of truth
- Structured `subject → predicate → object` facts
- Episode and session provenance
- Append-only supersession history
- Separate monthly shards for each agent
- Local knowledge-only commits
- DuckDB discovery and verified automatic bootstrap
- Deterministic validation and basic secret detection
- No build step or database server

## Requirements

- Node.js 24 or newer
- Git
- Pi, Claude Code, or OpenCode V2
- Network access for the first DuckDB bootstrap, unless a compatible DuckDB executable is already available

## Installation

### Pi

Install the extension and skill as a Pi package:

```sh
pi install git:github.com/syamsudotdev/memory-backbone-graph
```

Add `-l` to install it for only the current project. To try it without changing settings, run:

```sh
pi -e git:github.com/syamsudotdev/memory-backbone-graph
```

The extension provides the tools. The skill guides agents to recall relevant project knowledge and record durable facts without storing temporary task state.

### Claude Code

Add this repository as a marketplace, then install the plugin:

```text
/plugin marketplace add syamsudotdev/memory-backbone-graph
/plugin install memory-backbone@memory-backbone
```

To test a local checkout instead:

```sh
claude --plugin-dir /absolute/path/to/memory-backbone-graph
```

The `UserPromptSubmit` hook supplies the current Claude session ID and JSON adapter instructions without adding another model turn.

### OpenCode V2

Install the package directly from GitHub:

```sh
opencode plugin add github:syamsudotdev/memory-backbone-graph
```

The plugin registers native typed knowledge tools and adds recall and capture guidance through OpenCode's model-context hook.

Run the selected agent inside a Git repository. The integration writes canonical data to that repository's `knowledge/` directory.

## Usage

### Append knowledge

```json
{
  "kind": "decision",
  "summary": "Use DuckDB for knowledge queries",
  "source": "conversation",
  "facts": [
    {
      "subject": "project:example",
      "predicate": "uses",
      "object": "tool:duckdb"
    }
  ]
}
```

### Search knowledge

```json
{
  "terms": ["DuckDB"],
  "subject": "project:example",
  "limit": 20
}
```

Set `history` to `true` to include superseded facts. Search responses include `returned`, `total`, and `hasMore`; `total` counts every valid matching fact before the limit. `partial` separately reports whether corrupt shards were omitted.

### Get one record

```json
{
  "id": "fact_00000000-0000-4000-8000-000000000000"
}
```

The ID can identify a fact, episode, or entity.

## Storage model

Canonical knowledge uses this layout:

```text
knowledge/
├── entities/<agent>/<year-month>/<sequence>.csv
├── episodes/<agent>/<year-month>/<sequence>.csv
└── facts/<agent>/<year-month>/<sequence>.csv
```

Each agent writes to its own shard. The extension derives the agent identity from the operating-system username and hostname. DuckDB creates temporary query views from the CSV files; database files are not canonical data.

An append creates a local knowledge-only commit on the current branch. It does not pull, push, merge, or change branches. Use your normal Git workflow to share those commits.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PI_KNOWLEDGE_DUCKDB_PATH` | Use a specific compatible DuckDB executable. |
| `PI_KNOWLEDGE_SHARD_ROW_LIMIT` | Set the maximum rows per shard. The default is `10000`. |
| `PI_OFFLINE=1` | Disable DuckDB downloads. |

If no configured, system, or managed DuckDB executable is compatible, the first query downloads and verifies the pinned official artifact. Managed binaries and other runtime files remain ignored by Git.

## Data safety

The extension rejects common private-key headers, token prefixes, credential-bearing URLs, and high-confidence credential assignments. This check is not a complete secret scanner.

Correct ordinary knowledge by appending a fact that supersedes the old fact. This keeps the earlier record available for history and audit.

Deleting or superseding sensitive data does not remove it from Git history. If sensitive data enters the repository, rotate the exposed credential and use a Git history-rewriting tool to remove every affected reference. Coordinate the rewrite with all repository users and replace existing clones.

## Development

The project uses Node's built-in TypeScript support and test runner. It has no build step.

Run the complete suite serially so the first query can bootstrap DuckDB safely:

```sh
npm test
```

After the managed executable exists, verify offline operation with:

```sh
env PI_OFFLINE=1 node --test --test-concurrency=1 test/*.test.ts
```

Tests use temporary Git repositories and do not require administrator access.
