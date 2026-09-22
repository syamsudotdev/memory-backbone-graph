import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { appendKnowledge } from "./append.ts";
import { deriveAgentId } from "./records.ts";
import type { AppendOptions, AppendRequest, AppendResult } from "./append.ts";
import { KnowledgeError, knowledgeError } from "./errors.ts";

const exec = promisify(execFile);
const zeroOid = "0".repeat(40);

type GitStart = { root: string; ref: string; branch: string; oid?: string };
type Pending = { phase: "intent"; key: string; paths: string[] };
type GitAppendOptions = AppendOptions & { gitFault?: (phase: "pending-intent" | "updated-ref" | "pending-cleanup") => void | Promise<void> };
export type GitAppendResult = AppendResult & { commitOid?: string };

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  try { return (await exec("git", args, { cwd, env: { ...process.env, ...env } })).stdout.trim(); }
  catch (cause: any) { throw new Error(`git ${args[0]} failed: ${(cause.stderr || cause.message).trim()}`, { cause }); }
}
async function syncDir(path: string) { const file = await open(path, "r"); try { await file.sync(); } finally { await file.close(); } }
async function durablePending(path: string, pending: Pending) { const file = await open(path, "w"); try { await file.writeFile(JSON.stringify(pending)); await file.sync(); } finally { await file.close(); } await syncDir(dirname(path)); }
async function cleanPending(path: string) { try { await unlink(path); await syncDir(dirname(path)); } catch (error: any) { if (error.code !== "ENOENT") throw error; } }

export async function resolveProjectGit(cwd: string): Promise<GitStart> {
  let root: string;
  try { root = await git(cwd, ["rev-parse", "--show-toplevel"]); }
  catch (cause) { throw new KnowledgeError("setup", `no Git project found from ${cwd}`, { cause }); }
  let ref: string;
  try { ref = await git(root, ["symbolic-ref", "-q", "HEAD"]); }
  catch (cause) { throw new KnowledgeError("setup", "detached HEAD is not a current branch", { cause }); }
  if (!ref.startsWith("refs/heads/")) throw new KnowledgeError("setup", "detached HEAD is not a current branch");
  let oid: string | undefined;
  try { oid = await git(root, ["rev-parse", "--verify", "HEAD"]); } catch { oid = undefined; }
  return { root: resolve(root), ref, branch: ref.slice("refs/heads/".length), oid };
}

function safePaths(root: string, paths: string[]) {
  return [...new Set(paths)].map(path => {
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error(`changed path escapes knowledge directory: ${path}`);
    const full = resolve(root, path), knowledge = resolve(root, "knowledge");
    if (full === knowledge || !full.startsWith(knowledge + sep)) throw new Error(`changed path escapes knowledge directory: ${path}`);
    return relative(root, full).split(sep).join("/");
  });
}

export async function commitKnowledge(start: GitStart, paths: string[], count: number, agentId: string, episodeId: string, sessionId: string, key = "", afterUpdate?: () => void | Promise<void>): Promise<string> {
  const exact = safePaths(start.root, paths);
  if (!exact.length) throw new Error("no knowledge paths to commit");
  const dir = await mkdtemp(`${tmpdir()}${sep}knowledge-index-`), index = `${dir}${sep}index`, env = { GIT_INDEX_FILE: index };
  try {
    await git(start.root, start.oid ? ["read-tree", start.oid] : ["read-tree", "--empty"], env);
    await git(start.root, ["add", "--", ...exact], env);
    const tree = await git(start.root, ["write-tree"], env);
    const message = `knowledge: append ${count} facts from ${agentId}\n\nEpisode-ID: ${episodeId}\nSession-ID: ${sessionId}${key ? `\nRequest-Key: ${key}` : ""}`;
    const commit = await git(start.root, ["commit-tree", tree, ...(start.oid ? ["-p", start.oid] : []), "-m", message], env);
    const currentRef = await git(start.root, ["symbolic-ref", "-q", "HEAD"]);
    if (currentRef !== start.ref) throw new Error(`current branch changed from ${start.branch}; knowledge remains uncommitted`);
    try { await git(start.root, ["update-ref", start.ref, commit, start.oid ?? zeroOid]); }
    catch (cause) { throw new Error(`branch moved concurrently; knowledge remains uncommitted at: ${exact.join(", ")}`, { cause }); }
    await afterUpdate?.();
    return commit;
  } catch (cause: any) {
    if (cause instanceof KnowledgeError) throw cause;
    throw new KnowledgeError("git", `knowledge commit failed; valid files remain uncommitted at: ${exact.join(", ")}. Retry the append after fixing Git configuration. ${cause.message}`, { cause });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function requestKey(request: AppendRequest, agentId?: string) { return createHash("sha256").update(JSON.stringify([agentId ?? "", request])).digest("hex"); }
async function reachableCommitWithKey(root: string, ref: string, key: string) {
  try { return (await git(root, ["log", ref, "--format=%H", "--extended-regexp", `--grep=^Request-Key: ${key}$`])).split("\n").find(Boolean); }
  catch { return undefined; }
}
async function readPending(path: string): Promise<Pending | undefined> { try { const pending = JSON.parse(await readFile(path, "utf8")); if (pending.phase !== "intent" || typeof pending.key !== "string" || !Array.isArray(pending.paths)) throw new Error("invalid pending knowledge commit state"); return pending; } catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; } }

export async function appendKnowledgeWithGit(cwd: string, request: AppendRequest, options: GitAppendOptions = {}): Promise<GitAppendResult> {
  const located = await resolveProjectGit(cwd), agentId = options.agentId ?? deriveAgentId(), pendingPath = resolve(located.root, "runtime", "pending-knowledge-commit.json"), key = requestKey(request, agentId);
  let start: GitStart, commitOid: string | undefined, pending: Pending | undefined;
  const { downstream, gitFault, ...appendOptions } = options;
  const result = await appendKnowledge(located.root, request, { ...appendOptions, agentId,
    preWrite: async () => {
      start = await resolveProjectGit(located.root); if (start.root !== located.root) throw new Error("Git project root changed");
      pending = await readPending(pendingPath);
      if (pending) {
        const completed = await reachableCommitWithKey(located.root, start.ref, pending.key);
        if (completed) { await cleanPending(pendingPath); pending = undefined; }
        else if (pending.key !== key) throw new KnowledgeError("lock", `pending knowledge commit ${pending.key} must be retried before a different append`);
      }
      await options.preWrite?.();
    },
    downstream: async result => {
      const completed = result.retry && await reachableCommitWithKey(located.root, start.ref, key);
      if (completed) { commitOid = completed; await gitFault?.("pending-cleanup"); await cleanPending(pendingPath); await downstream?.(result); return; }
      let paths = result.changedPaths;
      if (result.retry && !paths.length && pending?.key === key) paths = pending.paths;
      if (paths.length) {
        if (!pending) { await durablePending(pendingPath, { phase: "intent", key, paths }); pending = { phase: "intent", key, paths }; }
        await gitFault?.("pending-intent");
        commitOid = await commitKnowledge(start, paths, request.facts.length, result.agentId, result.episodeId, request.sessionId, key, () => gitFault?.("updated-ref"));
        await gitFault?.("pending-cleanup"); await cleanPending(pendingPath); pending = undefined;
      }
      await downstream?.(result);
    }
  });
  return { ...result, commitOid };
}
