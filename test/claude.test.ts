import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const cli = join(root, "claude/knowledge-cli.ts");
const hook = join(root, "claude/prompt-hook.ts");

function run(script: string, input: string, cwd = root, env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function git(cwd: string, args: string[]) {
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn("git", args, { cwd }); let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; }); child.on("error", reject);
    child.on("close", code => resolve({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
}

async function repository() {
  const path = await mkdtemp(join(tmpdir(), "knowledge-claude-"));
  await git(path, ["init", "-q"]); await git(path, ["config", "user.name", "Test"]); await git(path, ["config", "user.email", "test@example.invalid"]);
  return path;
}

function request(operation: string, params: unknown, sessionId?: string) {
  return JSON.stringify({ operation, ...(sessionId ? { sessionId } : {}), params });
}

test("Claude JSON CLI rejects malformed and unknown requests", async () => {
  const malformed = await run(cli, "{");
  assert.equal(malformed.code, 1); assert.equal(malformed.stdout, "");
  assert.deepEqual(JSON.parse(malformed.stderr), { ok: false, error: { category: "validation", message: "invalid JSON input" } });

  const unknown = await run(cli, request("remove", {}));
  assert.equal(unknown.code, 1); assert.equal(JSON.parse(unknown.stderr).error.message, "unknown operation: remove");
});

test("Claude JSON CLI appends, searches, and gets with session provenance", async t => {
  const project = await repository(); t.after(() => rm(project, { recursive: true, force: true }));
  const appended = await run(cli, request("append", {
    kind: "decision", summary: "Use DuckDB", source: "conversation",
    facts: [{ subject: "project:claude", predicate: "uses", object: "tool:duckdb" }],
  }, "claude-session"), project);
  assert.equal(appended.code, 0, appended.stderr);
  const appendData = JSON.parse(appended.stdout); assert.equal(appendData.ok, true); assert.equal(appendData.operation, "append");

  const searched = await run(cli, request("search", { terms: ["duck"] }), project);
  assert.equal(searched.code, 0, searched.stderr);
  assert.equal(JSON.parse(searched.stdout).data.rows[0].session_id, "claude-session");

  const fetched = await run(cli, request("get", { id: appendData.data.factIds[0] }), project);
  assert.equal(fetched.code, 0, fetched.stderr); assert.equal(JSON.parse(fetched.stdout).data.rows[0].subject, "project:claude");

  const duplicate = await run(cli, request("append", {
    kind: "decision", summary: "Duplicate", source: "conversation",
    facts: [{ subject: "project:claude", predicate: "uses", object: "tool:duckdb" }],
  }, "other-session"), project);
  assert.equal(duplicate.code, 1); assert.equal(JSON.parse(duplicate.stderr).error.category, "duplicate");
});

test("Claude JSON CLI redacts rejected secrets", async t => {
  const project = await repository(); t.after(() => rm(project, { recursive: true, force: true }));
  const secret = "password=correct-horse-battery-staple";
  const result = await run(cli, request("append", {
    kind: "note", summary: secret, source: "conversation",
    facts: [{ subject: "project:claude", predicate: "notes", object: "status:safe" }],
  }, "claude-session"), project);
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stderr).error.category, "validation");
  assert.doesNotMatch(result.stderr, /correct-horse-battery-staple/);
});

test("Claude UserPromptSubmit hook injects session-scoped adapter guidance", async () => {
  const result = await run(hook, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "session-123", cwd: root }), root, { ...process.env, CLAUDE_PLUGIN_ROOT: root });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "UserPromptSubmit");
  assert.match(output.additionalContext, /session-123/);
  assert.match(output.additionalContext, /claude\/knowledge-cli\.ts/);
  assert.match(output.additionalContext, /recall relevant durable knowledge/i);
  assert.match(output.additionalContext, /future session/i);

  const invalid = await run(hook, JSON.stringify({ hook_event_name: "SessionStart", session_id: "session-123" }), root, { ...process.env, CLAUDE_PLUGIN_ROOT: root });
  assert.equal(invalid.code, 1); assert.equal(JSON.parse(invalid.stderr).error.category, "validation");
});
