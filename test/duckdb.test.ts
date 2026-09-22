import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { compatibleDuckDB, createDurableDirectory, downloadHttps, ensureDuckDB, extractDuckDBZip, loadDuckDBMetadata, selectDuckDBArtifact } from "../src/duckdb.ts";

function crc32(data: Buffer) { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function zip(entries: { name: string; data: Buffer; method?: 0 | 8; mode?: number }[]) {
  const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), method = entry.method ?? 8, packed = method === 8 ? deflateRawSync(entry.data) : entry.data, crc = crc32(entry.data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((entry.mode ?? 0o100755) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name); offset += local.length + name.length + packed.length;
  }
  const centralBytes = Buffer.concat(centrals), eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}
async function executable(path: string, version: string, output = `v${version} (Variegata) 0123456789\\n`) { await writeFile(path, `#!/bin/sh\nprintf '${output}'\n`); await chmod(path, 0o755); }
function centralOffset(value: Buffer) { return value.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); }
function changed(value: Buffer, change: (copy: Buffer, central: number) => void) { const copy = Buffer.from(value); change(copy, centralOffset(copy)); return copy; }
async function extension(archive?: Buffer, checksum?: string) {
  const root = await mkdtemp(join(tmpdir(), "duckdb-ticket-")); await mkdir(join(root, "metadata"));
  const sha256 = checksum ?? createHash("sha256").update(archive ?? Buffer.alloc(0)).digest("hex");
  await writeFile(join(root, "metadata/duckdb.json"), JSON.stringify({ version: "1.5.5", metadata_source: "https://api.github.com/repos/duckdb/duckdb/releases/tags/v1.5.5", artifacts: [{ os: "linux", arch: "x64", url: "https://github.com/duckdb/duckdb/releases/download/v1.5.5/fake.zip", archive_format: "zip", sha256 }] }));
  return root;
}

test("pinned platform mapping is exhaustive", async () => {
  const metadata = await loadDuckDBMetadata();
  for (const target of [["linux", "x64"], ["linux", "arm64"], ["darwin", "x64"], ["darwin", "arm64"], ["win32", "x64"]]) assert.equal(selectDuckDBArtifact(metadata, ...target as [string, string]).os, target[0]);
  assert.throws(() => selectDuckDBArtifact(metadata, "win32", "arm64"), /unsupported/);
});

test("configured candidate wins and permits offline startup", async () => {
  const root = await extension(), configured = join(root, "configured"), pathDir = join(root, "path"); await mkdir(pathDir); await executable(configured, "1.5.5"); await executable(join(pathDir, "duckdb"), "1.5.5");
  let downloads = 0; const selected = await ensureDuckDB({ extensionDir: root, platform: "linux", arch: "x64", env: { ...process.env, PATH: pathDir, MBG_DUCKDB_PATH: configured }, download: async () => { downloads++; throw new Error("offline"); } });
  assert.equal(selected, configured); assert.equal(downloads, 0);
});

test("offline mode fails before download when no compatible executable exists", async () => {
  const root = await extension(); let downloads = 0;
  await assert.rejects(ensureDuckDB({ extensionDir: root, platform: "linux", arch: "x64", env: { ...process.env, PATH: "", MBG_OFFLINE: "1" }, download: async () => { downloads++; return Buffer.alloc(0); } }), /not available offline/);
  assert.equal(downloads, 0);
});

test("incompatible PATH falls through to compatible managed executable", async () => {
  const root = await extension(), pathDir = join(root, "path"), managed = join(root, "runtime/duckdb/1.5.5/linux-x64/duckdb"); await mkdir(pathDir); await mkdir(join(root, "runtime/duckdb/1.5.5/linux-x64"), { recursive: true }); await executable(join(pathDir, "duckdb"), "0.9.0"); await executable(managed, "1.5.5");
  assert.equal(await ensureDuckDB({ extensionDir: root, platform: "linux", arch: "x64", env: { ...process.env, PATH: pathDir } }), managed);
  assert.match(await readFile(join(pathDir, "duckdb"), "utf8"), /0\.9\.0/);
});

test("verified fixture installs atomically and cleans archive", async () => {
  const archive = zip([{ name: "duckdb", data: Buffer.from("#!/bin/sh\nprintf 'v1.5.5 (Variegata) 0123456789\\n'\n") }]), root = await extension(archive);
  const selected = await ensureDuckDB({ extensionDir: root, platform: "linux", arch: "x64", env: { ...process.env, PATH: "", MBG_OFFLINE: "" }, download: async () => archive });
  assert.equal((await stat(selected)).mode & 0o777, 0o755); assert.deepEqual(await readdir(join(root, "runtime/duckdb/1.5.5/linux-x64")), ["duckdb"]);
});

test("checksum failure installs nothing and cleans temporary data", async () => {
  const archive = zip([{ name: "duckdb", data: Buffer.from("bad") }]), root = await extension(archive, "0".repeat(64));
  await assert.rejects(ensureDuckDB({ extensionDir: root, platform: "linux", arch: "x64", env: { ...process.env, PATH: "", MBG_OFFLINE: "" }, download: async () => archive }), /checksum mismatch/);
  assert.deepEqual(await readdir(join(root, "runtime/duckdb/1.5.5/linux-x64")), []);
});

test("ZIP parser rejects traversal, unexpected contents, duplicates, and links", () => {
  for (const fixture of [zip([{ name: "../duckdb", data: Buffer.from("x") }]), zip([{ name: "readme", data: Buffer.from("x") }]), zip([{ name: "duckdb", data: Buffer.from("x") }, { name: "duckdb", data: Buffer.from("x") }]), zip([{ name: "duckdb", data: Buffer.from("x"), mode: 0o120777 }])]) assert.throws(() => extractDuckDBZip(fixture, "duckdb"));
});

test("ZIP parser rejects encryption, descriptors, ZIP64, compression and size limits", () => {
  const base = zip([{ name: "duckdb", data: Buffer.from("x") }]);
  const fixtures = [
    changed(base, (b, c) => { b.writeUInt16LE(1, 6); b.writeUInt16LE(1, c + 8); }),
    changed(base, (b, c) => { b.writeUInt16LE(8, 6); b.writeUInt16LE(8, c + 8); }),
    changed(base, (b) => b.writeUInt16LE(0xffff, b.length - 12)),
    changed(base, (b, c) => { b.writeUInt16LE(12, 8); b.writeUInt16LE(12, c + 10); }),
    changed(base, (b, c) => { b.writeUInt32LE(100 * 1024 * 1024 + 1, 18); b.writeUInt32LE(100 * 1024 * 1024 + 1, c + 20); }),
    changed(base, (b, c) => { b.writeUInt32LE(250 * 1024 * 1024 + 1, 22); b.writeUInt32LE(250 * 1024 * 1024 + 1, c + 24); })
  ];
  for (const fixture of fixtures) assert.throws(() => extractDuckDBZip(fixture, "duckdb"));
});

test("ZIP parser rejects every inconsistent local-header field", () => {
  const base = zip([{ name: "duckdb", data: Buffer.from("x") }]), central = centralOffset(base);
  for (const [offset, size] of [[6, 2], [8, 2], [14, 4], [18, 4], [22, 4]] as const) {
    const fixture = Buffer.from(base); if (size === 2) fixture.writeUInt16LE(fixture.readUInt16LE(central + offset + 2) ^ 1, offset); else fixture.writeUInt32LE((fixture.readUInt32LE(central + offset + 2) ^ 1) >>> 0, offset);
    assert.throws(() => extractDuckDBZip(fixture, "duckdb"), /inconsistent/);
  }
});

test("version output must be the exact DuckDB CLI format", async () => {
  const root = await mkdtemp(join(tmpdir(), "duckdb-version-")), candidate = join(root, "duckdb");
  for (const [output, accepted] of [["v1.5.5 (Variegata) 0123456789\\n", true], ["warning\\nv1.5.5 (Variegata) 0123456789\\n", false], ["DuckDB v1.5.5 (Variegata) 0123456789\\n", false], ["v1.5.4 (Variegata) 0123456789\\n", false], ["v1.5.5 Variegata 0123456789\\n", false], ["v1.5.5 (Variegata 2) 0123456789\\n", false], ["v1.5.5 (Variegata) 0123456789 extra\\n", false], ["v1.5.5 (Variegata) 0123456789\\nwarning\\n", false]]) { await executable(candidate, "1.5.5", output as string); assert.equal(await compatibleDuckDB(candidate, "1.5.5"), accepted, output as string); }
  await writeFile(candidate, "#!/bin/sh\nprintf 'v1.5.5 (Variegata) 0123456789\\n'\nprintf 'warning\\n' >&2\n"); await chmod(candidate, 0o755); assert.equal(await compatibleDuckDB(candidate, "1.5.5"), false);
});

test("recursive runtime creation syncs each new parent entry in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "duckdb-durable-")), target = join(root, "runtime", "duckdb", "1.5.5", "linux-x64"), synced: string[] = [];
  await createDurableDirectory(target, async (path, kind) => { assert.equal(kind, "directory"); synced.push(path); });
  assert.deepEqual(synced, [root, join(root, "runtime"), join(root, "runtime", "duckdb"), join(root, "runtime", "duckdb", "1.5.5")]);
  assert.equal((await stat(target)).isDirectory(), true);
});

test("candidate precedence is configured, PATH, then managed", async () => {
  const root = await extension(), configured = join(root, "configured"), pathDir = join(root, "path"), pathCandidate = join(pathDir, "duckdb"), managed = join(root, "runtime/duckdb/1.5.5/linux-x64/duckdb");
  await mkdir(pathDir); await mkdir(join(root, "runtime/duckdb/1.5.5/linux-x64"), { recursive: true }); await executable(configured, "0.9.0"); await executable(pathCandidate, "1.5.5"); await executable(managed, "1.5.5");
  assert.equal(await ensureDuckDB({ extensionDir: root, platform: "linux", arch: "x64", env: { ...process.env, PATH: pathDir, MBG_DUCKDB_PATH: configured } }), "duckdb");
});

test("unsupported platform is rejected before discovery", async () => {
  const root = await extension(), configured = join(root, "configured"); await executable(configured, "1.5.5");
  await assert.rejects(ensureDuckDB({ extensionDir: root, platform: "aix", arch: "ppc64", env: { ...process.env, MBG_DUCKDB_PATH: configured } }), /unsupported DuckDB platform/);
});

test("HTTPS downloader rejects redirect downgrade", async () => {
  let calls = 0;
  const get = ((_url: URL, _options: object, callback: (response: any) => void) => { calls++; const request: any = new EventEmitter(); request.destroy = (error: Error) => request.emit("error", error); const response: any = new EventEmitter(); response.statusCode = 302; response.headers = { location: "http://example.test/archive.zip" }; response.resume = () => {}; process.nextTick(() => callback(response)); return request; }) as any;
  await assert.rejects(downloadHttps("https://github.com/archive.zip", 0, get), /redirect requires HTTPS/); assert.equal(calls, 1);
});
