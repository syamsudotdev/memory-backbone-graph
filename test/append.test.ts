import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import { appendKnowledge } from "../src/append.ts";
import { readRecords } from "../src/records.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "memory-backbone-")); roots.push(path); await promisify(execFile)("git", ["init", "-q", path]); return path; }
const request = (predicate = "uses", object = "value:csv") => ({ sessionId: "session-1", kind: "decision", summary: "selected storage", source: "test", facts: [{ subject: "project:memory", predicate, object }] });
async function bytes(path: string) { try { return await readFile(path, "utf8"); } catch { return undefined; } }
async function all(root: string, dataset: string, sequence = "0001") { return readRecords(dataset as any, await readFile(join(root, `knowledge/${dataset}/writer@host/2026-09/${sequence}.csv`), "utf8")); }
const moduleUrl = JSON.stringify(new URL("../src/append.ts", import.meta.url).href);
function child(code: string, args: string[] = []) { return new Promise<number>((resolve, reject) => { const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", code, ...args], { stdio: "pipe" }); let error = ""; process.stderr.on("data", b => error += b); process.on("error", reject); process.on("exit", value => value === null ? reject(new Error(error)) : resolve(value)); }); }

test("append creates one episode, facts, missing entities and retry is idempotent", async () => {
  const dir = await root(), options = { agentId: "writer@host", now: new Date("2026-09-21T00:00:00Z") };
  const first = await appendKnowledge(dir, { ...request(), facts: [...request().facts, { subject: "project:memory", predicate: "format", object: "value:csv" }] }, options);
  assert.deepEqual(first.changedPaths.sort(), ["knowledge/entities/writer@host/2026-09/0001.csv", "knowledge/episodes/writer@host/2026-09/0001.csv", "knowledge/facts/writer@host/2026-09/0001.csv"]);
  assert.equal((await all(dir, "entities")).length, 2); assert.equal((await all(dir, "episodes")).length, 1); assert.equal((await all(dir, "facts")).length, 2);
  const retry = await appendKnowledge(dir, { ...request(), facts: [...request().facts, { subject: "project:memory", predicate: "format", object: "value:csv" }] }, options);
  assert.equal(retry.retry, true); assert.deepEqual(retry.factIds, first.factIds); assert.deepEqual(retry.changedPaths, []);
});

test("retry requires exact episode, agent, session, and fact input metadata", async () => {
  const dir = await root(), options = { agentId: "writer@host", now: new Date("2026-09-21T00:00:00Z") }, rich = { ...request(), evidence: "episode evidence", facts: [{ ...request().facts[0], evidence: "fact evidence" }] };
  await appendKnowledge(dir, rich, options); assert.equal((await appendKnowledge(dir, rich, options)).retry, true);
  for (const changed of [{ ...rich, sessionId: "other" }, { ...rich, summary: "other" }, { ...rich, facts: [{ ...rich.facts[0], evidence: "other" }] }]) await assert.rejects(appendKnowledge(dir, changed, options), /duplicate active triple/);
  await assert.rejects(appendKnowledge(dir, rich, { ...options, agentId: "other@host" }), /duplicate active triple/);
});

test("runtime types, downstream lock scope, and symlink traversal are enforced", async () => {
  const dir = await root(), options = { agentId: "writer@host", now: new Date("2026-09-21T00:00:00Z") };
  for (const invalid of [{ ...request(), evidence: 1 }, { ...request(), tags: "unused" }, { ...request(), kind: "Decision" }, { ...request(), facts: [{ ...request().facts[0], predicate: "Uses" }] }, { ...request(), facts: [{ ...request().facts[0], supersedes: 2 }] }]) await assert.rejects(appendKnowledge(dir, invalid as any, options), /invalid|unknown/);
  let locked = false, preWriteLocked = false; const first = await appendKnowledge(dir, request(), { ...options, preWrite: async () => { preWriteLocked = true; await stat(join(dir, "runtime/knowledge-writer.lock")); }, downstream: async result => { locked = true; assert.equal(result.retry, false); await stat(join(dir, "runtime/knowledge-writer.lock")); } }); assert.equal(locked, true); assert.equal(preWriteLocked, true);
  await appendKnowledge(dir, request(), { ...options, downstream: async result => { assert.equal(result.retry, true); await stat(join(dir, "runtime/knowledge-writer.lock")); } }); assert.equal(first.retry, false);
  const linked = await root(), outside = await root(); await symlink(outside, join(linked, "knowledge")); await assert.rejects(appendKnowledge(linked, request("linked"), options), /symlink traversal rejected/);
});

test("validation, global duplicates, invalid supersession, and injected replacement failures preserve bytes", async () => {
  const dir = await root(), options = { agentId: "writer@host", now: new Date("2026-09-21T00:00:00Z") };
  const first = await appendKnowledge(dir, request(), options), paths = first.changedPaths.map(p => join(dir, p)), before = await Promise.all(paths.map(bytes));
  await assert.rejects(appendKnowledge(dir, { ...request(), facts: [request().facts[0], { subject: "x:y", predicate: "new", object: "z:q" }] }, options), /duplicate/);
  await assert.rejects(appendKnowledge(dir, request("changed"), { ...options, env: { MBG_SHARD_ROW_LIMIT: "0" } }), /SHARD_ROW_LIMIT/);
  await assert.rejects(appendKnowledge(dir, { ...request("changed"), facts: [{ ...request("changed").facts[0], supersedes: first.factIds[0] }] }, options), /same subject and predicate/);
  assert.deepEqual(await Promise.all(paths.map(bytes)), before);
  for (const index of [0, 1, 2]) { const faultRequest = { ...request(`fault-${index}`), facts: [{ subject: `project:fault-${index}`, predicate: `fault-${index}`, object: `value:fault-${index}` }] }; await assert.rejects(appendKnowledge(dir, faultRequest, { ...options, fault: (phase, i) => { if (phase === "replaced" && i === index) throw new Error("fault"); } }), /fault/); assert.deepEqual(await Promise.all(paths.map(bytes)), before); }
});

test("hard process exits at every manifest and replacement phase recover on next append", async () => {
  for (const [stop, index] of [["prepared", -1], ["replacing", -1], ["replaced", 0], ["replaced", 1], ["replaced", 2], ["complete", -1]] as const) {
    const dir = await root();
    const crash = `import{appendKnowledge as a}from ${moduleUrl};const[r,p,i]=process.argv.slice(1);await a(r,{sessionId:'s',kind:'decision',summary:'crash',source:'test',facts:[{subject:'project:crash',predicate:'crash',object:'value:crash'}]},{agentId:'writer@host',now:new Date('2026-09-21T00:00:00Z'),fault:(x,n)=>{if(x===p&&(p!=='replaced'||n===+i))process.exit(86)}});`;
    assert.equal(await child(crash, [dir, stop, String(index)]), 86);
    const result = await appendKnowledge(dir, request("after"), { agentId: "writer@host", now: new Date("2026-09-21T00:00:00Z") });
    assert.equal(result.retry, false); assert.deepEqual((await all(dir, "facts")).map(f => f.predicate), stop === "complete" ? ["crash", "after"] : ["after"]);
  }
});

test("a hard exit during rollback leaves backups reusable by another recovery", async () => {
  const dir = await root(), base = { agentId: "writer@host", now: new Date("2026-09-21T00:00:00Z") }; await appendKnowledge(dir, request("base"), base);
  const createCrash = `import{appendKnowledge as a}from ${moduleUrl};const r=process.argv[1];await a(r,{sessionId:'s',kind:'decision',summary:'crash',source:'test',facts:[{subject:'project:new',predicate:'crash',object:'value:new'}]},{agentId:'writer@host',now:new Date('2026-09-21T00:00:00Z'),fault:(x,n)=>{if(x==='replaced'&&n===1)process.exit(86)}});`;
  assert.equal(await child(createCrash, [dir]), 86);
  const recoveryCrash = `import{appendKnowledge as a}from ${moduleUrl};const r=process.argv[1];await a(r,{sessionId:'s2',kind:'decision',summary:'after',source:'test',facts:[{subject:'project:after',predicate:'after',object:'value:after'}]},{agentId:'writer@host',now:new Date('2026-09-21T00:00:00Z'),fault:(x,n)=>{if(x==='recovery'&&n===0)process.exit(87)}});`;
  assert.equal(await child(recoveryCrash, [dir]), 87); await appendKnowledge(dir, request("after"), base); assert.deepEqual((await all(dir, "facts")).map(f => f.predicate), ["base", "after"]);
});

test("missing or stale state reconstructs shards and deterministic rotation keeps a large operation together", async () => {
  const dir = await root(), base = { agentId: "writer@host", now: new Date("2026-09-21T00:00:00Z"), env: { MBG_SHARD_ROW_LIMIT: "1" } };
  await appendKnowledge(dir, request("one"), base); await rm(join(dir, "runtime/active-shards.json"), { force: true });
  await appendKnowledge(dir, request("two"), base); assert.equal((await all(dir, "facts", "0002")).length, 1);
  const result = await appendKnowledge(dir, { ...request("three"), facts: [request("three").facts[0], request("four").facts[0]] }, base);
  assert.ok(result.changedPaths.includes("knowledge/facts/writer@host/2026-09/0003.csv")); assert.equal((await all(dir, "facts", "0003")).length, 2);
});

test("spawned concurrent writers serialize without malformed CSV", async () => {
  const dir = await root();
  const worker = `import { appendKnowledge } from ${moduleUrl}; const [root,n]=process.argv.slice(1); await appendKnowledge(root,{sessionId:'worker-'+n,kind:'observation',summary:'worker '+n,source:'test',facts:[{subject:'project:test',predicate:'worker-'+n,object:'value:'+n}]},{agentId:'writer@host',now:new Date('2026-09-21T00:00:00Z')});`;
  const run = (n: number) => new Promise<void>((resolve, reject) => { const child = spawn(process.execPath, ["--input-type=module", "-e", worker, dir, String(n)], { stdio: "pipe" }); let error = ""; child.stderr.on("data", b => error += b); child.on("exit", code => code === 0 ? resolve() : reject(new Error(error))); });
  await Promise.all([run(1), run(2)]); const facts = await all(dir, "facts"); assert.equal(facts.length, 2); assert.deepEqual(new Set(facts.map(f => f.predicate)), new Set(["worker-1", "worker-2"]));
  await stat(join(dir, "runtime/active-shards.json"));
});
