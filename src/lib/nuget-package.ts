import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { openPromise } from "yauzl";
import { ensureDir, pathExists } from "./file-system.ts";
import type { NuspecIdentity, PackageAsset, PackageMetadata, DependencyGroup } from "./types.ts";

const MAX_NUSPEC_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  htmlEntities: true,
  trimValues: true,
  isArray: (name) => ["dependency", "group", "packageType"].includes(name)
});

export async function downloadIfNeeded(url: string, filePath: string): Promise<void> {
  if (await pathExists(filePath)) {
    return;
  }
  await ensureDir(dirname(filePath));
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  }
  const temporaryPath = `${filePath}.${process.pid}.download`;
  try {
    await pipeline(response.body, createWriteStream(temporaryPath));
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

export async function readNuspecFromNupkg(filePath: string): Promise<string> {
  const entries = await readArchiveEntries(filePath, (name) => !name.includes("/") && name.toLowerCase().endsWith(".nuspec"), MAX_NUSPEC_BYTES);
  if (entries.size !== 1) {
    throw new Error(`${filePath}: expected exactly one root .nuspec entry, found ${entries.size}`);
  }
  return [...entries.values()][0].toString("utf8");
}

export function readNuspecIdentity(nuspecText: string): NuspecIdentity {
  const { id, version } = readNuspecMetadata(nuspecText);
  return { id, version };
}

export function readNuspecMetadata(nuspecText: string): PackageMetadata {
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(nuspecText)) {
    throw new Error("nuspec DTD and custom entity declarations are not supported");
  }
  const validation = XMLValidator.validate(nuspecText);
  if (validation !== true) {
    throw new Error(`invalid nuspec XML: ${validation.err.msg}`);
  }
  const document: unknown = xmlParser.parse(nuspecText);
  const root = xmlObject(xmlObject(document, "nuspec").package, "package");
  const node = xmlObject(root.metadata, "metadata");
  const metadata: PackageMetadata = {
    id: requiredText(node.id, "id"),
    version: requiredText(node.version, "version"),
    tags: [],
    packageTypes: [],
    dependencyGroups: []
  };
  for (const key of ["authors", "description", "title", "summary", "projectUrl", "licenseUrl", "iconUrl", "copyright", "language", "releaseNotes"] as const) {
    const value = xmlText(node[key]);
    if (value !== undefined) {
      metadata[key] = value;
    }
  }
  const minClientVersion = xmlText(node["@minClientVersion"]);
  if (minClientVersion) {
    metadata.minClientVersion = minClientVersion;
  }
  const tags = xmlText(node.tags);
  if (tags) {
    metadata.tags = tags.split(/[\s,;]+/).filter(Boolean);
  }
  const acceptance = xmlText(node.requireLicenseAcceptance);
  if (acceptance !== undefined) {
    if (!/^(true|false)$/i.test(acceptance)) {
      throw new Error("requireLicenseAcceptance must be true or false");
    }
    metadata.requireLicenseAcceptance = acceptance.toLowerCase() === "true";
  }
  if (node.dependencies !== undefined) {
    const dependencies = optionalObject(node.dependencies, "dependencies");
    if (dependencies.dependency !== undefined) {
      metadata.dependencyGroups.push(readDependencyGroup(dependencies));
    }
    for (const group of xmlArray(dependencies.group)) {
      metadata.dependencyGroups.push(readDependencyGroup(optionalObject(group, "dependency group")));
    }
  }
  if (node.packageTypes !== undefined) {
    for (const item of xmlArray(optionalObject(node.packageTypes, "packageTypes").packageType)) {
      const type = xmlObject(item, "packageType");
      const name = requiredText(type["@name"], "packageType name");
      const version = xmlText(type["@version"]);
      metadata.packageTypes.push(version ? { name, version } : { name });
    }
  }
  if (metadata.packageTypes.length === 0) {
    metadata.packageTypes.push({ name: "Dependency" });
  }
  const icon = xmlText(node.icon);
  const readme = xmlText(node.readme);
  if (icon) {
    metadata.iconFile = packageEntryPath(icon);
  }
  if (readme) {
    metadata.readmeFile = packageEntryPath(readme);
  }
  if (node.license !== undefined) {
    const license = xmlObject(node.license, "license");
    const value = requiredText(license["#text"], "license");
    if (license["@type"] === "expression") {
      metadata.licenseExpression = value;
    } else if (license["@type"] === "file") {
      metadata.licenseFile = packageEntryPath(value);
    } else {
      throw new Error("nuspec license type must be expression or file");
    }
  }
  return metadata;
}

export async function readPackageAssets(filePath: string, metadata: PackageMetadata): Promise<PackageAsset[]> {
  const declared = [metadata.iconFile, metadata.readmeFile, metadata.licenseFile].filter((name): name is string => name !== undefined);
  if (declared.length === 0) {
    return [];
  }
  const entries = await readArchiveEntries(filePath, (name) => declared.includes(name), MAX_ASSET_BYTES);
  return [...entries.entries()].map(([name, content]) => ({ name, content }));
}

async function readArchiveEntries(filePath: string, shouldRead: (name: string) => boolean, maxBytes: number): Promise<Map<string, Buffer>> {
  const archive = await openPromise(filePath, { autoClose: false, validateEntrySizes: true, strictFileNames: true });
  const result = new Map<string, Buffer>();
  try {
    for await (const entry of archive.eachEntry()) {
      if (!shouldRead(entry.fileName)) {
        continue;
      }
      if (result.has(entry.fileName)) {
        throw new Error(`${filePath}: duplicate archive entry ${entry.fileName}`);
      }
      if (entry.uncompressedSize > maxBytes) {
        throw new Error(`${filePath}: ${entry.fileName} exceeds ${maxBytes} bytes`);
      }
      const stream = await archive.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let length = 0;
      try {
        for await (const chunk of stream) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += bytes.length;
          if (length > maxBytes) {
            throw new Error(`${filePath}: ${entry.fileName} exceeds ${maxBytes} bytes`);
          }
          chunks.push(bytes);
        }
      } finally {
        stream.destroy();
      }
      result.set(entry.fileName, Buffer.concat(chunks));
    }
  } finally {
    archive.close();
  }
  return result;
}

function readDependencyGroup(node: Record<string, unknown>): DependencyGroup {
  const group: DependencyGroup = { dependencies: [] };
  const targetFramework = xmlText(node["@targetFramework"]);
  if (targetFramework) {
    group.targetFramework = targetFramework;
  }
  for (const item of xmlArray(node.dependency)) {
    const dependency = xmlObject(item, "dependency");
    const id = requiredText(dependency["@id"], "dependency id");
    const range = xmlText(dependency["@version"]);
    group.dependencies.push(range ? { id, range } : { id });
  }
  return group;
}

function xmlObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`nuspec ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown, label: string): Record<string, unknown> {
  return value === "" ? {} : xmlObject(value, label);
}

function xmlText(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("nuspec text value must be a string");
  }
  return value.trim();
}

function requiredText(value: unknown, label: string): string {
  const text = xmlText(value);
  if (!text) {
    throw new Error(`nuspec metadata must contain ${label}`);
  }
  return text;
}

function xmlArray(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function packageEntryPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.includes(":") || normalized.split("/").includes("..") || posix.normalize(normalized) !== normalized) {
    throw new Error(`invalid package metadata path: ${value}`);
  }
  return normalized;
}
