import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { rejectSymlinks } from "./append.ts";
import { ensureDuckDB } from "./duckdb.ts";
import { resolveProjectGit } from "./git.ts";
import { COLUMNS, isPrefixedUuid, isUtcTimestamp, readRecords } from "./records.ts";
import type { CsvRecord, Dataset } from "./records.ts";
import { KnowledgeError, knowledgeError } from "./errors.ts";

const exec = promisify(execFile);
const DATASETS: Dataset[] = ["entities", "episodes", "facts"];
export type SearchFilters = { terms?: string[]; subject?: string; predicate?: string; object?: string; kind?: string; agent_id?: string; session_id?: string; from?: string; to?: string; limit?: number; history?: boolean };
export type QueryResult = { rows: Record<string, unknown>[]; partial: boolean; omittedShards: string[] };
export type QueryOptions = { duckdbPath?: string; extensionDir?: string; env?: NodeJS.ProcessEnv };
type Loaded = { dataset: Dataset; path: string; rows: CsvRecord[] };

function literal(value: string) { return `'${value.replaceAll("'", "''")}'`; }
function likeLiteral(value: string) { return literal(`%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`); }
function value(input: unknown, name: string) { if (typeof input !== "string" || input.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input)) throw new Error(`invalid ${name}`); return input; }
function timestamp(input: unknown, name: string) { const text = value(input, name); if (!isUtcTimestamp(text)) throw new Error(`invalid ${name}`); return text; }
function empty(dataset: Dataset) { return `SELECT ${COLUMNS[dataset].map(c => `CAST(NULL AS VARCHAR) AS "${c}"`).join(",")} WHERE false`; }
function readRelation(dataset: Dataset, paths: string[]) { return paths.length ? `SELECT * FROM read_csv([${paths.map(literal).join(",")}], header=true, all_varchar=true, union_by_name=true)` : empty(dataset); }
async function run(path: string, sql: string, env: NodeJS.ProcessEnv) {
  try {
    const { stdout, stderr } = await exec(path, ["-json", "-c", sql], { shell: false, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    if (stderr) throw new Error(`DuckDB query failed: ${stderr.trim()}`);
    const parsed: unknown = JSON.parse(stdout || "[]");
    if (!Array.isArray(parsed) || parsed.some(row => row === null || typeof row !== "object" || Array.isArray(row) || Object.getPrototypeOf(row) !== Object.prototype)) throw new Error("DuckDB returned invalid JSON rows");
    return parsed as Record<string, unknown>[];
  } catch (error) { throw knowledgeError("dependency", error, true); }
}
async function shardPaths(root: string, dataset: Dataset) {
  const base = join(root, "knowledge", dataset), out: string[] = []; await rejectSymlinks(root, join(root, "knowledge")); await rejectSymlinks(root, base);
  async function walk(path: string): Promise<void> { await rejectSymlinks(root, path); let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch (e: any) { if (e.code === "ENOENT") return; throw e; } for (const entry of entries) { const child = join(path, entry.name); await rejectSymlinks(root, child); if (entry.isSymbolicLink()) throw new Error(`symlink traversal rejected: ${relative(root, child)}`); if (entry.isDirectory()) await walk(child); else if (entry.name.endsWith(".csv")) out.push(child); } }
  await walk(base); return out.sort();
}
function idOf(item: Loaded, row: CsvRecord) { return row[item.dataset === "entities" ? "entity_id" : item.dataset === "episodes" ? "episode_id" : "fact_id"]; }
function cyclic(fact: CsvRecord, byId: Map<string, CsvRecord>) { const seen = new Set<string>(); let row: CsvRecord | undefined = fact; while (row?.supersedes) { if (seen.has(row.fact_id)) return true; seen.add(row.fact_id); row = byId.get(row.supersedes); } return false; }
async function validatedShards(root: string) {
  const loaded: Loaded[] = [], omitted = new Set<string>();
  for (const dataset of DATASETS) for (const path of await shardPaths(root, dataset)) try { await rejectSymlinks(root, path); loaded.push({ dataset, path, rows: readRecords(dataset, await readFile(path, "utf8")) }); } catch { omitted.add(path); }
  let retained = loaded.filter(item => !omitted.has(item.path));
  while (true) {
    const bad = new Set<string>(), ids = new Map<string, Loaded[]>();
    for (const item of retained) for (const row of item.rows) { const id = idOf(item, row); const owners = ids.get(id) ?? []; owners.push(item); ids.set(id, owners); }
    for (const owners of ids.values()) if (owners.length > 1) for (const owner of owners) bad.add(owner.path);
    const episodes = new Set(retained.filter(x => x.dataset === "episodes").flatMap(x => x.rows.map(r => r.episode_id)));
    const factItems = retained.filter(x => x.dataset === "facts"), facts = factItems.flatMap(x => x.rows), byId = new Map(facts.map(f => [f.fact_id, f]));
    for (const item of factItems) for (const fact of item.rows) {
      if (!episodes.has(fact.episode_id)) bad.add(item.path);
      if (fact.supersedes) { const old = byId.get(fact.supersedes); if (!old || old.subject !== fact.subject || old.predicate !== fact.predicate || Date.parse(fact.created_at) < Date.parse(old.created_at) || cyclic(fact, byId)) bad.add(item.path); }
    }
    if (!bad.size) break; for (const path of bad) omitted.add(path); retained = retained.filter(item => !bad.has(item.path));
  }
  return { valid: Object.fromEntries(DATASETS.map(dataset => [dataset, retained.filter(x => x.dataset === dataset).map(x => x.path)])) as Record<Dataset, string[]>, omitted: [...omitted].sort().map(path => relative(root, path).split(sep).join("/")) };
}
async function prepare(root: string, options: QueryOptions) {
  const env = options.env ?? process.env;
  let duckdb: string; try { duckdb = options.duckdbPath ?? await ensureDuckDB({ extensionDir: options.extensionDir, env }); } catch (error) { throw knowledgeError("bootstrap", error, true); }
  const checked = await validatedShards(root);
  const views = DATASETS.map(dataset => `CREATE TEMP VIEW ${dataset} AS ${readRelation(dataset, checked.valid[dataset])};`).join("\n") + `
CREATE TEMP VIEW current_facts AS SELECT f.* FROM facts f WHERE NOT EXISTS (SELECT 1 FROM facts n WHERE n.supersedes=f.fact_id AND n.subject=f.subject AND n.predicate=f.predicate);
CREATE TEMP VIEW fact_history AS SELECT * FROM facts;`;
  return { duckdb, env, views, omitted: checked.omitted };
}
function clauses(filters: SearchFilters) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw new Error("invalid filters");
  const allowed = new Set(["terms", "subject", "predicate", "object", "kind", "agent_id", "session_id", "from", "to", "limit", "history"]); for (const key of Object.keys(filters)) if (!allowed.has(key)) throw new Error(`unknown filter: ${key}`);
  if (filters.history !== undefined && typeof filters.history !== "boolean") throw new Error("history must be boolean");
  const where: string[] = [];
  for (const key of ["subject", "predicate", "object"] as const) if (filters[key] !== undefined) where.push(`f.${key}=${literal(value(filters[key], key))}`);
  for (const key of ["kind", "agent_id", "session_id"] as const) if (filters[key] !== undefined) where.push(`e.${key}=${literal(value(filters[key], key))}`);
  if (filters.from !== undefined) where.push(`CAST(f.created_at AS TIMESTAMP)>=CAST(${literal(timestamp(filters.from, "from"))} AS TIMESTAMP)`); if (filters.to !== undefined) where.push(`CAST(f.created_at AS TIMESTAMP)<=CAST(${literal(timestamp(filters.to, "to"))} AS TIMESTAMP)`);
  if (filters.terms !== undefined) { if (!Array.isArray(filters.terms) || filters.terms.length > 20) throw new Error("invalid terms"); for (const term of filters.terms) where.push(`lower(concat_ws(' ',f.subject,f.predicate,f.object,f.evidence,f.tags,e.summary,e.source,e.evidence,e.tags)) LIKE ${likeLiteral(value(term, "term").toLowerCase())} ESCAPE '\\'`); }
  const limit = filters.limit ?? 20; if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 to 100"); return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", limit };
}
async function project(cwd: string) { return (await resolveProjectGit(cwd)).root; }
/** Terms are ANDed, case-insensitive literal substrings over fact and episode text. */
export async function searchKnowledge(cwd: string, filters: SearchFilters = {}, options: QueryOptions = {}): Promise<QueryResult> {
  let filter: ReturnType<typeof clauses>; try { filter = clauses(filters); } catch (error) { throw knowledgeError("validation", error); }
  const root = await project(cwd), p = await prepare(root, options), relation = filters.history ? "fact_history" : "current_facts", sql = `${p.views}\nSELECT f.*,e.agent_id,e.session_id,e.kind,e.summary,e.source,e.evidence AS episode_evidence,e.tags AS episode_tags FROM ${relation} f LEFT JOIN episodes e USING (episode_id) ${filter.where} ORDER BY f.created_at,f.fact_id LIMIT ${filter.limit};`;
  return { rows: await run(p.duckdb, sql, p.env), partial: p.omitted.length > 0, omittedShards: p.omitted };
}
export async function getKnowledge(cwd: string, id: string, options: QueryOptions = {}): Promise<QueryResult> {
  try { value(id, "id"); } catch (error) { throw knowledgeError("validation", error); }
  const kind = id.startsWith("fact_") ? "fact" : id.startsWith("ep_") ? "episode" : id.startsWith("ent_") ? "entity" : undefined, prefix = kind === "fact" ? "fact_" : kind === "episode" ? "ep_" : "ent_"; if (!kind || !isPrefixedUuid(id, prefix)) throw new KnowledgeError("validation", "invalid stable ID");
  const root = await project(cwd), p = await prepare(root, options), encodedId = literal(id), query = kind === "fact" ? "SELECT f.*,e.agent_id,e.session_id,e.kind,e.summary,e.source,e.evidence AS episode_evidence,e.tags AS episode_tags FROM facts f LEFT JOIN episodes e USING (episode_id) WHERE f.fact_id=" + encodedId + " LIMIT 1" : kind === "episode" ? "SELECT * FROM episodes WHERE episode_id=" + encodedId + " LIMIT 1" : "SELECT * FROM entities WHERE entity_id=" + encodedId + " LIMIT 1";
  return { rows: await run(p.duckdb, p.views + "\n" + query + ";", p.env), partial: p.omitted.length > 0, omittedShards: p.omitted };
}
