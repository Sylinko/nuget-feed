import { basename, join, resolve } from "node:path";
import { buildGitHubReleaseAssetUrl } from "./github-release.ts";
import { pathExists, readText, walkFiles, writeText } from "./file-system.ts";
import { readNuspecFromNupkg, readNuspecIdentity, sha256File } from "./nuget-package.ts";
import { isValidNuGetVersion, isValidPackageId, lowerNuGetId } from "./nuget-version.ts";
import { parseSimpleYaml, stringifySimpleYaml } from "./simple-yaml.ts";
import type { PackageManifest, SimpleYamlObject } from "./types.ts";

export type ReleaseBatchInput = {
  feedRepositoryPath: string;
  artifactsDirectory: string;
  releaseTag: string;
  sourceRepository: string;
  sourceCommit: string;
  serverUrl: string;
  runId: string;
};

export type ReleasedPackage = {
  id: string;
  version: string;
  lowerId: string;
  lowerVersion: string;
  nupkgPath: string;
  snupkgPath?: string;
  symbolsPath?: string;
  manifestPath: string;
};

type CandidatePackage = {
  id: string;
  version: string;
  lowerId: string;
  lowerVersion: string;
  nupkgPath: string;
  snupkgPath?: string;
  symbolsPath?: string;
};

export async function releaseBatch(input: ReleaseBatchInput): Promise<ReleasedPackage[]> {
  const candidates = await discoverPackages(input.artifactsDirectory);
  const released: ReleasedPackage[] = [];

  for (const candidate of candidates) {
    const packageManifestPath = join(input.feedRepositoryPath, "bucket", candidate.lowerId, "package.yml");
    if (!(await pathExists(packageManifestPath))) {
      throw new Error(`package manifest does not exist in nuget-feed: bucket/${candidate.lowerId}/package.yml`);
    }

    const packageManifest = parseSimpleYaml<PackageManifest>(await readText(packageManifestPath), packageManifestPath);
    if (packageManifest.id !== candidate.id || packageManifest.lowerId !== candidate.lowerId) {
      throw new Error(`package manifest identity does not match ${candidate.id}`);
    }
    if (packageManifest.source?.repository !== input.sourceRepository) {
      throw new Error(`package manifest source.repository ${packageManifest.source?.repository} does not match ${input.sourceRepository}`);
    }

    const versionManifestPath = join(input.feedRepositoryPath, "bucket", candidate.lowerId, "versions", `${candidate.lowerVersion}.yml`);
    if (await pathExists(versionManifestPath)) {
      throw new Error(`version manifest already exists: bucket/${candidate.lowerId}/versions/${candidate.lowerVersion}.yml`);
    }

    await writeText(versionManifestPath, stringifySimpleYaml(await buildVersionManifest(input, candidate)));
    const releasedPackage: ReleasedPackage = {
      id: candidate.id,
      version: candidate.version,
      lowerId: candidate.lowerId,
      lowerVersion: candidate.lowerVersion,
      nupkgPath: candidate.nupkgPath,
      manifestPath: versionManifestPath
    };
    if (candidate.snupkgPath) {
      releasedPackage.snupkgPath = candidate.snupkgPath;
    }
    if (candidate.symbolsPath) {
      releasedPackage.symbolsPath = candidate.symbolsPath;
    }
    released.push(releasedPackage);
  }

  return released;
}

export function sanitizedReleaseTag(releaseTag: string): string {
  const sanitized = releaseTag.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "release";
}

async function discoverPackages(artifactsDirectory: string): Promise<CandidatePackage[]> {
  const resolvedArtifactsDirectory = resolve(artifactsDirectory);
  const artifactFiles = await walkFiles(resolvedArtifactsDirectory);
  const nupkgFiles = artifactFiles.filter((file) => isNupkg(file)).sort((left, right) => left.localeCompare(right));
  const symbolFiles = artifactFiles.filter((file) => isSymbolsPackage(file));

  if (nupkgFiles.length === 0) {
    throw new Error(`expected at least one .nupkg in ${resolvedArtifactsDirectory}`);
  }

  const symbolsByName = new Map<string, string>();
  for (const file of symbolFiles) {
    const key = basename(file).toLowerCase();
    if (symbolsByName.has(key)) {
      throw new Error(`duplicate symbol package asset name: ${basename(file)}`);
    }
    symbolsByName.set(key, file);
  }

  const seenPackages = new Set<string>();
  const matchedSymbolAssets = new Set<string>();
  const candidates: CandidatePackage[] = [];

  for (const nupkgPath of nupkgFiles) {
    const identity = readNuspecIdentity(await readNuspecFromNupkg(nupkgPath));
    if (!isValidPackageId(identity.id)) {
      throw new Error(`nupkg nuspec id ${identity.id} is not a valid NuGet package ID`);
    }
    if (!isValidNuGetVersion(identity.version)) {
      throw new Error(`nupkg nuspec version ${identity.version} is not a valid NuGet-style version`);
    }

    const lowerId = lowerNuGetId(identity.id);
    const lowerVersion = identity.version.toLowerCase();
    const packageKey = `${lowerId}@${lowerVersion}`;
    if (seenPackages.has(packageKey)) {
      throw new Error(`duplicate package version in artifacts: ${packageKey}`);
    }
    seenPackages.add(packageKey);

    const expectedSnupkgName = `${identity.id}.${identity.version}.snupkg`.toLowerCase();
    const expectedSymbolsNupkgName = `${identity.id}.${identity.version}.symbols.nupkg`.toLowerCase();
    const snupkgPath = symbolsByName.get(expectedSnupkgName);
    const symbolsPath = symbolsByName.get(expectedSymbolsNupkgName);
    if (snupkgPath) {
      matchedSymbolAssets.add(expectedSnupkgName);
    }
    if (symbolsPath) {
      matchedSymbolAssets.add(expectedSymbolsNupkgName);
    }

    const candidate: CandidatePackage = {
      id: identity.id,
      version: identity.version,
      lowerId,
      lowerVersion,
      nupkgPath
    };
    if (snupkgPath) {
      candidate.snupkgPath = snupkgPath;
    }
    if (symbolsPath) {
      candidate.symbolsPath = symbolsPath;
    }
    candidates.push(candidate);
  }

  for (const symbolPath of symbolFiles) {
    const key = basename(symbolPath).toLowerCase();
    if (!matchedSymbolAssets.has(key)) {
      throw new Error(`unmatched symbol package asset: ${symbolPath}`);
    }
  }

  return candidates;
}

async function buildVersionManifest(input: ReleaseBatchInput, candidate: CandidatePackage): Promise<SimpleYamlObject> {
  const artifacts: SimpleYamlObject = {
    nupkg: {
      url: buildGitHubReleaseAssetUrl(input.sourceRepository, input.releaseTag, basename(candidate.nupkgPath)),
      sha256: await sha256File(candidate.nupkgPath)
    }
  };

  if (candidate.snupkgPath) {
    artifacts.snupkg = {
      url: buildGitHubReleaseAssetUrl(input.sourceRepository, input.releaseTag, basename(candidate.snupkgPath)),
      sha256: await sha256File(candidate.snupkgPath)
    };
  }
  if (candidate.symbolsPath) {
    artifacts.symbols = {
      url: buildGitHubReleaseAssetUrl(input.sourceRepository, input.releaseTag, basename(candidate.symbolsPath)),
      sha256: await sha256File(candidate.symbolsPath)
    };
  }

  return {
    version: candidate.version,
    lowerVersion: candidate.lowerVersion,
    source: {
      repository: input.sourceRepository,
      commit: input.sourceCommit,
      tag: input.releaseTag,
      workflowRun: `${input.serverUrl}/${input.sourceRepository}/actions/runs/${input.runId}`
    },
    artifacts
  };
}

function isNupkg(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".nupkg") && !lower.endsWith(".symbols.nupkg") && !lower.endsWith(".snupkg");
}

function isSymbolsPackage(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".snupkg") || lower.endsWith(".symbols.nupkg");
}
