# MVP Requirement Matrix

All commands run from the repository root. Automated evidence uses `node --test test/*.test.ts`. The final gate also checks that this matrix contains every required identifier.

## Functional requirements

| Requirement | Implementation | Direct verification |
|---|---|---|
| FR-001 | `.pi/extensions/knowledge.ts`, `src/pi-tools.ts` | `test/pi-tools.test.ts`: exact append registration and execution |
| FR-002 | `src/append.ts`, `src/pi-tools.ts` | `test/append.test.ts`; strict schema checks in `test/pi-tools.test.ts` |
| FR-003 | `src/append.ts`, `src/git.ts` | atomic append, crash recovery, and isolated commit tests |
| FR-004 | `src/append.ts` | global duplicate and real tool duplicate tests |
| FR-005 | `src/append.ts`, `src/query.ts` | immutable CSV rows and history tests |
| FR-006 | `src/append.ts`, `src/query.ts` | supersession scope, chain, current/history tests |
| FR-007 | `.pi/extensions/knowledge.ts`, `src/pi-tools.ts` | exact search registration and execution |
| FR-008 | `src/query.ts`, `src/pi-tools.ts` | every structured filter and schema-bound malformed input tests |
| FR-009 | `src/query.ts` | current-facts query test |
| FR-010 | `src/query.ts` | three-link history query test |
| FR-011 | `src/query.ts` | provenance and episode retrieval tests |
| FR-012 | `src/pi-tools.ts` | structured rows returned for Pi interpretation |
| FR-013 | `src/query.ts` | real DuckDB fixed-query integration tests |
| FR-014 | `src/query.ts`, `src/pi-tools.ts` | quoted, wildcard, SQL-like input and no arbitrary-SQL hook tests |
| FR-015 | `src/query.ts` | logical results rebuilt directly from CSV shards |
| FR-016 | `src/query.ts` | temporary `entities`, `episodes`, `facts`, `current_facts`, and `fact_history` views tested |
| FR-017 | `src/duckdb.ts` | real managed CLI query plus discovery tests |
| FR-018 | `src/duckdb.ts` | configured, PATH, managed precedence tests |
| FR-019 | `src/duckdb.ts`, `metadata/duckdb.json` | exact compatible/malformed version tests |
| FR-020 | `src/duckdb.ts` | fixture download/install flow test |
| FR-021 | `src/duckdb.ts` | managed path and atomic install tests |
| FR-022 | `src/duckdb.ts`, `metadata/duckdb.json` | checksum and archive-safety tests |
| FR-023 | `src/duckdb.ts` | discovery/bootstrap order tests |
| FR-024 | `src/duckdb.ts` | offline managed reuse test |
| FR-025 | `src/git.ts` | no pull/push plus branch-sharing two-agent scenario |
| FR-026 | `src/records.ts` | distinct normalized per-agent shard paths and two-agent scenario |
| FR-027 | `src/git.ts` | commit trailers, temporary index, and guarded ref tests |
| FR-028 | `.pi/extensions/knowledge.ts` | `docs/manual-verification.md`: Pi RPC load and exact tool-list evidence |
| FR-029 | `src/pi-tools.ts`, `src/query.ts` | stable-ID get integration test |
| FR-030 | `.pi/extensions/knowledge.ts` | dependency-path test shows no automatic extraction |
| FR-031 | Excluded optional behavior | dependency-path test shows no extraction hook |
| FR-032 | `src/pi-tools.ts` | dependency-path test; `docs/manual-verification.md` zero-message RPC evidence |
| FR-033 | `src/pi-tools.ts` | dependency-path test; `docs/manual-verification.md` zero-message RPC evidence |
| FR-034 | Excluded optional behavior | no embedding or semantic-search dependency check |
| FR-035 | `src/git.ts`, `src/pi-tools.ts` | non-Git no-write setup error test |
| FR-036 | `src/records.ts`, `src/append.ts` | invalid records/requests fail before canonical writes |
| FR-037 | `src/query.ts` | corrupt shard partial-result test |
| FR-038 | `src/records.ts`, `src/query.ts` | global duplicate-ID omission and UUID collision tests |
| FR-039 | `src/errors.ts`, `src/query.ts`, `src/pi-tools.ts` | real malformed DuckDB dependency response preserves CSV and permits append |

## Non-functional requirements

| Requirement | Implementation | Direct verification |
|---|---|---|
| NFR-001 | Node.js built-ins and direct TypeScript | final dependency/allowlist gate |
| NFR-002 | `src/records.ts`, `src/duckdb.ts` | Windows/macOS/Linux path and platform mapping tests |
| NFR-003 | canonical CSV plus Git trailers | CSV byte, history, provenance, and commit metadata tests |
| NFR-004 | no build or dependency manifest | final dependency gate |
| NFR-005 | Git-root resolution per operation | nested-root and non-Git tests |
| NFR-006 | additive CSV readers and temporary DuckDB views | default-column and runtime-deletion rebuild tests |
| NFR-007 | ignored managed executable | final tracked-file and ignore gate |

## Fixed decisions

| Decision | Implementation and verification |
|---|---|
| D-001 | Direct `.ts` Pi load; manual RPC tool list |
| D-002 | Built-ins, Pi TypeBox, DuckDB CLI, and `node:test`; final dependency gate |
| D-003 | Static dependency test and `docs/manual-verification.md` zero-message RPC evidence |
| D-004 | Per-call Git-root tests |
| D-005 | Current-branch commits merged from two independent agent branches |
| D-006 | Multi-file manifest crash tests |
| D-007 | Missing-entity creation test |
| D-008 | Global duplicate tests |
| D-009 | Supersession scope tests |
| D-010 | Additive-default reader tests |
| D-011 | Temporary-index isolation tests |
| D-012 | No remote mutation tests |
| D-013 | Concurrent writer and lock tests |
| D-014 | Active-project root tests |
| D-015 | Deterministic secret positive/near-match tests |
| D-016 | Five supported DuckDB target tests |
| D-017 | Non-Git no-write tests |
| D-018 | Current/history supersession-chain tests |
| D-019 | `README.md` manual history-removal procedure |
| D-020 | CSV rebuild test and forbidden `.duckdb` gate |
| D-021 | Monthly path and row-rotation tests |
| D-022 | Cross-platform identity normalization and two-agent test |
| D-023 | Structured schema and fixed SQL tests |
| D-024 | Typed DuckDB failure preserves canonical data and allows append |
| D-025 | Runtime executable ignored and tracked-file gate |
| D-026 | ZIP traversal/link/encryption/ZIP64/size/format tests |
| D-027 | Temporary index and guarded reference update tests |

## Ticket acceptance records

| Ticket | Result |
|---|---|
| TICKET-001 | Reverse-ignore boundary and pinned metadata checks pass |
| TICKET-002 | Canonical record and CSV tests pass |
| TICKET-003 | Atomic append, recovery, lock, and rotation tests pass |
| TICKET-004 | Git isolation, concurrency, and retry tests pass |
| TICKET-005 | Real DuckDB structured query and partial-result tests pass |
| TICKET-006 | Discovery, bootstrap, checksum, archive, offline, and platform tests pass |
| TICKET-007 | Pi schema, registration, domain error, read-only, and manual load checks pass |
| TICKET-008 | Bounds, controls, secret classification, redaction, and no-write tests pass |
| TICKET-009 | Requirement matrix, two-agent scenario, and final gate pass |

## MVP acceptance criteria

| Criterion | Passing evidence |
|---|---|
| MVP-01 | Two distinct agents append to one temporary Git repository |
| MVP-02 | Hard-coded expected `<username>@<hostname>` normalization tests |
| MVP-03 | Two-agent test asserts separate shard paths |
| MVP-04 | Linux, macOS, and Windows unsafe-character vectors |
| MVP-05 | Append test asserts one episode and its facts |
| MVP-06 | Two independent agent branches merge without CSV conflict |
| MVP-07 | One real DuckDB search returns both agents' facts |
| MVP-08 | Configured compatible fake/system candidate test |
| MVP-09 | Preserved compatible managed CLI and managed-candidate test |
| MVP-10 | Fixture HTTPS bootstrap path test without network |
| MVP-11 | Independent SHA-256 fixture checksum test |
| MVP-12 | Current fact query test |
| MVP-13 | Historical superseded-fact query test |
| MVP-14 | Returned fact rows contain episode provenance |
| MVP-15 | Append dependency graph and `docs/manual-verification.md` zero-message RPC evidence |
| MVP-16 | Retrieval dependency graph and `docs/manual-verification.md` zero-message RPC evidence |
| MVP-17 | Temporary target runtime/cache deletion followed by CSV-only rebuild using a standalone compatible query engine |
