import { createHash, randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { posix } from "node:path";
import { MAX_KEY_BYTES, MAX_TEXT_BYTES, rejectSecrets, validateCsvByteLength, validateText } from "./safety.ts";

export const SCHEMA_VERSION = "1";
export type Dataset = "entities" | "episodes" | "facts";

export const COLUMNS: Record<Dataset, readonly string[]> = {
  entities: ["schema_version", "entity_id", "type", "name", "canonical_key", "created_at"],
  episodes: ["schema_version", "episode_id", "created_at", "agent_id", "session_id", "kind", "summary", "source", "evidence", "tags"],
  facts: ["schema_version", "fact_id", "subject", "predicate", "object", "episode_id", "created_at", "evidence", "supersedes", "tags", "fingerprint"],
};

const REQUIRED: Record<Dataset, readonly string[]> = {
  entities: ["entity_id", "type", "name", "canonical_key", "created_at"],
  episodes: ["episode_id", "created_at", "agent_id", "session_id", "kind", "summary", "source"],
  facts: ["fact_id", "subject", "predicate", "object", "episode_id", "created_at", "supersedes"],
};
const DEFAULTS: Record<string, string> = { schema_version: SCHEMA_VERSION, evidence: "", tags: "", fingerprint: "" };
const PREFIX = { entities: "ent_", episodes: "ep_", facts: "fact_" } as const;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export type CsvRecord = Record<string, string>;

export function encodeCsv(columns: readonly string[], rows: readonly CsvRecord[]): string {
  const quote = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return [columns, ...rows.map(row => columns.map(column => row[column] ?? ""))]
    .map(row => row.map(quote).join(",")).join("\r\n") + "\r\n";
}

export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [], row: string[] = [];
  let field = "", quoted = false, afterQuote = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else field += char;
    } else if (afterQuote) {
      if (char === ",") { row.push(field); field = ""; afterQuote = false; }
      else if (char === "\r" || char === "\n") { row.push(field); rows.push(row.splice(0)); field = ""; afterQuote = false; if (char === "\r" && csv[i + 1] === "\n") i++; }
      else throw new Error("invalid character after closing CSV quote");
    } else if (char === '"') {
      if (field) throw new Error("CSV quote must begin a field");
      quoted = true;
    } else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\r" || char === "\n") { row.push(field); rows.push(row.splice(0)); field = ""; if (char === "\r" && csv[i + 1] === "\n") i++; }
    else field += char;
  }
  if (quoted) throw new Error("unterminated CSV quote");
  if (afterQuote || field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function readRecords(dataset: Dataset, csv: string, maxBytes?: number): CsvRecord[] {
  validateCsvByteLength(Buffer.byteLength(csv, "utf8"), maxBytes);
  const [header, ...values] = parseCsv(csv);
  if (!header || header.length === 0 || new Set(header).size !== header.length) throw new Error("invalid CSV header");
  for (const column of REQUIRED[dataset]) if (!header.includes(column)) throw new Error(`missing required column: ${column}`);
  const ids = new Set<string>();
  return values.map((fields, index) => {
    if (fields.length !== header.length) throw new Error(`row ${index + 2} has ${fields.length} fields; expected ${header.length}`);
    const record = Object.fromEntries(header.map((column, i) => [column, fields[i]]));
    for (const column of COLUMNS[dataset]) record[column] ??= DEFAULTS[column] ?? "";
    if (dataset === "facts" && !record.fingerprint) {
      validateText(record.subject, "subject", { maxBytes: MAX_KEY_BYTES }); validateText(record.predicate, "predicate", { maxBytes: MAX_KEY_BYTES }); validateText(record.object, "object", { maxBytes: MAX_KEY_BYTES });
      record.fingerprint = factFingerprint(record.subject, record.predicate, record.object);
    }
    validateRecord(dataset, record);
    const id = record[dataset === "entities" ? "entity_id" : dataset === "episodes" ? "episode_id" : "fact_id"];
    if (ids.has(id)) throw new Error(`duplicate primary ID: ${id}`);
    ids.add(id);
    return record;
  });
}

export function validateRecord(dataset: Dataset, record: CsvRecord): void {
  for (const column of REQUIRED[dataset]) if (record[column] === undefined || (column !== "supersedes" && record[column] === "")) throw new Error(`missing required value: ${column}`);
  for (const column of COLUMNS[dataset]) validateText(record[column], column, { optional: column === "supersedes" || !REQUIRED[dataset].includes(column), multiline: column === "summary" || column === "evidence", maxBytes: column === "summary" || column === "evidence" ? MAX_TEXT_BYTES : MAX_KEY_BYTES });
  if (record.schema_version !== SCHEMA_VERSION) throw new Error(`unsupported schema version: ${record.schema_version}`);
  const idColumn = dataset === "entities" ? "entity_id" : dataset === "episodes" ? "episode_id" : "fact_id";
  if (!isPrefixedUuid(record[idColumn], PREFIX[dataset])) throw new Error(`invalid ${idColumn}`);
  if (!isUtcTimestamp(record.created_at)) throw new Error("invalid created_at");
  if (dataset === "entities") {
    const key = canonicalKey(record.type, record.name);
    if (record.canonical_key !== key) throw new Error("canonical_key does not match type and name");
    rejectSecrets([record.type, record.name, record.canonical_key]);
  }
  if (dataset === "episodes") { validateAgentId(record.agent_id); rejectSecrets([record.session_id, record.kind, record.summary, record.source, record.evidence, record.tags]); }
  if (dataset === "facts") {
    canonicalKeyParts(record.subject); canonicalKeyParts(record.object); normalized(record.predicate, "predicate");
    if (record.episode_id && !isPrefixedUuid(record.episode_id, "ep_")) throw new Error("invalid episode_id");
    if (record.supersedes && !isPrefixedUuid(record.supersedes, "fact_")) throw new Error("invalid supersedes");
    if (record.fingerprint !== factFingerprint(record.subject, record.predicate, record.object)) throw new Error("invalid fingerprint");
    rejectSecrets([record.subject, record.predicate, record.object, record.evidence, record.tags]);
  }
}

export function isUtcTimestamp(value: string): boolean {
  if (!RFC3339.test(value)) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}

function normalized(value: string, label: string): string {
  return validateText(value, label, { maxBytes: MAX_KEY_BYTES });
}

export function canonicalKey(type: string, name: string): string {
  return `${normalized(type, "entity type")}:${normalized(name, "entity name")}`;
}

export function canonicalKeyParts(key: string): [string, string] {
  const split = key.indexOf(":");
  if (split < 1 || split === key.length - 1) throw new Error("canonical key must be <type>:<name>");
  return [normalized(key.slice(0, split), "entity type"), normalized(key.slice(split + 1), "entity name")];
}

export function factFingerprint(subject: string, predicate: string, object: string): string {
  const parts = [subject, predicate, object].map((value, index) => normalized(value, ["subject", "predicate", "object"][index]));
  const framed = parts.map(value => `${Buffer.byteLength(value, "utf8")}:${value}`).join("");
  return createHash("sha256").update(framed, "utf8").digest("hex");
}

export function isPrefixedUuid(value: string, prefix: string): boolean {
  return value.startsWith(prefix) && UUID_V4.test(value.slice(prefix.length));
}

export function generateId(dataset: Dataset, used: ReadonlySet<string> = new Set(), uuid: () => string = randomUUID): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const raw = uuid();
    if (!UUID_V4.test(raw)) throw new Error("UUID source returned a non-v4 UUID");
    const id = PREFIX[dataset] + raw.toLowerCase();
    if (!used.has(id)) return id;
  }
  throw new Error("unable to generate a unique ID after 100 attempts");
}

function normalizeIdentityPart(value: string, label: string): string {
  let part = value.trim().toLowerCase().replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").replace(/[ .]+$/g, "");
  if (WINDOWS_DEVICE.test(part)) part = `-${part}`;
  if (!part) throw new Error(`${label} is empty after normalization`);
  return part;
}

export function normalizeAgentId(username: string, host: string): string {
  return `${normalizeIdentityPart(username, "username")}@${normalizeIdentityPart(host, "hostname")}`;
}

function validateAgentId(agentId: string): void {
  const separator = agentId.lastIndexOf("@");
  try {
    if (separator < 1 || normalizeAgentId(agentId.slice(0, separator), agentId.slice(separator + 1)) !== agentId) throw new Error();
  } catch { throw new Error("invalid agent_id"); }
}

export function deriveAgentId(): string { return normalizeAgentId(userInfo().username, hostname()); }
export function utcTimestamp(date = new Date()): string { return date.toISOString(); }

export function shardPath(dataset: Dataset, agentId: string, date: Date, sequence: number): string {
  try { validateAgentId(agentId); } catch { throw new Error("agent ID is not normalized"); }
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 9999) throw new Error("sequence must be an integer from 1 to 9999");
  const month = date.toISOString().slice(0, 7);
  return posix.join("knowledge", dataset, agentId, month, `${String(sequence).padStart(4, "0")}.csv`);
}

