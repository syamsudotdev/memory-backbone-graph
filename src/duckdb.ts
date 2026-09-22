import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";

const exec = promisify(execFile);
const MAX_ARCHIVE = 100 * 1024 * 1024;
const MAX_EXECUTABLE = 250 * 1024 * 1024;

type Artifact = { os: string; arch: string; url: string; archive_format: string; sha256: string };
type Metadata = { version: string; metadata_source: string; artifacts: Artifact[] };
export type BootstrapOptions = {
  extensionDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  download?: (url: string) => Promise<Buffer>;
};

export async function loadDuckDBMetadata(extensionDir = resolve(import.meta.dirname, "..")): Promise<Metadata> {
  const data = JSON.parse(await readFile(resolve(extensionDir, "metadata/duckdb.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(data.version) || !Array.isArray(data.artifacts)) throw new Error("invalid DuckDB metadata");
  for (const item of data.artifacts) if (!item || item.archive_format !== "zip" || !/^https:\/\/(github\.com|api\.github\.com)\//.test(item.url) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error("invalid DuckDB artifact metadata");
  return data;
}

export function selectDuckDBArtifact(metadata: Metadata, platform: string, arch: string): Artifact {
  const item = metadata.artifacts.find((candidate) => candidate.os === platform && candidate.arch === arch);
  if (!item) throw new Error(`unsupported DuckDB platform: ${platform}/${arch}`);
  return item;
}

function executableName(platform: string) { return platform === "win32" ? "duckdb.exe" : "duckdb"; }
function managedPath(extensionDir: string, version: string, platform: string, arch: string) {
  return resolve(extensionDir, "runtime", "duckdb", version, `${platform}-${arch}`, executableName(platform));
}

export async function compatibleDuckDB(path: string, version: string, env = process.env): Promise<boolean> {
  try {
    const result = await exec(path, ["--version"], { shell: false, timeout: 10_000, windowsHide: true, env });
    return result.stderr === "" && new RegExp(`^v${version.replaceAll(".", "\\.")} \\([A-Za-z]+\\) [0-9a-f]{10}\\r?\\n?$`).test(result.stdout);
  } catch { return false; }
}

export async function downloadHttps(url: string, redirects = 0, get: typeof httpsGet = httpsGet): Promise<Buffer> {
  if (redirects > 5) throw new Error("too many DuckDB download redirects");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("DuckDB download requires HTTPS");
  return new Promise((accept, reject) => {
    const request = get(parsed, { headers: { "User-Agent": "pi-memory-backbone" }, timeout: 30_000 }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, parsed);
        if (next.protocol !== "https:") { reject(new Error("DuckDB download redirect requires HTTPS")); return; }
        downloadHttps(next.href, redirects + 1, get).then(accept, reject); return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`DuckDB download returned HTTP ${response.statusCode}`)); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_ARCHIVE) request.destroy(new Error("DuckDB archive exceeds size limit")); else chunks.push(chunk); });
      response.on("end", () => accept(Buffer.concat(chunks)));
    });
    request.on("timeout", () => request.destroy(new Error("DuckDB download timed out")));
    request.on("error", reject);
  });
}

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}

export function extractDuckDBZip(zip: Buffer, expectedName: string): Buffer {
  if (zip.length > MAX_ARCHIVE) throw new Error("DuckDB archive exceeds size limit");
  let eocd = -1;
  for (let offset = zip.length - 22, floor = Math.max(0, zip.length - 65_557); offset >= floor; offset--) if (zip.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  if (eocd < 0 || eocd + 22 + zip.readUInt16LE(eocd + 20) !== zip.length) throw new Error("invalid ZIP end record");
  const entries = zip.readUInt16LE(eocd + 10), cdSize = zip.readUInt32LE(eocd + 12), cdOffset = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt16LE(eocd + 4) || zip.readUInt16LE(eocd + 6) || entries !== zip.readUInt16LE(eocd + 8) || entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff || cdOffset + cdSize !== eocd) throw new Error("multi-disk or ZIP64 archives are unsupported");
  const names = new Set<string>(); let found: Buffer | undefined; let offset = cdOffset;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > eocd || zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("invalid ZIP central directory");
    const flags = zip.readUInt16LE(offset + 8), method = zip.readUInt16LE(offset + 10), checksum = zip.readUInt32LE(offset + 16), compressed = zip.readUInt32LE(offset + 20), expanded = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28), extraLength = zip.readUInt16LE(offset + 30), commentLength = zip.readUInt16LE(offset + 32), external = zip.readUInt32LE(offset + 38), local = zip.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || flags & 1 || flags & 8 || ![0, 8].includes(method) || compressed === 0xffffffff || expanded === 0xffffffff || compressed > MAX_ARCHIVE || expanded > MAX_EXECUTABLE) throw new Error("unsupported or oversized ZIP entry");
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const centralExtra = zip.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    for (let extra = 0; extra + 4 <= centralExtra.length;) { const id = centralExtra.readUInt16LE(extra), size = centralExtra.readUInt16LE(extra + 2); if (extra + 4 + size > centralExtra.length) throw new Error("invalid ZIP extra field"); if (id === 1) throw new Error("ZIP64 archives are unsupported"); extra += 4 + size; }
    if (!name || name.includes("\\") || isAbsolute(name) || name.split("/").includes("..") || basename(name) !== name) throw new Error(`unsafe ZIP entry: ${name}`);
    if (names.has(name)) throw new Error(`duplicate ZIP entry: ${name}`); names.add(name);
    if (name !== expectedName) throw new Error(`unexpected ZIP entry: ${name}`);
    if (((external >>> 16) & 0o170000) === 0o120000) throw new Error("ZIP links are unsupported");
    if (local + 30 > cdOffset || zip.readUInt32LE(local) !== 0x04034b50) throw new Error("invalid ZIP local header");
    const localNameLength = zip.readUInt16LE(local + 26), localExtraLength = zip.readUInt16LE(local + 28), dataOffset = local + 30 + localNameLength + localExtraLength;
    if (zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method || zip.readUInt32LE(local + 14) !== checksum || zip.readUInt32LE(local + 18) !== compressed || zip.readUInt32LE(local + 22) !== expanded || zip.subarray(local + 30, local + 30 + localNameLength).toString("utf8") !== name || dataOffset + compressed > cdOffset) throw new Error("inconsistent ZIP local header");
    const localExtra = zip.subarray(local + 30 + localNameLength, dataOffset);
    for (let extra = 0; extra + 4 <= localExtra.length;) { const id = localExtra.readUInt16LE(extra), size = localExtra.readUInt16LE(extra + 2); if (extra + 4 + size > localExtra.length) throw new Error("invalid ZIP extra field"); if (id === 1) throw new Error("ZIP64 archives are unsupported"); extra += 4 + size; }
    const packed = zip.subarray(dataOffset, dataOffset + compressed);
    const output = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: MAX_EXECUTABLE });
    if (output.length !== expanded || crc32(output) !== checksum) throw new Error("corrupt ZIP entry");
    found = output; offset = end;
  }
  if (offset !== eocd || !found || names.size !== 1) throw new Error("invalid or unexpected ZIP contents");
  return found;
}

async function syncPath(path: string, kind: "file" | "directory") {
  let handle;
  try { handle = await open(path, "r"); await handle.sync(); }
  catch (cause: any) { throw new Error(`DuckDB install cannot sync ${kind} ${path}: ${cause.message}`, { cause }); }
  finally { await handle?.close(); }
}

export async function createDurableDirectory(path: string, sync: (path: string, kind: "directory") => Promise<void> = syncPath) {
  const missing: string[] = []; let current = resolve(path);
  while (true) {
    try { if (!(await stat(current)).isDirectory()) throw new Error(`DuckDB runtime path is not a directory: ${current}`); break; }
    catch (cause: any) { if (cause.code !== "ENOENT") throw cause; missing.push(current); const parent = dirname(current); if (parent === current) throw cause; current = parent; }
  }
  for (const directory of missing.reverse()) {
    try { await mkdir(directory); } catch (cause: any) { if (cause.code !== "EEXIST") throw cause; }
    await sync(dirname(directory), "directory");
  }
}

export async function ensureDuckDB(options: BootstrapOptions = {}): Promise<string> {
  const extensionDir = resolve(options.extensionDir ?? resolve(import.meta.dirname, ".."));
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch, env = options.env ?? process.env;
  const metadata = await loadDuckDBMetadata(extensionDir);
  const artifact = selectDuckDBArtifact(metadata, platform, arch);
  const managed = managedPath(extensionDir, metadata.version, platform, arch);
  const candidates = [env.MBG_DUCKDB_PATH, executableName(platform), managed].filter((value): value is string => !!value);
  for (const candidate of candidates) if (await compatibleDuckDB(candidate, metadata.version, env)) return candidate;
  if (/^(?:1|true)$/i.test(env.MBG_OFFLINE ?? "")) throw new Error(`knowledge query unavailable: DuckDB ${metadata.version} is not available offline`);
  let archivePath: string | undefined, temporary: string | undefined;
  try {
    const bytes = await (options.download ?? downloadHttps)(artifact.url);
    if (bytes.length > MAX_ARCHIVE) throw new Error("DuckDB archive exceeds size limit");
    const directory = dirname(managed); await createDurableDirectory(directory);
    const nonce = `${process.pid}-${Date.now()}`; archivePath = resolve(directory, `.download-${nonce}.zip`); temporary = resolve(directory, `.install-${nonce}`);
    await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("DuckDB archive checksum mismatch");
    await writeFile(temporary, extractDuckDBZip(bytes, executableName(platform)), { flag: "wx", mode: 0o700 });
    if (platform !== "win32") await chmod(temporary, 0o755);
    await syncPath(temporary, "file");
    await syncPath(directory, "directory");
    await rename(temporary, managed); temporary = undefined;
    await syncPath(directory, "directory");
    if (!await compatibleDuckDB(managed, metadata.version, env)) { await rm(managed, { force: true }); await syncPath(directory, "directory"); throw new Error("installed DuckDB executable is incompatible"); }
    return managed;
  } catch (cause: any) {
    throw new Error(`knowledge query unavailable: DuckDB ${metadata.version} discovery and bootstrap failed: ${cause.message}`, { cause });
  } finally {
    if (archivePath) await rm(archivePath, { force: true });
    if (temporary) await rm(temporary, { force: true });
  }
}
