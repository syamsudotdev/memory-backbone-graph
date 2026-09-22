import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { ensureDuckDB } from "../src/duckdb.ts";
import { KnowledgeError } from "../src/errors.ts";
import { addKnowledgeGuidelines, knowledgeGuidelines } from "../extensions/lifecycle.ts";
import { registerKnowledgeTools } from "../extensions/tools.ts";

const exec = promisify(execFile);
const piEntry = realpathSync((await exec("which", ["pi"])).stdout.trim());
const piRequire = createRequire(piEntry);
const { Type } = await import(pathToFileURL(piRequire.resolve("typebox")).href);
const { Value } = await import(pathToFileURL(piRequire.resolve("typebox/value")).href);
const duckdb = await ensureDuckDB({ extensionDir: process.cwd() });

async function git(cwd: string, args: string[]) { return (await exec("git", args, { cwd })).stdout.trim(); }
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "knowledge-pi-tools-"));
  await git(root, ["init", "-q"]); await git(root, ["config", "user.name", "Test"]); await git(root, ["config", "user.email", "test@example.invalid"]);
  return root;
}
function tools() {
  const registered = new Map<string, any>();
  registerKnowledgeTools({ registerTool(tool) { registered.set(tool.name, tool); } }, Type as any);
  return registered;
}
function details(result: any) { return result.details; }
async function snapshot(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
  return Promise.all(files.map(async path => [path.slice(root.length + 1), (await readFile(path)).toString("base64")]));
}

process.env.PI_KNOWLEDGE_DUCKDB_PATH = duckdb;

test("registers exactly three strict schema-bound tools", () => {
  const registered = tools();
  assert.deepEqual([...registered.keys()], ["knowledge_append", "knowledge_search", "knowledge_get"]);
  const append = registered.get("knowledge_append").parameters;
  const search = registered.get("knowledge_search").parameters;
  const get = registered.get("knowledge_get").parameters;
  assert.equal(Value.Check(append, { kind: "decision", summary: "s", source: "user", facts: [] }), false);
  assert.equal(Value.Check(append, { kind: "", summary: "s", source: "user", facts: [{ subject: "not-a-key", predicate: "", object: "tool:y" }] }), false);
  assert.equal(Value.Check(append, { kind: "decision", summary: "s", source: "user", facts: [{ subject: "project:x", predicate: "uses", object: "tool:y", supersedes: "ep_00000000-0000-4000-8000-000000000000", extra: true }] }), false);
  assert.equal(Value.Check(search, { limit: 0 }), false);
  assert.equal(Value.Check(search, { from: "2025-01-01", subject: "bad", arbitrary_sql: "select 1" }), false);
  assert.equal(Value.Check(search, { terms: ["x".repeat(4097)] }), false);
  assert.equal(Value.Check(search, { terms: ["bad\u0000term"] }), false);
  assert.equal(Value.Check(get, { id: 4 }), false);
  assert.equal(Value.Check(get, { id: "fact_00000000-0000-4000-8000-000000000000", extra: true }), false);
});

test("lifecycle hook adds recall and capture guidance once", () => {
  const event = { systemPromptOptions: { promptGuidelines: ["existing"] } };
  addKnowledgeGuidelines(event); addKnowledgeGuidelines(event);
  assert.deepEqual(event.systemPromptOptions.promptGuidelines, ["existing", ...knowledgeGuidelines]);
  assert.match(knowledgeGuidelines[0], /knowledge_search/); assert.match(knowledgeGuidelines[1], /knowledge_append/);
});

test("extension entry loads in Pi and registers exactly three tools without a prompt", async t => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-pi-entry-")); t.after(() => rm(root, { recursive: true, force: true }));
  const wrapper = join(root, "extension.ts");
  await writeFile(wrapper, `import knowledge from ${JSON.stringify(pathToFileURL(join(process.cwd(), "extensions/knowledge.ts")).href)};\nexport default function (pi: any) { knowledge(pi); pi.on("session_start", () => console.error("KNOWLEDGE_TOOLS=" + pi.getAllTools().map((tool: any) => tool.name).filter((name: string) => name.startsWith("knowledge_")).join(","))); }\n`);
  await assert.rejects(
    exec(piEntry, ["--mode", "rpc", "--no-session", "--offline", "--no-extensions", "--no-builtin-tools", "-e", wrapper], { timeout: 1_000 }),
    (error: any) => { assert.match(error.stderr, /KNOWLEDGE_TOOLS=knowledge_append,knowledge_search,knowledge_get/); return true; },
  );
});

test("append uses the context session, commits locally, and retrieval is read-only", async t => {
  const root = await repository(); t.after(() => rm(root, { recursive: true, force: true }));
  const registered = tools(), context = { cwd: root, sessionManager: { getSessionId: () => "session-stable" } };
  const appended = details(await registered.get("knowledge_append").execute("1", {
    kind: "decision", summary: "Use DuckDB", source: "user", facts: [{ subject: "project:memory", predicate: "uses", object: "tool:duckdb" }],
  }, undefined, undefined, context));
  assert.equal(appended.ok, true); assert.match(appended.data.episodeId, /^ep_/); assert.ok(appended.data.commitOid);
  assert.match(await git(root, ["show", "-s", "--format=%B", "HEAD"]), /Session-ID: session-stable/);
  const duplicate = details(await registered.get("knowledge_append").execute("duplicate", {
    kind: "decision", summary: "Different episode", source: "user", facts: [{ subject: "project:memory", predicate: "uses", object: "tool:duckdb" }],
  }, undefined, undefined, context));
  assert.equal(duplicate.ok, false); assert.equal(duplicate.error.category, "duplicate");
  const before = await snapshot(root), head = await git(root, ["rev-parse", "HEAD"]);
  const searched = details(await registered.get("knowledge_search").execute("2", { terms: ["DuckDB"] }, undefined, undefined, context));
  assert.equal(searched.ok, true); assert.equal(searched.data.rows.length, 1); assert.equal(searched.partial, false);
  const fetched = details(await registered.get("knowledge_get").execute("3", { id: appended.data.factIds[0] }, undefined, undefined, context));
  assert.equal(fetched.ok, true); assert.equal(fetched.data.rows[0].session_id, "session-stable");
  assert.equal(await git(root, ["rev-parse", "HEAD"]), head); assert.deepEqual(await snapshot(root), before);

  const factPath = appended.data.changedPaths.find((path: string) => path.startsWith("knowledge/facts/"));
  await writeFile(join(root, factPath), "not,csv\n");
  const corruptBefore = await snapshot(root);
  const partial = details(await registered.get("knowledge_search").execute("4", {}, undefined, undefined, context));
  assert.equal(partial.ok, true); assert.equal(partial.partial, true); assert.deepEqual(partial.data.omittedShards, [factPath]);
  assert.deepEqual(await snapshot(root), corruptBefore);
});

test("real malformed DuckDB output is a dependency error and preserves append safety", async t => {
  const root = await repository(); t.after(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, "fake-duckdb");
  await writeFile(fake, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'v1.5.5 (Variegata) d8cdaa33fd'; else echo '{bad json'; fi\n");
  await chmod(fake, 0o755);
  const previous = process.env.PI_KNOWLEDGE_DUCKDB_PATH; process.env.PI_KNOWLEDGE_DUCKDB_PATH = fake;
  t.after(() => { if (previous === undefined) delete process.env.PI_KNOWLEDGE_DUCKDB_PATH; else process.env.PI_KNOWLEDGE_DUCKDB_PATH = previous; });
  const result = details(await tools().get("knowledge_search").execute("bad-db", {}, undefined, undefined, { cwd: root }));
  assert.equal(result.ok, false); assert.equal(result.error.category, "dependency"); assert.equal(result.error.appendCanContinue, true); assert.equal(result.error.canonicalDataPreserved, true);
});

test("typed domain failures preserve structured categories and append safety", async () => {
  for (const [category, appendCanContinue] of [["dependency", true], ["bootstrap", true], ["validation", false], ["duplicate", false], ["lock", false], ["git", false]] as const) {
    const registered = new Map<string, any>();
    const failure = new KnowledgeError(category, `${category} test`, { appendCanContinue });
    registerKnowledgeTools({ registerTool(tool) { registered.set(tool.name, tool); } }, Type as any, {
      resolveProjectGit: async () => ({ root: "/tmp/project", ref: "refs/heads/main", branch: "main" }),
      appendKnowledgeWithGit: async () => { throw failure; },
      searchKnowledge: async () => { throw failure; },
      getKnowledge: async () => { throw failure; },
    } as any);
    const result = details(await registered.get("knowledge_search").execute("x", {}, undefined, undefined, { cwd: "/tmp/project" }));
    assert.equal(result.ok, false); assert.equal(result.error.category, category); assert.equal(result.error.appendCanContinue, appendCanContinue); assert.equal(result.error.canonicalDataPreserved, true);
  }
});

test("extension dependency graph contains no model, prompt, network, extraction, or arbitrary-SQL hook", async () => {
  const sources = await Promise.all(["extensions/knowledge.ts", "extensions/tools.ts"].map(path => readFile(path, "utf8")));
  const imports = sources.flatMap(source => [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]));
  assert.deepEqual(imports.filter(path => !path.startsWith(".")), ["@earendil-works/pi-coding-agent", "typebox"]);
  assert.doesNotMatch(sources.join("\n"), /(?:fetch\(|https?:|generateText|complete\(|modelClient|arbitrary.?sql|extract(?:ion)?Hook)/i);
});

test("missing session and non-Git calls return structured errors without writes", async t => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-pi-no-git-")); t.after(() => rm(root, { recursive: true, force: true }));
  const registered = tools();
  const missing = details(await registered.get("knowledge_append").execute("1", { kind: "x", summary: "x", source: "x", facts: [{ subject: "a:a", predicate: "p", object: "b:b" }] }, undefined, undefined, { cwd: root }));
  assert.equal(missing.ok, false); assert.equal(missing.error.category, "setup"); assert.match(missing.error.message, /session ID/);
  assert.deepEqual(await readdir(root), []);
  const outside = details(await registered.get("knowledge_search").execute("2", {}, undefined, undefined, { cwd: root }));
  assert.equal(outside.ok, false); assert.equal(outside.error.category, "setup"); assert.match(outside.error.message, /no Git project/);
  assert.deepEqual(await readdir(root), []);
});
