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

test("source allowlist and ignored runtime categories exclude generated dependencies", async () => {
  const { stdout } = await exec("git", ["status", "--short", "--untracked-files=all"], { cwd: root });
  const paths = stdout.trimEnd().split("\n").filter(line => line && !line.slice(0, 2).includes("D")).map(line => line.slice(3).split(" -> ").at(-1)!);
  const allowed = /^(?:\.gitignore|package\.json|[^/]+\.md|\.claude-plugin\/.*\.json|claude\/.*\.ts|extensions\/.*\.ts|hooks\/.*\.json|skills\/.*\/SKILL\.md|src\/.*\.ts|test\/.*\.test\.ts|metadata\/duckdb\.json)$/;
  for (const path of paths) assert.match(path, allowed, `source path outside allowlist: ${path}`);

  const ignored = ["knowledge/facts/a.csv", "runtime/duckdb/x/duckdb", "artifact.zip", "duckdb.exe", "cache.duckdb", "query.sql", "writer.lock", "scratch.tmp", ".cache/item", "active-shard.json"];
  const checked = await exec("git", ["check-ignore", "--no-index", "--", ...ignored], { cwd: root });
  assert.deepEqual(checked.stdout.trim().split("\n"), ignored);

  for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "node_modules"]) await assert.rejects(access(join(root, name)));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi, { extensions: ["./extensions/knowledge.ts"], skills: ["./skills"] });
  assert.deepEqual(manifest.peerDependencies, { "@earendil-works/pi-coding-agent": "*", typebox: "*" });
  const plugin = JSON.parse(await readFile(join(root, ".claude-plugin/plugin.json"), "utf8"));
  const marketplace = JSON.parse(await readFile(join(root, ".claude-plugin/marketplace.json"), "utf8"));
  const hooks = JSON.parse(await readFile(join(root, "hooks/hooks.json"), "utf8"));
  assert.equal(plugin.name, "memory-backbone"); assert.equal(marketplace.plugins[0].source, ".");
  assert.match(hooks.hooks.UserPromptSubmit[0].hooks[0].command, /claude\/prompt-hook\.ts/);
  const deleted = new Set((await exec("git", ["ls-files", "--deleted"], { cwd: root })).stdout.trim().split("\n").filter(Boolean));
  const tracked = (await exec("git", ["ls-files"], { cwd: root })).stdout.trim().split("\n").filter(path => path && !deleted.has(path));
  for (const path of tracked) assert.match(path, allowed, `tracked path outside allowlist: ${path}`);
  assert.equal(tracked.some(path => /(?:^|\/)(?:duckdb(?:\.exe)?|.*\.(?:zip|tar|gz|duckdb))$/.test(path)), false);
});

test("extension source has no model, prompt, network, extraction, embedding, or arbitrary-SQL path", async () => {
  const sourceFiles = [...await files(join(root, "src")), ...await files(join(root, "extensions")), ...await files(join(root, "claude"))].filter(path => path.endsWith(".ts"));
  const source = (await Promise.all(sourceFiles.map(path => readFile(path, "utf8")))).join("\n");
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]).filter(path => !path.startsWith(".") && !path.startsWith("node:"));
  assert.deepEqual([...new Set(imports)].sort(), ["@earendil-works/pi-coding-agent", "typebox"]);
  assert.doesNotMatch(source, /(?:generateText|modelClient|sendPrompt|embedding|semanticSearch|extract(?:ion)?Hook|arbitrary.?sql)/i);
  assert.equal(sourceFiles.some(path => relative(root, path).startsWith("runtime/")), false);
});
