import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { inflateRawSync } from "node:zlib";
import { ensureDir, pathExists } from "./file-system.ts";
import type { NuspecIdentity, ZipEntry } from "./types.ts";

export async function downloadIfNeeded(url: string, filePath: string): Promise<void> {
  if (await pathExists(filePath)) {
    return;
  }

  await ensureDir(dirname(filePath));
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(filePath));
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

export async function readNuspecFromNupkg(filePath: string): Promise<string> {
  const archive = await readFile(filePath);
  const entries = readZipEntries(archive);
  const nuspec = entries.find((entry) => entry.name.toLowerCase().endsWith(".nuspec") && !entry.name.includes("/"));
  if (!nuspec) {
    throw new Error(`${filePath}: no root .nuspec entry found`);
  }
  return extractZipEntry(archive, nuspec).toString("utf8");
}

export function readNuspecIdentity(nuspecText: string): NuspecIdentity {
  const id = firstXmlText(nuspecText, "id");
  const version = firstXmlText(nuspecText, "version");
  if (!id || !version) {
    throw new Error("nuspec metadata must contain id and version");
  }
  return { id, version };
}

function firstXmlText(text: string, name: string): string | null {
  const match = new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`, "i").exec(text);
  return match ? decodeXml(match[1].trim()) : null;
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("invalid zip central directory");
    }

    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength).replaceAll("\\", "/");

    entries.push({ name, compression, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function extractZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`invalid local zip header for ${entry.name}`);
  }

  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compression === 0) {
    return compressed;
  }
  if (entry.compression === 8) {
    const inflated = inflateRawSync(compressed);
    if (inflated.length !== entry.uncompressedSize) {
      throw new Error(`unexpected uncompressed size for ${entry.name}`);
    }
    return inflated;
  }

  throw new Error(`unsupported zip compression method ${entry.compression} for ${entry.name}`);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("zip end of central directory not found");
}
