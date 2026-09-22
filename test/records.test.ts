import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLUMNS, canonicalKey, encodeCsv, factFingerprint, generateId,
  isPrefixedUuid, normalizeAgentId, parseCsv, readRecords, shardPath,
} from "../src/records.ts";

const UUID_A = "123e4567-e89b-42d3-a456-426614174000";
const UUID_B = "123e4567-e89b-42d3-b456-426614174001";
const EPISODE = `ep_${UUID_A}`;

function entity(overrides: Record<string, string> = {}) {
  return { schema_version: "1", entity_id: `ent_${UUID_A}`, type: "project", name: "memory",
    canonical_key: "project:memory", created_at: "2024-02-29T12:00:00Z", ...overrides };
}

function episode(overrides: Record<string, string> = {}) {
  return { schema_version: "1", episode_id: EPISODE, created_at: "2026-09-21T00:00:00.000Z",
    agent_id: "bot@team@host", session_id: "session-1", kind: "decision", summary: "Chosen",
    source: "conversation", evidence: "", tags: "", ...overrides };
}

function fact(overrides: Record<string, string> = {}) {
  const row = {
    schema_version: "1", fact_id: `fact_${UUID_A}`, subject: "project:memory", predicate: "handles",
    object: "value:CSV", episode_id: EPISODE, created_at: "2026-09-21T00:00:00.000Z",
    confidence: "1", evidence: "comma, quote \" and CR\rLF\n雪", supersedes: "", tags: "",
    fingerprint: factFingerprint("project:memory", "handles", "value:CSV"), ...overrides,
  };
  return row;
}

test("RFC 4180 values round-trip punctuation, line endings, Unicode, and empty fields", () => {
  const row = fact();
  const csv = encodeCsv(COLUMNS.facts, [row]);
  assert.match(csv, /"comma, quote "" and CR\rLF\n雪"/);
  assert.deepEqual(readRecords("facts", csv), [row]);
  assert.deepEqual(parseCsv('a,b\r\n"x\r\ny","""z"\r\n'), [["a", "b"], ["x\r\ny", '"z']]);
  assert.throws(() => parseCsv('a\r\n"broken'), /unterminated/);
});

test("identity normalization is safe under Linux, macOS, and Windows filename rules", () => {
  assert.equal(normalizeAgentId("  Sam ", " MBP-SAM "), "sam@mbp-sam");
  assert.equal(normalizeAgentId("Bot@Team", "HOST"), "bot@team@host");
  assert.equal(normalizeAgentId("A/<B>\\C", " Host:*?\u0001Name "), "a-b-c@host-name");
  assert.equal(normalizeAgentId("CON", "NUL"), "-con@-nul");
  assert.equal(normalizeAgentId("Name. ", "HOST..."), "name@host");
  assert.throws(() => normalizeAgentId("\u0000 / ", "host"), /username is empty/);
  assert.throws(() => normalizeAgentId("user", "***"), /hostname is empty/);
});

test("IDs validate UUIDv4 shape, prefix correctly, and retry deterministic collisions", () => {
  const used = new Set([`ent_${UUID_A}`]);
  const values = [UUID_A, UUID_B];
  assert.equal(generateId("entities", used, () => values.shift()!), `ent_${UUID_B}`);
  assert.equal(isPrefixedUuid(`ent_${UUID_B}`, "ent_"), true);
  assert.equal(isPrefixedUuid("ent_not-a-uuid", "ent_"), false);
  assert.throws(() => generateId("facts", new Set(), () => "123e4567-e89b-12d3-a456-426614174000"), /non-v4/);
});

test("fingerprints frame triple elements without delimiter ambiguity", () => {
  assert.equal(factFingerprint("project:a", "uses:x", "value:b"), "231d6ba51fbcad21d3560dc5a3b221cbed5b69b996f4a16447290078eac1ef36");
  const base = factFingerprint("a:b", "c", "d:e");
  assert.notEqual(base, factFingerprint("a:x", "c", "d:e"));
  assert.notEqual(base, factFingerprint("a:b", "x", "d:e"));
  assert.notEqual(base, factFingerprint("a:b", "c", "x:e"));
  assert.notEqual(factFingerprint("ab", "c", "d"), factFingerprint("a", "bc", "d"));
});

test("canonical keys and canonical paths are deterministic", () => {
  assert.equal(canonicalKey("project", "memory"), "project:memory");
  assert.throws(() => canonicalKey(" project", "memory"), /invalid entity type/);
  assert.equal(shardPath("facts", "sam@mbp-sam", new Date("2026-09-21T23:00:00-02:00"), 2), "knowledge/facts/sam@mbp-sam/2026-09/0002.csv");
});

test("entity and episode records validate their dataset-specific fields", () => {
  assert.deepEqual(readRecords("entities", encodeCsv(COLUMNS.entities, [entity()])), [entity()]);
  assert.deepEqual(readRecords("episodes", encodeCsv(COLUMNS.episodes, [episode()])), [episode()]);
  assert.throws(() => readRecords("entities", encodeCsv(COLUMNS.entities, [entity({ canonical_key: "project:other" })])), /canonical_key/);
  for (const agent_id of ["Bot@team@host", "bot@team@HOST", "bot/team@host", "bot@team@"])
    assert.throws(() => readRecords("episodes", encodeCsv(COLUMNS.episodes, [episode({ agent_id })])), /invalid agent_id/);
});

test("strict UTC timestamps reject normalized impossible dates", () => {
  for (const created_at of ["2023-02-29T12:00:00Z", "2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z"])
    assert.throws(() => readRecords("entities", encodeCsv(COLUMNS.entities, [entity({ created_at })])), /invalid created_at/);
});

test("reader supplies version 1 additive defaults but rejects missing required columns", () => {
  const oldColumns = ["fact_id", "subject", "predicate", "object", "episode_id", "created_at", "confidence", "supersedes"];
  const oldRow = fact();
  const [read] = readRecords("facts", encodeCsv(oldColumns, [oldRow]));
  assert.equal(read.schema_version, "1");
  assert.equal(read.evidence, "");
  assert.equal(read.tags, "");
  assert.equal(read.fingerprint, oldRow.fingerprint);
  assert.throws(() => readRecords("facts", "fact_id,subject\r\nx,y\r\n"), /missing required column: predicate/);
  assert.throws(() => readRecords("facts", encodeCsv(COLUMNS.facts, [oldRow, oldRow])), /duplicate primary ID/);
});
