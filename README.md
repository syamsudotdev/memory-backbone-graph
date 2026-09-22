# Memory Backbone Graph

A project-local knowledge store for Pi and Claude Code agents.

Memory Backbone Graph stores durable knowledge as Git-tracked CSV files and queries it with DuckDB. It provides graph-shaped facts, provenance, history, and per-agent write isolation without a database server or an additional AI call.

## Features

- Native Pi tools: `knowledge_append`, `knowledge_search`, and `knowledge_get`
- Claude Code plugin with a lifecycle hook and validated JSON command-line adapter
- Git-tracked CSV files as the source of truth
- Structured `subject → predicate → object` facts
- Episode and session provenance
- Append-only supersession history
- Separate monthly shards for each agent
- Local knowledge-only commits
- DuckDB discovery and verified automatic bootstrap
- Deterministic validation and basic secret detection
- No package installation or build step

## Requirements

- Node.js 24 or newer
- Git
- Pi or Claude Code
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

Run Pi or Claude Code inside a Git repository. The integration writes canonical data to that repository's `knowledge/` directory.

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
      "object": "tool:duckdb",
      "confidence": 1
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

Set `history` to `true` to include superseded facts.

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
├── facts/<agent>/<year-month>/<sequence>.csv
└── metadata/schema-version
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
