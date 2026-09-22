import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendKnowledge } from "../src/append.ts";
import { ensureDuckDB } from "../src/duckdb.ts";
import { getKnowledge, searchKnowledge } from "../src/query.ts";
import { COLUMNS, encodeCsv, factFingerprint, readRecords } from "../src/records.ts";

const extensionDir = join(import.meta.dirname, "..");
const exec = promisify(execFile);
async function digest(path: string) { const hash = createHash("sha256"); async function walk(dir: string): Promise<void> { for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) { const child = join(dir, entry.name); if (entry.isDirectory()) await walk(child); else hash.update(child).update(await readFile(child)); } } await walk(path); return hash.digest("hex"); }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "knowledge-query-")); await exec("git", ["init", "-q", "-b", "main", root]); await mkdir(join(root, "knowledge", "metadata"), { recursive: true }); await writeFile(join(root, "knowledge", "metadata", "schema-version"), "1\n");
  const options = { agentId: "tester@host", now: new Date("2025-01-01T00:00:00.000Z") };
  const first = await appendKnowledge(root, { sessionId: "session-1", kind: "decision", summary: "Remote execution choice", source: "test", facts: [{ subject: "topic:remote", predicate: "uses", object: "mode:ssh", evidence: "quoted O'Reilly" }] }, options);
  const second = await appendKnowledge(root, { sessionId: "session-2", kind: "correction", summary: "Remote local correction", source: "review", facts: [{ subject: "topic:remote", predicate: "uses", object: "mode:local", supersedes: first.factIds[0] }] }, { ...options, now: new Date("2025-01-02T00:00:00.000Z") });
  const third = await appendKnowledge(root, { sessionId: "session-3", kind: "correction", summary: "Remote container correction", source: "review", facts: [{ subject: "topic:remote", predicate: "uses", object: "mode:container", supersedes: second.factIds[0] }] }, { ...options, now: new Date("2025-01-03T00:00:00.000Z") });
  return { root, first, second, third };
}

test("real DuckDB searches fixed relations, filters, history, provenance and stable IDs", async t => {
  const duckdbPath = await ensureDuckDB({ extensionDir }); const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); const options = { duckdbPath, extensionDir };
  const current = await searchKnowledge(f.root, {}, options); assert.deepEqual(current.rows.map(r => r.fact_id), f.third.factIds); assert.equal(current.rows[0].session_id, "session-3");
  const history = await searchKnowledge(f.root, { history: true }, options); assert.deepEqual(history.rows.map(r => r.fact_id), [...f.first.factIds, ...f.second.factIds, ...f.third.factIds]);
  const filters = { terms: ["REMOTE", "container"], subject: "topic:remote", predicate: "uses", object: "mode:container", kind: "correction", agent_id: "tester@host", session_id: "session-3", from: "2025-01-03T00:00:00Z", to: "2025-01-03T00:00:00Z", limit: 1 };
  for (const key of Object.keys(filters)) assert.equal((await searchKnowledge(f.root, { [key]: (filters as any)[key] }, options)).rows.length, 1, key);
  assert.equal((await searchKnowledge(f.root, filters, options)).rows.length, 1);
  assert.equal((await getKnowledge(f.root, f.first.factIds[0], options)).rows[0].summary, "Remote execution choice");
  assert.equal((await getKnowledge(f.root, f.first.episodeId, options)).rows[0].session_id, "session-1");
  const entity = current.rows[0].subject as string, entities = await searchKnowledge(f.root, {}, options); assert.ok(entity); // entity ID is obtained from the fixed entity relation via known fixture lookup below
  const entityFiles = await readdir(join(f.root, "knowledge", "entities", "tester@host", "2025-01")); const csv = await readFile(join(f.root, "knowledge", "entities", "tester@host", "2025-01", entityFiles[0]), "utf8"); const entityId = csv.match(/ent_[0-9a-f-]{36}/)![0]; assert.equal((await getKnowledge(f.root, entityId, options)).rows[0].canonical_key, "topic:remote");
  assert.equal((await searchKnowledge(f.root, { limit: 1 }, options)).rows.length, 1); assert.equal((await searchKnowledge(f.root, { limit: 100 }, options)).rows.length, 1);
  await assert.rejects(searchKnowledge(f.root, { limit: 0 }, options), /limit/); await assert.rejects(searchKnowledge(f.root, { limit: 101 }, options), /limit/);
  assert.equal((await searchKnowledge(f.root, { terms: ["'; DROP TABLE facts; --"] }, options)).rows.length, 0);
  assert.equal((await searchKnowledge(f.root, { terms: ["%"] }, options)).rows.length, 0);
});

test("corrupt shard is omitted explicitly and canonical bytes stay unchanged", async t => {
  const duckdbPath = await ensureDuckDB({ extensionDir }); const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); const corrupt = join(f.root, "knowledge", "facts", "tester@host", "2025-02", "0001.csv"); await mkdir(join(corrupt, ".."), { recursive: true }); await writeFile(corrupt, '"unterminated'); const before = await digest(join(f.root, "knowledge"));
  const result = await searchKnowledge(f.root, {}, { duckdbPath, extensionDir }); assert.equal(result.rows.length, 1); assert.equal(result.partial, true); assert.deepEqual(result.omittedShards, ["knowledge/facts/tester@host/2025-02/0001.csv"]); assert.equal(await digest(join(f.root, "knowledge")), before);
});

test("resolves the exact Git root and rejects invalid filter and stable-ID types", async t => {
  const duckdbPath = await ensureDuckDB({ extensionDir }), f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); const options = { duckdbPath, extensionDir };
  assert.equal((await searchKnowledge(join(f.root, "knowledge"), {}, options)).rows.length, 1);
  for (const filters of [{ history: "true" }, { subject: 1 }, { terms: "remote" }, { limit: 1.5 }, { from: "2026-02-30T00:00:00Z" }] as any[]) await assert.rejects(searchKnowledge(f.root, filters, options), /invalid|boolean|limit/);
  for (const id of ["fact_00000000-0000-1000-8000-000000000000", "fact_00000000-0000-4000-7000-000000000000", "fact_../../etc/passwd"]) await assert.rejects(getKnowledge(f.root, id, options), /invalid stable ID/);
});

test("complete validation omits malformed and relationally unsafe shards", async t => {
  const duckdbPath = await ensureDuckDB({ extensionDir }), f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); const options = { duckdbPath, extensionDir }, base = join(f.root, "knowledge", "facts", "tester@host", "2025-02"); await mkdir(base, { recursive: true });
  const originalPath = join(f.root, "knowledge", "facts", "tester@host", "2025-01", "0001.csv"), original = readRecords("facts", await readFile(originalPath, "utf8"));
  await writeFile(join(base, "0001.csv"), encodeCsv(COLUMNS.facts, [original[0]]) + "broken,row\r\n");
  const make = (overrides: Record<string,string> = {}) => ({ ...original[0], fact_id: `fact_${randomUUID()}`, object: "mode:bad", supersedes: "", fingerprint: factFingerprint("topic:remote", "uses", "mode:bad"), created_at: "2025-02-01T00:00:00.000Z", ...overrides });
  const duplicate = make(); await writeFile(join(base, "0002.csv"), encodeCsv(COLUMNS.facts, [duplicate])); await writeFile(join(base, "0007.csv"), encodeCsv(COLUMNS.facts, [duplicate]));
  await writeFile(join(base, "0003.csv"), encodeCsv(COLUMNS.facts, [make({ confidence: "2" })]));
  await writeFile(join(base, "0004.csv"), encodeCsv(COLUMNS.facts, [make({ episode_id: `ep_${randomUUID()}` })]));
  await writeFile(join(base, "0005.csv"), encodeCsv(COLUMNS.facts, [make({ supersedes: `fact_${randomUUID()}` })]));
  const wrongPair = make({ predicate: "rejects", supersedes: f.third.factIds[0] }); wrongPair.fingerprint = factFingerprint(wrongPair.subject, wrongPair.predicate, wrongPair.object); await writeFile(join(base, "0008.csv"), encodeCsv(COLUMNS.facts, [wrongPair]));
  await writeFile(join(base, "0009.csv"), encodeCsv(COLUMNS.facts, [make({ supersedes: f.third.factIds[0], created_at: "2024-01-01T00:00:00.000Z" })]));
  const a = make(), b = make(); a.object = "mode:a"; a.fingerprint = factFingerprint(a.subject,a.predicate,a.object); b.object = "mode:b"; b.fingerprint = factFingerprint(b.subject,b.predicate,b.object); a.supersedes = b.fact_id; b.supersedes = a.fact_id;
  await writeFile(join(base, "0006.csv"), encodeCsv(COLUMNS.facts, [a,b]));
  const before = await digest(join(f.root, "knowledge")), result = await searchKnowledge(f.root, { history: true }, options);
  assert.equal(result.partial, true); assert.deepEqual(result.rows.map(r => r.fact_id), [...f.first.factIds, ...f.second.factIds, ...f.third.factIds]);
  for (let i=1;i<=9;i++) assert.ok(result.omittedShards.includes(`knowledge/facts/tester@host/2025-02/${String(i).padStart(4,"0")}.csv`));
  assert.equal(await digest(join(f.root, "knowledge")), before);
});

test("dataset symlink escape is rejected before traversal", async t => {
  const duckdbPath = await ensureDuckDB({ extensionDir }), f = await fixture(), outside = await mkdtemp(join(tmpdir(), "knowledge-outside-")); t.after(() => Promise.all([rm(f.root,{recursive:true,force:true}),rm(outside,{recursive:true,force:true})]));
  await rm(join(f.root,"knowledge","facts"), { recursive:true }); await symlink(outside, join(f.root,"knowledge","facts"), "dir");
  await assert.rejects(searchKnowledge(f.root, {}, { duckdbPath, extensionDir }), /symlink traversal rejected/);
});
