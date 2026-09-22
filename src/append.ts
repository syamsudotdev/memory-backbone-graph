import { copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { COLUMNS, canonicalKeyParts, deriveAgentId, encodeCsv, factFingerprint, generateId, readRecords, shardPath, utcTimestamp, validateKind, validatePredicate, validateRecord } from "./records.ts";
import type { CsvRecord, Dataset } from "./records.ts";
import { MAX_FACTS_PER_APPEND, MAX_KEY_BYTES, MAX_TEXT_BYTES, rejectSecrets, validateRequestByteLength, validateText } from "./safety.ts";
import { KnowledgeError, knowledgeError } from "./errors.ts";

export type AppendFact = { subject: string; predicate: string; object: string; evidence?: string; supersedes?: string };
export type AppendRequest = { sessionId: string; kind: string; summary: string; source: string; evidence?: string; facts: AppendFact[] };
export type AppendResult = { episodeId: string; factIds: string[]; changedPaths: string[]; retry: boolean; agentId: string; timestamp: string };
export type AppendOptions = { agentId?: string; now?: Date; env?: NodeJS.ProcessEnv; fault?: (phase: string, index?: number) => void | Promise<void>; preWrite?: () => void | Promise<void>; downstream?: (result: AppendResult) => void | Promise<void> };
type Change = { path: string; prepared: string; backup: string; existed: boolean };
type Manifest = { phase: "prepared" | "replacing" | "complete"; replaced: number; changes: Change[] };
const datasets: Dataset[] = ["entities", "episodes", "facts"];
const requestFields = new Set(["sessionId", "kind", "summary", "source", "evidence", "facts"]);
const factFields = new Set(["subject", "predicate", "object", "evidence", "supersedes"]);

function inside(root: string, path: string): string { const full = resolve(root, path), prefix = resolve(root) + sep; if (!full.startsWith(prefix)) throw new Error("path escapes project root"); return full; }
async function exists(path: string) { try { await stat(path); return true; } catch (e: any) { if (e.code === "ENOENT") return false; throw e; } }
export async function rejectSymlinks(root: string, path: string) {
  const base = resolve(root), full = resolve(path); if (full !== base && !full.startsWith(base + sep)) throw new Error("path escapes project root");
  let current = base;
  for (const part of relative(base, full).split(sep).filter(Boolean)) { current = join(current, part); try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`symlink traversal rejected: ${relative(base, current)}`); } catch (e: any) { if (e.code === "ENOENT") return; throw e; } }
}
async function syncDir(path: string) {
  let dir; try { dir = await open(path, "r"); await dir.sync(); }
  catch (e: any) { throw new Error(`durable directory sync unsupported for ${path}: ${e.code ?? e.message}`, { cause: e }); }
  finally { await dir?.close(); }
}
async function ensureDir(root: string, path: string) { const base = resolve(root); await rejectSymlinks(root, path); let current = base; for (const part of relative(base, resolve(path)).split(sep).filter(Boolean)) { const parent = current; current = join(current, part); if (!await exists(current)) { try { await mkdir(current); await syncDir(parent); } catch (e: any) { if (e.code !== "EEXIST") throw e; } } await rejectSymlinks(root, current); } }
async function durableWrite(root: string, path: string, bytes: string) {
  await rejectSymlinks(root, path); await ensureDir(root, dirname(path)); const file = await open(path, "w");
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await syncDir(dirname(path));
}
async function durableRemove(path: string) { const parent = dirname(path); if (await exists(path)) { await rm(path, { recursive: true, force: true }); await syncDir(parent); } }
async function durableRename(from: string, to: string) { await rename(from, to); await syncDir(dirname(to)); if (dirname(from) !== dirname(to)) await syncDir(dirname(from)); }
function rowLimit(env: NodeJS.ProcessEnv): number { const raw = env.MBG_SHARD_ROW_LIMIT; if (raw === undefined) return 10000; const n = Number(raw); if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw new Error("MBG_SHARD_ROW_LIMIT must be an integer from 1 to 1000000"); return n; }

async function filesUnder(root: string, path: string): Promise<string[]> { await rejectSymlinks(root, path); if (!await exists(path)) return []; const out: string[] = []; for (const entry of await readdir(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isSymbolicLink()) throw new Error(`symlink traversal rejected: ${relative(root, child)}`); if (entry.isDirectory()) out.push(...await filesUnder(root, child)); else if (entry.name.endsWith(".csv")) out.push(child); } return out.sort(); }
async function loadAll(root: string) { const rows = { entities: [] as CsvRecord[], episodes: [] as CsvRecord[], facts: [] as CsvRecord[] }; for (const dataset of datasets) for (const file of await filesUnder(root, join(root, "knowledge", dataset))) rows[dataset].push(...readRecords(dataset, await readFile(file, "utf8"))); const ids = new Set<string>(); for (const dataset of datasets) for (const row of rows[dataset]) { const id = row[dataset === "entities" ? "entity_id" : dataset === "episodes" ? "episode_id" : "fact_id"]; if (ids.has(id)) throw new Error(`duplicate primary ID: ${id}`); ids.add(id); } return { rows, ids }; }
function activeFacts(facts: CsvRecord[]) { const superseded = new Set(facts.map(f => f.supersedes).filter(Boolean)); return facts.filter(f => !superseded.has(f.fact_id)); }

export async function acquireProjectLock(root: string) {
  const runtime = join(root, "runtime"), lockPath = join(runtime, "knowledge-writer.lock"); await ensureDir(root, runtime); const until = Date.now() + 15000;
  while (true) {
    const temporary = join(runtime, `.knowledge-writer-${process.pid}-${randomUUID()}.tmp`); let file, acquired = false;
    try { await rejectSymlinks(root, lockPath); file = await open(temporary, "wx"); await file.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), createdAt: new Date().toISOString() })); await file.sync(); await file.close(); file = undefined; await link(temporary, lockPath); acquired = true; await syncDir(runtime); await unlink(temporary); await syncDir(runtime); return async () => { await unlink(lockPath); await syncDir(runtime); }; }
    catch (e: any) {
      await file?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); if (acquired) { await rm(lockPath, { force: true }).catch(() => {}); await syncDir(runtime).catch(() => {}); }
      if (e.code !== "EEXIST") throw e;
      try { const owner = JSON.parse(await readFile(lockPath, "utf8")); if (owner.host === hostname() && Number.isInteger(owner.pid)) try { process.kill(owner.pid, 0); } catch (kill: any) { if (kill.code === "ESRCH") { await unlink(lockPath); await syncDir(runtime); continue; } } } catch { /* incomplete or foreign ownership is never reclaimed */ }
      if (Date.now() >= until) throw new KnowledgeError("lock", `writer lock busy: ${lockPath}`); await new Promise(r => setTimeout(r, 20));
    }
  }
}

export async function recoverAppend(root: string, fault?: AppendOptions["fault"]): Promise<void> {
  const txDir = join(root, "runtime", "append-transaction"), manifestPath = join(txDir, "manifest.json"); await rejectSymlinks(root, manifestPath); if (!await exists(manifestPath)) return;
  const manifest: Manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.phase !== "complete") for (let i = 0; i < manifest.changes.length; i++) { const change = manifest.changes[i], target = inside(root, change.path); await rejectSymlinks(root, target); if (change.existed) { const backup = inside(root, change.backup), rollback = join(txDir, `${i}.rollback`); await rejectSymlinks(root, backup); await rejectSymlinks(root, rollback); await copyFile(backup, rollback); const file = await open(rollback, "r+"); try { await file.sync(); } finally { await file.close(); } await syncDir(txDir); await ensureDir(root, dirname(target)); await durableRename(rollback, target); } else { await durableRemove(target); } await fault?.("recovery", i); }
  await durableRemove(txDir);
}

function validateRequest(request: AppendRequest) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("invalid request");
  for (const field of Object.keys(request)) if (!requestFields.has(field)) throw new Error(`unknown request field: ${field}`);
  if (!Array.isArray(request.facts) || !request.facts.length || request.facts.length > MAX_FACTS_PER_APPEND) throw new Error(`facts must contain 1 to ${MAX_FACTS_PER_APPEND} items`);
  let serialized: string; try { serialized = JSON.stringify(request); } catch { throw new Error("invalid request"); }
  validateRequestByteLength(Buffer.byteLength(serialized, "utf8"));
  const episodeValues = [
    validateText(request.sessionId, "sessionId"),
    validateKind(request.kind),
    validateText(request.summary, "summary", { multiline: true, maxBytes: MAX_TEXT_BYTES }),
    validateText(request.source, "source"),
    validateText(request.evidence, "evidence", { optional: true, multiline: true, maxBytes: MAX_TEXT_BYTES }),
  ];
  const secretValues = [...episodeValues];
  for (const fact of request.facts) {
    if (!fact || typeof fact !== "object" || Array.isArray(fact)) throw new Error("invalid fact");
    for (const field of Object.keys(fact)) if (!factFields.has(field)) throw new Error(`unknown fact field: ${field}`);
    const subject = validateText(fact.subject, "subject", { maxBytes: MAX_KEY_BYTES }), predicate = validatePredicate(fact.predicate), object = validateText(fact.object, "object", { maxBytes: MAX_KEY_BYTES });
    const evidence = validateText(fact.evidence, "evidence", { optional: true, multiline: true, maxBytes: MAX_TEXT_BYTES }), supersedes = validateText(fact.supersedes, "supersedes", { optional: true });
    canonicalKeyParts(subject); canonicalKeyParts(object); factFingerprint(subject, predicate, object); secretValues.push(subject, predicate, object, evidence, supersedes);
  }
  rejectSecrets(secretValues);
}
async function chooseShard(root: string, dataset: Dataset, agent: string, now: Date, add: number, limit: number) { const month = now.toISOString().slice(0, 7), dir = join(root, "knowledge", dataset, agent, month); await rejectSymlinks(root, dir); const names = (await exists(dir) ? await readdir(dir) : []).filter(n => /^\d{4}\.csv$/.test(n)).sort(); let sequence = names.length ? Number(names.at(-1)!.slice(0, 4)) : 1, path = shardPath(dataset, agent, now, sequence), old: CsvRecord[] = []; if (await exists(join(root, path))) old = readRecords(dataset, await readFile(join(root, path), "utf8")); if (old.length && old.length + add > limit) { sequence++; path = shardPath(dataset, agent, now, sequence); old = []; } return { path, old }; }
function exactRetry(request: AppendRequest, agent: string, facts: CsvRecord[], episodes: CsvRecord[]) { const episode = episodes.find(e => e.episode_id === facts[0].episode_id); if (!episode || facts.some(f => f.episode_id !== episode.episode_id)) return false; if (episode.agent_id !== agent || episode.session_id !== request.sessionId || episode.kind !== request.kind || episode.summary !== request.summary || episode.source !== request.source || episode.evidence !== (request.evidence ?? "")) return false; return request.facts.every((input, i) => { const fact = facts[i]; return fact.subject === input.subject && fact.predicate === input.predicate && fact.object === input.object && fact.evidence === (input.evidence ?? "") && fact.supersedes === (input.supersedes ?? ""); }); }

export async function appendKnowledge(root: string, request: AppendRequest, options: AppendOptions = {}): Promise<AppendResult> {
  try { validateRequest(request); } catch (error) { throw knowledgeError("validation", error); }
  let limit: number; try { limit = rowLimit(options.env ?? process.env); } catch (error) { throw knowledgeError("validation", error); }
  const agentId = options.agentId ?? deriveAgentId(), now = options.now ?? new Date(), timestamp = utcTimestamp(now); await rejectSymlinks(root, join(root, "knowledge")); await rejectSymlinks(root, join(root, "runtime")); const release = await acquireProjectLock(root);
  try {
    await options.preWrite?.();
    await recoverAppend(root, options.fault); const { rows, ids } = await loadAll(root), active = activeFacts(rows.facts), fingerprints = request.facts.map(f => factFingerprint(f.subject, f.predicate, f.object)); if (new Set(fingerprints).size !== fingerprints.length) throw new KnowledgeError("duplicate", "request contains duplicate active triples"); const existing = fingerprints.map(fp => active.find(f => f.fingerprint === fp));
    if (existing.every(Boolean)) { const found = existing as CsvRecord[]; if (!exactRetry(request, agentId, found, rows.episodes)) throw new KnowledgeError("duplicate", "duplicate active triple"); const result = { episodeId: found[0].episode_id, factIds: found.map(f => f.fact_id), changedPaths: [], retry: true, agentId, timestamp: found[0].created_at }; await options.downstream?.(result); return result; }
    if (existing.some(Boolean)) throw new KnowledgeError("duplicate", "duplicate active triple"); for (const input of request.facts) if (input.supersedes) { const old = active.find(f => f.fact_id === input.supersedes); if (!old || old.subject !== input.subject || old.predicate !== input.predicate) throw new KnowledgeError("validation", "supersedes must name an active fact with the same subject and predicate"); }
    const episodeId = generateId("episodes", ids); ids.add(episodeId); const episode: CsvRecord = { schema_version: "1", episode_id: episodeId, created_at: timestamp, agent_id: agentId, session_id: request.sessionId, kind: request.kind, summary: request.summary, source: request.source, evidence: request.evidence ?? "" }; validateRecord("episodes", episode);
    const facts = request.facts.map(input => { const fact_id = generateId("facts", ids); ids.add(fact_id); const row: CsvRecord = { schema_version: "1", fact_id, subject: input.subject, predicate: input.predicate, object: input.object, episode_id: episodeId, created_at: timestamp, evidence: input.evidence ?? "", supersedes: input.supersedes ?? "", fingerprint: factFingerprint(input.subject, input.predicate, input.object) }; validateRecord("facts", row); return row; });
    const known = new Set(rows.entities.map(e => e.canonical_key)), entities: CsvRecord[] = []; for (const key of request.facts.flatMap(f => [f.subject, f.object])) if (!known.has(key)) { known.add(key); const [type, name] = canonicalKeyParts(key), entity_id = generateId("entities", ids); ids.add(entity_id); const row = { schema_version: "1", entity_id, type, name, canonical_key: key, created_at: timestamp }; validateRecord("entities", row); entities.push(row); }
    const additions: Record<Dataset, CsvRecord[]> = { entities, episodes: [episode], facts }, txDir = join(root, "runtime", "append-transaction"); await durableRemove(txDir); await ensureDir(root, txDir); await syncDir(dirname(txDir)); const changes: Change[] = [];
    for (const dataset of datasets) if (additions[dataset].length) { const selected = await chooseShard(root, dataset, agentId, now, additions[dataset].length, limit), target = join(root, selected.path), i = changes.length, prepared = relative(root, join(txDir, `${i}.new`)), backup = relative(root, join(txDir, `${i}.bak`)), existed = await exists(target); await durableWrite(root, inside(root, prepared), encodeCsv(COLUMNS[dataset], [...selected.old, ...additions[dataset]])); if (existed) await durableWrite(root, inside(root, backup), await readFile(target, "utf8")); changes.push({ path: selected.path, prepared, backup, existed }); }
    const manifestPath = join(txDir, "manifest.json"); let manifest: Manifest = { phase: "prepared", replaced: 0, changes }; await durableWrite(root, manifestPath, JSON.stringify(manifest)); await options.fault?.("prepared"); manifest.phase = "replacing"; await durableWrite(root, manifestPath, JSON.stringify(manifest)); await options.fault?.("replacing");
    try { for (let i = 0; i < changes.length; i++) { const c = changes[i], target = inside(root, c.path), prepared = inside(root, c.prepared); await rejectSymlinks(root, prepared); await ensureDir(root, dirname(target)); await durableRename(prepared, target); manifest.replaced = i + 1; await durableWrite(root, manifestPath, JSON.stringify(manifest)); await options.fault?.("replaced", i); } } catch (error) { await recoverAppend(root); throw error; }
    manifest.phase = "complete"; await durableWrite(root, manifestPath, JSON.stringify(manifest)); await options.fault?.("complete"); await durableRemove(txDir); await durableWrite(root, join(root, "runtime", "active-shards.json"), JSON.stringify(Object.fromEntries(changes.map(c => [c.path.split("/")[1], c.path])))); const result = { episodeId, factIds: facts.map(f => f.fact_id), changedPaths: changes.map(c => c.path), retry: false, agentId, timestamp }; await options.downstream?.(result); return result;
  } finally { await release(); }
}
