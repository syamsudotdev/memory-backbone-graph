import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import { appendKnowledge } from "../src/append.ts";
import { appendKnowledgeWithGit } from "../src/git.ts";
import { readRecords } from "../src/records.ts";
import { MAX_CSV_BYTES, MAX_FACTS_PER_APPEND, MAX_KEY_BYTES, MAX_REQUEST_BYTES, MAX_TEXT_BYTES, secretCategory, validateCsvByteLength, validateRequestByteLength, validateText } from "../src/safety.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "memory-safety-")); roots.push(root);
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: root });
  await git("init", "-q"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
  await git("commit", "--allow-empty", "-qm", "initial"); return { root, git };
}
const request = (summary: string) => ({ sessionId: "session-1", kind: "decision", summary, source: "test", facts: [{ subject: "project:memory", predicate: "uses", object: "value:csv" }] });
const options = { agentId: "writer@host", now: new Date("2026-09-21T00:00:00Z") };

const positives = [
  ["private-key", "-----BEGIN PRIVATE " + "KEY-----\nabc", "private-key"],
  ["access-token", "github_" + "pat_12345678901234567890", "access-token"],
  ["credential-url", "https://alice:" + "hunter2@example.invalid/path", "credential-url"],
  ["credential-assignment", "api_" + "key" + "=abcdefgh12345678", "credential-assignment"],
] as const;
const negatives = ["-----BEGIN PUBLIC KEY-----", "token bucket", "password policy", "https://example.invalid/path", "ghp_short"];

test("secret rules classify fixed positives and accept benign near-matches", () => {
  for (const [, value, category] of positives) assert.equal(secretCategory(value), category);
  for (const value of negatives) assert.equal(secretCategory(value), undefined);
});

test("secret rejection is redacted and occurs before canonical or Git changes", async () => {
  for (const [, candidate, category] of positives) {
    const { root, git } = await repo(), before = (await git("rev-parse", "HEAD")).stdout.trim();
    await assert.rejects(appendKnowledgeWithGit(root, request(candidate), options), error => {
      assert.match(String(error), new RegExp(category)); assert.doesNotMatch(String(error), new RegExp(candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))); return true;
    });
    assert.equal((await git("rev-parse", "HEAD")).stdout.trim(), before);
    await assert.rejects(stat(join(root, "knowledge")), /ENOENT/);
  }
});

test("field and request boundaries reject overflow and controls before writes", async () => {
  assert.equal(validateText("x".repeat(MAX_KEY_BYTES), "key"), "x".repeat(MAX_KEY_BYTES));
  assert.equal(validateText("é".repeat(MAX_KEY_BYTES / 2), "key").length, MAX_KEY_BYTES / 2);
  assert.throws(() => validateText("é".repeat(MAX_KEY_BYTES / 2 + 1), "key"), /invalid key/);
  assert.equal(validateText("x".repeat(MAX_TEXT_BYTES), "text", { multiline: true, maxBytes: MAX_TEXT_BYTES }).length, MAX_TEXT_BYTES);
  assert.throws(() => validateText("bad\u0000value", "key"), /invalid key/);
  assert.doesNotThrow(() => validateCsvByteLength(MAX_CSV_BYTES)); assert.throws(() => validateCsvByteLength(MAX_CSV_BYTES + 1), /CSV input exceeds/);
  assert.doesNotThrow(() => validateRequestByteLength(MAX_REQUEST_BYTES)); assert.throws(() => validateRequestByteLength(MAX_REQUEST_BYTES + 1), /request exceeds/);
  assert.throws(() => readRecords("facts", "not,csv", 1), /CSV input exceeds/);
  const maximumRoot = (await repo()).root, root = (await repo()).root, fact = request("valid").facts[0];
  const maximum = Array.from({ length: MAX_FACTS_PER_APPEND }, (_, index) => ({ ...fact, predicate: `uses-${index}` }));
  assert.equal((await appendKnowledge(maximumRoot, { ...request("maximum"), facts: maximum }, options)).factIds.length, MAX_FACTS_PER_APPEND);
  await assert.rejects(appendKnowledge(root, { ...request("valid"), facts: Array(MAX_FACTS_PER_APPEND + 1).fill(fact) }, options), /facts must contain/);
  const largeFacts = Array.from({ length: 600 }, (_, index) => ({ ...fact, predicate: `uses-${index}`, evidence: "x".repeat(Math.ceil(MAX_REQUEST_BYTES / 500)) }));
  await assert.rejects(appendKnowledge(root, { ...request("valid"), facts: largeFacts }, options), /request exceeds size limit/);
  await assert.rejects(appendKnowledge(root, request("x".repeat(MAX_TEXT_BYTES + 1)), options), /invalid summary/);
  await assert.rejects(stat(join(root, "knowledge")), /ENOENT/);
});

test("benign near-matches remain appendable", async () => {
  const { root } = await repo();
  const result = await appendKnowledge(root, request(negatives.join("; ")), options);
  assert.equal(result.factIds.length, 1);
  assert.match(await readFile(join(root, result.changedPaths.find(path => path.startsWith("knowledge/episodes/"))!), "utf8"), /password policy/);
});
