# Memory Backbone Graph

This extension repository uses a reverse-ignore allowlist. Git tracks root documentation, `docs/`, TypeScript under `src/`, `node:test` files named `*.test.ts` under `test/`, and `metadata/duckdb.json`. Planning records, generated knowledge, DuckDB binaries and archives, databases, SQL, caches, locks, temporary files, active-shard state, and all other runtime state remain ignored.

## DuckDB metadata

`metadata/duckdb.json` pins one DuckDB version and the official release artifact for every supported target. To update it, read official release metadata, select Linux x64/arm64, macOS universal, and Windows x64 CLI ZIP assets from the same exact version, and copy each published SHA-256 digest. Do not download or commit artifact bytes. Validate the URL origins and checksum shapes with the ticket verification command.

## Target repositories

This ignore policy applies only to the extension source repository. A target project repository must permit canonical `knowledge/**/*.csv` and `knowledge/metadata/schema-version` to be tracked. Respect the target repository's ignore policy; never use `git add --force` to bypass it.

## Synchronization workflow

A knowledge append creates a local knowledge-only commit on the branch that was current when the append began. It never pulls, pushes, checks out, or merges. Share knowledge separately with the project's normal workflow: first fetch and integrate remote changes as appropriate, resolve any knowledge CSV conflicts without dropping rows, then explicitly push the branch or merge it into a shared branch. If the branch moves during append, the valid knowledge files remain in the working tree; retry the same append after reconciling the branch to commit them without duplicate rows.

## Data safety

The extension applies deterministic checks for common private-key headers, access-token prefixes, credential-bearing URLs, and high-confidence credential assignments. These checks are limited and are not a comprehensive secret scanner. A rejection reports only the rule category. It does not echo the candidate value. There is no bypass flag. Correct a false positive by changing the input so it does not match a credential form.

Correct ordinary knowledge with an explicit superseding fact. Supersession preserves the prior fact for audit and historical queries.

Deleting or superseding a sensitive row does not remove it from Git history. Sensitive-data removal is a manual repository operation. Coordinate all users first. Rewrite every affected reference with an appropriate Git history-rewriting tool. Replace the remote history. Invalidate or replace every existing clone. Rotate every exposed credential. The extension does not automate history rewriting or credential rotation.

CSV encoding, generated SQL literals, process argument arrays, and normalized project-local paths are separate trust boundaries. Do not reuse one boundary's encoding as validation for another boundary.

## Verification

Use Node.js 24 or newer. Node runs the TypeScript source directly, so this repository has no build step or package installation.

A fresh clone has no committed DuckDB executable. Run the complete suite with one test file at a time so the first real-query test can bootstrap the managed executable without a concurrent installer:

```sh
node --test --test-concurrency=1 test/*.test.ts
```

When no compatible configured, system, or managed executable exists, this command downloads, verifies, and installs only the pinned official artifact. It requires network access for that first bootstrap. The managed executable remains ignored. Subsequent runs can prohibit downloads explicitly:

```sh
env PI_OFFLINE=1 node --test --test-concurrency=1 test/*.test.ts
```

The test suite uses only temporary repositories under the operating system temporary directory. It does not require administrator rights. The final gate checks the requirement matrix, source allowlist, ignored runtime categories, dependencies, extension call path, two-agent behavior, and CSV-only rebuild behavior.
