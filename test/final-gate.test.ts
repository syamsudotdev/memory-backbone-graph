import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = process.cwd();
async function files(path: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) out.push(...await files(child)); else out.push(child);
  }
  return out;
}

test("requirement matrix has one complete evidence row per FR, NFR, decision, MVP criterion, and ticket", async () => {
  const matrix = await readFile(join(root, "docs/requirements-matrix.md"), "utf8"), lines = matrix.split("\n");
  const verify = (id: string, cells: number) => {
    const rows = lines.filter(line => line.startsWith(`| ${id} |`));
    assert.equal(rows.length, 1, `${id} must have exactly one table row`);
    const values = rows[0].split("|").slice(1, -1).map(value => value.trim());
    assert.equal(values.length, cells, `${id} has the wrong column count`);
    assert.ok(values.every(Boolean), `${id} has an empty evidence cell`);
  };
  for (let i = 1; i <= 39; i++) verify(`FR-${String(i).padStart(3, "0")}`, 3);
  for (let i = 1; i <= 7; i++) verify(`NFR-${String(i).padStart(3, "0")}`, 3);
  for (let i = 1; i <= 27; i++) verify(`D-${String(i).padStart(3, "0")}`, 2);
  for (let i = 1; i <= 17; i++) verify(`MVP-${String(i).padStart(2, "0")}`, 2);
  for (let i = 1; i <= 9; i++) verify(`TICKET-${String(i).padStart(3, "0")}`, 2);
  const manual = await readFile(join(root, "docs/manual-verification.md"), "utf8");
  for (const heading of ["Initial state", "Exact actions", "Expected observable result", "Failure condition", "Actual evidence"]) assert.match(manual, new RegExp(`## ${heading}`));
  assert.match(manual, /KNOWLEDGE_TOOLS=knowledge_append,knowledge_search,knowledge_get/); assert.match(manual, /messageCount: 0/);
});

test("source allowlist and ignored runtime categories exclude generated dependencies", async () => {
  const { stdout } = await exec("git", ["status", "--short", "--untracked-files=all"], { cwd: root });
  const paths = stdout.trim().split("\n").filter(Boolean).map(line => line.slice(3));
  const allowed = /^(?:\.gitignore|[^/]+\.md|docs\/.*\.md|src\/.*\.ts|test\/.*\.test\.ts|metadata\/duckdb\.json|\.pi\/extensions\/.*\.ts)$/;
  for (const path of paths) assert.match(path, allowed, `source path outside allowlist: ${path}`);

  const ignored = ["knowledge/facts/a.csv", "runtime/duckdb/x/duckdb", "artifact.zip", "duckdb.exe", "cache.duckdb", "query.sql", "writer.lock", "scratch.tmp", ".cache/item", "active-shard.json"];
  const checked = await exec("git", ["check-ignore", "--no-index", "--", ...ignored], { cwd: root });
  assert.deepEqual(checked.stdout.trim().split("\n"), ignored);

  for (const name of ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "node_modules"]) await assert.rejects(access(join(root, name)));
  const tracked = (await exec("git", ["ls-files"], { cwd: root })).stdout.trim().split("\n").filter(Boolean);
  for (const path of tracked) assert.match(path, allowed, `tracked path outside allowlist: ${path}`);
  assert.equal(tracked.some(path => /(?:^|\/)(?:duckdb(?:\.exe)?|.*\.(?:zip|tar|gz|duckdb))$/.test(path)), false);
});

test("extension source has no model, prompt, network, extraction, embedding, or arbitrary-SQL path", async () => {
  const sourceFiles = [...await files(join(root, "src")), ...await files(join(root, ".pi/extensions"))].filter(path => path.endsWith(".ts"));
  const source = (await Promise.all(sourceFiles.map(path => readFile(path, "utf8")))).join("\n");
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]).filter(path => !path.startsWith(".") && !path.startsWith("node:"));
  assert.deepEqual([...new Set(imports)].sort(), ["@earendil-works/pi-coding-agent", "typebox"]);
  assert.doesNotMatch(source, /(?:generateText|modelClient|sendPrompt|embedding|semanticSearch|extract(?:ion)?Hook|arbitrary.?sql)/i);
  assert.equal(sourceFiles.some(path => relative(root, path).startsWith("runtime/")), false);
});
