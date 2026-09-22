import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import plugin from "../opencode/index.ts";

const exec = promisify(execFile);

async function repository() {
  const root = await mkdtemp(`${tmpdir()}/knowledge-opencode-`);
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  return root;
}

function context(directory: string) {
  const tools: any[] = []; let hook: ((event: any) => void | Promise<void>) | undefined;
  return {
    tools,
    get hook() { return hook; },
    value: {
      location: { directory },
      tool: { async transform(edit: (editor: { add(tool: any): void }) => void) { edit({ add(tool) { tools.push(tool); } }); } },
      session: { async hook(name: string, callback: typeof hook) { assert.equal(name, "context"); hook = callback; } },
    },
  };
}

function result(value: { content?: string }) { return JSON.parse(value.content ?? ""); }

test("OpenCode V2 registers three strict native tools and shared guidance", async t => {
  const root = await repository(); t.after(() => rm(root, { recursive: true, force: true }));
  const fake = context(root); await plugin.setup(fake.value as any);
  assert.deepEqual(fake.tools.map(tool => tool.name), ["knowledge_append", "knowledge_search", "knowledge_get"]);
  for (const tool of fake.tools) assert.equal(tool.input.additionalProperties, false);
  assert.equal("session_id" in fake.tools[0].input.properties, false);

  const event = { sessionID: "open-session", system: [] as { type: string; text: string }[] };
  await fake.hook!(event); await fake.hook!(event);
  assert.equal(event.system.length, 2);
  assert.match(event.system[0].text, /recall relevant durable knowledge/i);
  assert.match(event.system[1].text, /future session/i);
});

test("OpenCode V2 tools use execution session provenance and core operations", async t => {
  const root = await repository(); t.after(() => rm(root, { recursive: true, force: true }));
  const fake = context(root); await plugin.setup(fake.value as any);
  const [append, search, get] = fake.tools;
  const toolContext = { sessionID: "open-session", signal: AbortSignal.abort() };
  const appended = result(await append.execute({
    kind: "decision", summary: "Use DuckDB", source: "conversation",
    facts: [{ subject: "project:opencode", predicate: "uses", object: "tool:duckdb" }],
  }, toolContext));
  assert.equal(appended.ok, true); assert.equal(appended.operation, "append");

  const searched = result(await search.execute({ terms: ["duck"] }, toolContext));
  assert.equal(searched.data.rows[0].session_id, "open-session");

  const fetched = result(await get.execute({ id: appended.data.factIds[0] }, toolContext));
  assert.equal(fetched.data.rows[0].subject, "project:opencode");
});
