import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { ensureDuckDB } from "../src/duckdb.ts";
import { appendKnowledgeWithGit } from "../src/git.ts";
import { searchKnowledge } from "../src/query.ts";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await exec("git", args, { cwd })).stdout.trim(); }
async function identity(root: string) { await git(root, "config", "user.name", "Test"); await git(root, "config", "user.email", "test@example.invalid"); }

test("two agents merge independent shard branches and rebuild views from CSV", async t => {
  const fixture = await mkdtemp(join(tmpdir(), "knowledge-two-agent-")), remote = join(fixture, "shared.git"), seed = join(fixture, "seed"), agentA = join(fixture, "agent-a"), agentB = join(fixture, "agent-b"), root = join(fixture, "merged");
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await git(fixture, "init", "--bare", "-q", remote); await git(fixture, "init", "-q", seed); await identity(seed);
  await git(seed, "commit", "--allow-empty", "-qm", "base"); await git(seed, "remote", "add", "origin", remote); await git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  for (const directory of [agentA, agentB, root]) { await git(fixture, "clone", "-q", remote, directory); await identity(directory); }

  await git(agentA, "checkout", "-qb", "knowledge-agent-a");
  const first = await appendKnowledgeWithGit(agentA, {
    sessionId: "session-a", kind: "decision", summary: "Agent A chose CSV", source: "user",
    facts: [{ subject: "agent:alice", predicate: "uses", object: "format:csv" }],
  }, { agentId: "alice@linux-host", now: new Date("2026-09-21T01:00:00Z") });
  await git(agentA, "push", "-q", "-u", "origin", "knowledge-agent-a");

  await git(agentB, "checkout", "-qb", "knowledge-agent-b");
  const second = await appendKnowledgeWithGit(agentB, {
    sessionId: "session-b", kind: "observation", summary: "Agent B chose DuckDB", source: "user",
    facts: [{ subject: "agent:bob", predicate: "uses", object: "tool:duckdb" }],
  }, { agentId: "bob@windows-host", now: new Date("2026-09-21T02:00:00Z") });
  await git(agentB, "push", "-q", "-u", "origin", "knowledge-agent-b");

  await git(root, "fetch", "-q", "origin"); await git(root, "merge", "--no-edit", "origin/knowledge-agent-a"); await git(root, "merge", "--no-edit", "origin/knowledge-agent-b");
  assert.equal((await git(root, "log", "--format=%s", "--all")).split("\n").filter(subject => subject.startsWith("knowledge: append")).length, 2);
  assert.ok(first.changedPaths.every(path => path.includes("/alice@linux-host/2026-09/")));
  assert.ok(second.changedPaths.every(path => path.includes("/bob@windows-host/2026-09/")));
  assert.equal(new Set([...first.changedPaths, ...second.changedPaths]).size, first.changedPaths.length + second.changedPaths.length);

  const discovered = await ensureDuckDB({ extensionDir: process.cwd() });
  const standalone = join(fixture, basename(discovered)); await copyFile(discovered, standalone); if (process.platform !== "win32") await chmod(standalone, 0o755);
  const combined = await searchKnowledge(root, { history: true, limit: 10 }, { duckdbPath: standalone });
  assert.deepEqual(combined.rows.map(row => [row.subject, row.object, row.agent_id, row.session_id]), [
    ["agent:alice", "format:csv", "alice@linux-host", "session-a"],
    ["agent:bob", "tool:duckdb", "bob@windows-host", "session-b"],
  ]);

  await mkdir(join(fixture, "cache")); await rm(join(root, "runtime"), { recursive: true, force: true }); await rm(join(fixture, "cache"), { recursive: true, force: true });
  assert.deepEqual((await readdir(root)).sort(), [".git", "knowledge"]);
  const rebuilt = await searchKnowledge(root, {}, { duckdbPath: standalone });
  assert.deepEqual(rebuilt.rows.map(row => row.fact_id), [first.factIds[0], second.factIds[0]]);
});
