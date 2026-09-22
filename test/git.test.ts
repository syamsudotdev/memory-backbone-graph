import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import { appendKnowledgeWithGit, commitKnowledge, resolveProjectGit } from "../src/git.ts";
import { readRecords } from "../src/records.ts";

const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))));
async function git(root: string, ...args: string[]) { return (await exec("git", args, { cwd: root })).stdout.trim(); }
async function repo(commit = true) { const root = await mkdtemp(join(tmpdir(), "knowledge-git-")); roots.push(root); await git(root, "init", "-q"); await git(root, "config", "user.name", "Test"); await git(root, "config", "user.email", "test@example.invalid"); if (commit) { await writeFile(join(root, "base.txt"), "base\n"); await git(root, "add", "base.txt"); await git(root, "commit", "-qm", "base"); } return root; }
const request = { sessionId: "session-1", kind: "decision", summary: "store knowledge", source: "test", facts: [{ subject: "project:test", predicate: "uses", object: "format:csv" }] };
const options = { agentId: "writer@host", now: new Date("2026-09-21T00:00:00Z") };
const moduleUrl = JSON.stringify(new URL("../src/git.ts", import.meta.url).href);
function child(code: string, args: string[]) { return new Promise<number>((resolve, reject) => { const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", code, ...args], { stdio: "pipe" }); let error = ""; process.stderr.on("data", b => error += b); process.on("error", reject); process.on("exit", value => value === null ? reject(new Error(error)) : resolve(value)); }); }

test("append commits only knowledge without changing index or unrelated files", async () => {
  const root = await repo(); await git(root, "remote", "add", "origin", "https://example.invalid/repo.git"); const remotes = await git(root, "remote", "-v"); await writeFile(join(root, "staged.txt"), "staged\n"); await git(root, "add", "staged.txt"); await writeFile(join(root, "dirty.txt"), "dirty\n");
  const indexBefore = await readFile(join(root, ".git/index")); const parent = await git(root, "rev-parse", "HEAD");
  const result = await appendKnowledgeWithGit(join(root, "knowledge", ".."), request, options);
  assert.ok(result.commitOid); assert.equal(await git(root, "rev-parse", "HEAD^"), parent); assert.deepEqual(await readFile(join(root, ".git/index")), indexBefore);
  assert.equal(await readFile(join(root, "dirty.txt"), "utf8"), "dirty\n");
  assert.deepEqual((await git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).split("\n").sort(), result.changedPaths.sort());
  assert.equal(await git(root, "show", "HEAD:base.txt"), "base"); await assert.rejects(() => git(root, "show", "HEAD:staged.txt"));
  assert.match(await git(root, "log", "-1", "--format=%B"), /Episode-ID: ep_.*\nSession-ID: session-1\nRequest-Key: [a-f0-9]{64}/);
  assert.equal(await git(root, "remote", "-v"), remotes); assert.match(await git(root, "status", "--short"), /A  staged\.txt[\s\S]*\?\? dirty\.txt/);
});

test("unborn branch receives an isolated first commit", async () => {
  const root = await repo(false); await writeFile(join(root, "unrelated.txt"), "unrelated\n"); await git(root, "add", "unrelated.txt"); const before = await readFile(join(root, ".git/index"));
  const result = await appendKnowledgeWithGit(root, request, options); assert.ok(result.commitOid); assert.deepEqual(await readFile(join(root, ".git/index")), before);
  const names = (await git(root, "ls-tree", "-r", "--name-only", "HEAD")).split("\n"); assert.ok(names.every(name => name.startsWith("knowledge/"))); assert.ok(!names.includes("unrelated.txt"));
});

test("non-Git, detached HEAD, ignored targets, branch switches, and unsafe paths fail clearly", async () => {
  const outside = await mkdtemp(join(tmpdir(), "knowledge-outside-")); roots.push(outside); await assert.rejects(appendKnowledgeWithGit(outside, request, options), /no Git project/); await assert.rejects(stat(join(outside, "runtime")), /ENOENT/);
  const detached = await repo(); await git(detached, "checkout", "--detach", "-q"); await assert.rejects(appendKnowledgeWithGit(detached, request, options), /detached HEAD/);
  const ignored = await repo(); await writeFile(join(ignored, ".gitignore"), "knowledge/\n"); await assert.rejects(appendKnowledgeWithGit(ignored, request, options), /git add failed/); await stat(join(ignored, "knowledge/facts/writer@host/2026-09/0001.csv"));
  const switched = await repo(); const switchedStart = await resolveProjectGit(switched); await git(switched, "switch", "-qc", "other"); await mkdir(join(switched, "knowledge")); await writeFile(join(switched, "knowledge/facts.csv"), "x"); await assert.rejects(commitKnowledge(switchedStart, ["knowledge/facts.csv"], 1, "a", "e", "s"), /current branch changed/);
});

test("guard rejects concurrent branch movement and unsafe paths", async () => {
  const root = await repo(), start = await resolveProjectGit(root); await mkdir(join(root, "knowledge")); await writeFile(join(root, "knowledge/facts.csv"), "x");
  await writeFile(join(root, "movement.txt"), "move\n"); await git(root, "add", "movement.txt"); await git(root, "commit", "-qm", "move");
  await assert.rejects(commitKnowledge(start, ["knowledge/facts.csv"], 1, "a", "e", "s"), /branch moved concurrently/);
  await assert.rejects(commitKnowledge(await resolveProjectGit(root), ["../outside"], 1, "a", "e", "s"), /escapes knowledge/);
});

test("commit failure retains rows and retry commits without duplicates", async () => {
  const root = await repo(); await git(root, "config", "--unset", "user.name"); await git(root, "config", "--unset", "user.email");
  const env = { ...process.env, HOME: join(root, "empty-home"), XDG_CONFIG_HOME: join(root, "empty-config") };
  const old = process.env.HOME; process.env.HOME = env.HOME; process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  try { await assert.rejects(appendKnowledgeWithGit(root, request, options), /valid files remain uncommitted/); }
  finally { process.env.HOME = old; delete process.env.XDG_CONFIG_HOME; }
  const factsPath = join(root, "knowledge/facts/writer@host/2026-09/0001.csv"); assert.equal(readRecords("facts", await readFile(factsPath, "utf8")).length, 1);
  await git(root, "config", "user.name", "Test"); await git(root, "config", "user.email", "test@example.invalid"); const retry = await appendKnowledgeWithGit(root, request, options);
  assert.equal(retry.retry, true); assert.ok(retry.commitOid); assert.equal(readRecords("facts", await readFile(factsPath, "utf8")).length, 1); assert.equal(await git(root, "rev-list", "--count", "HEAD"), "2");
});

test("concurrent Git appends serialize and both commits succeed", async () => {
  const root = await repo(), second = { ...request, sessionId: "session-2", facts: [{ ...request.facts[0], predicate: "stores" }] };
  const [a, b] = await Promise.all([appendKnowledgeWithGit(root, request, options), appendKnowledgeWithGit(root, second, options)]);
  assert.ok(a.commitOid); assert.ok(b.commitOid); assert.equal(await git(root, "rev-list", "--count", "HEAD"), "3");
  const facts = readRecords("facts", await readFile(join(root, "knowledge/facts/writer@host/2026-09/0001.csv"), "utf8")); assert.deepEqual(new Set(facts.map(f => f.predicate)), new Set(["uses", "stores"]));
});

test("hard exits around durable pending phases retry without duplicate rows or commits", async () => {
  for (const phase of ["pending-intent", "updated-ref", "pending-cleanup"] as const) {
    const root = await repo(), script = `import{appendKnowledgeWithGit as a}from ${moduleUrl};const[r,p]=process.argv.slice(1);await a(r,${JSON.stringify(request)},{agentId:'writer@host',now:new Date('2026-09-21T00:00:00Z'),gitFault:x=>{if(x===p)process.exit(88)}});`;
    assert.equal(await child(script, [root, phase]), 88); const before = Number(await git(root, "rev-list", "--count", "HEAD")); assert.equal(before, phase === "pending-intent" ? 1 : 2);
    const retry = await appendKnowledgeWithGit(root, request, options); assert.equal(retry.retry, true); assert.equal(await git(root, "rev-list", "--count", "HEAD"), "2");
    assert.equal(readRecords("facts", await readFile(join(root, "knowledge/facts/writer@host/2026-09/0001.csv"), "utf8")).length, 1);
    await assert.rejects(stat(join(root, "runtime/pending-knowledge-commit.json")), /ENOENT/);
  }
});

test("an unresolved pending intent blocks a different request until the original retries", async () => {
  const root = await repo(), other = { ...request, sessionId: "session-b", facts: [{ ...request.facts[0], predicate: "other" }] };
  const script = `import{appendKnowledgeWithGit as a}from ${moduleUrl};const r=process.argv[1];await a(r,${JSON.stringify(request)},{agentId:'writer@host',now:new Date('2026-09-21T00:00:00Z'),gitFault:x=>{if(x==='pending-intent')process.exit(88)}});`;
  assert.equal(await child(script, [root]), 88);
  await assert.rejects(appendKnowledgeWithGit(root, other, options), /must be retried before a different append/);
  assert.equal(readRecords("facts", await readFile(join(root, "knowledge/facts/writer@host/2026-09/0001.csv"), "utf8")).length, 1);
  await appendKnowledgeWithGit(root, request, options); const result = await appendKnowledgeWithGit(root, other, options); assert.ok(result.commitOid);
  assert.equal(await git(root, "rev-list", "--count", "HEAD"), "3");
});

test("retry finds its request-key commit behind an intervening commit", async () => {
  const root = await repo(), script = `import{appendKnowledgeWithGit as a}from ${moduleUrl};const r=process.argv[1];await a(r,${JSON.stringify(request)},{agentId:'writer@host',now:new Date('2026-09-21T00:00:00Z'),gitFault:x=>{if(x==='updated-ref')process.exit(88)}});`;
  assert.equal(await child(script, [root]), 88); await writeFile(join(root, "later.txt"), "later\n"); await git(root, "add", "later.txt"); await git(root, "commit", "-qm", "later");
  const before = await git(root, "rev-parse", "HEAD"); const retry = await appendKnowledgeWithGit(root, request, options);
  assert.equal(retry.retry, true); assert.equal(await git(root, "rev-parse", "HEAD"), before); assert.equal(await git(root, "rev-list", "--count", "--grep=^knowledge: append", "HEAD"), "1");
  assert.equal(readRecords("facts", await readFile(join(root, "knowledge/facts/writer@host/2026-09/0001.csv"), "utf8")).length, 1);
});

test("a different request cleans completed stale pending state and proceeds", async () => {
  const root = await repo(), other = { ...request, sessionId: "session-b", facts: [{ ...request.facts[0], predicate: "after" }] }, script = `import{appendKnowledgeWithGit as a}from ${moduleUrl};const r=process.argv[1];await a(r,${JSON.stringify(request)},{agentId:'writer@host',now:new Date('2026-09-21T00:00:00Z'),gitFault:x=>{if(x==='pending-cleanup')process.exit(88)}});`;
  assert.equal(await child(script, [root]), 88); await stat(join(root, "runtime/pending-knowledge-commit.json"));
  const result = await appendKnowledgeWithGit(root, other, options); assert.ok(result.commitOid); await assert.rejects(stat(join(root, "runtime/pending-knowledge-commit.json")), /ENOENT/);
  assert.equal(await git(root, "rev-list", "--count", "HEAD"), "3");
});
