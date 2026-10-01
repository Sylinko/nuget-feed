import path from "node:path";
import { isGitHubReleaseAssetUrl } from "./github-release.ts";
import { downloadIfNeeded, readNuspecFromNupkg, readNuspecMetadata, readPackageAssets, sha256File } from "./nuget-package.ts";
import { assertLowercase, isValidNuGetVersion, isValidPackageId, lowerNuGetId, lowerNuGetVersion } from "./nuget-version.ts";
import { listDirectories, listFiles, readText } from "./file-system.ts";
import { parseManifestYaml } from "./manifest-yaml.ts";
import type {
  ArtifactManifest,
  Bucket,
  PackageManifest,
  RequiredArtifactManifest,
  RequiredPackageManifest,
  RequiredVersionManifest,
  VersionManifest,
  VerifiedRecord
} from "./types.ts";

export async function readBucket(rootDirectory: string): Promise<Bucket> {
  const bucketDirectory = path.join(rootDirectory, "bucket");
  const packageDirectories = await listDirectories(bucketDirectory);
  const packages: Bucket["packages"] = [];

  for (const lowerIdDirectory of packageDirectories) {
    const packagePath = path.join(bucketDirectory, lowerIdDirectory, "package.yml");
    const packageManifest = parseManifestYaml<PackageManifest>(await readText(packagePath), packagePath);
    const versionDirectory = path.join(bucketDirectory, lowerIdDirectory, "versions");
    const versionFiles = (await listFiles(versionDirectory)).filter((file) => file.endsWith(".yml"));
    const versions: Bucket["packages"][number]["versions"] = [];

    for (const fileName of versionFiles) {
      const versionPath = path.join(versionDirectory, fileName);
      versions.push({
        fileName,
        filePath: versionPath,
        manifest: parseManifestYaml<VersionManifest>(await readText(versionPath), versionPath)
      });
    }

    packages.push({
      lowerIdDirectory,
      packagePath,
      manifest: packageManifest,
      versions
    });
  }

  return { rootDirectory, packages };
}

export function validateBucketManifests(bucket: Bucket): string[] {
  const errors: string[] = [];
  const seenIds = new Map<string, string>();
  const seenVersions = new Set<string>();

  for (const packageEntry of bucket.packages) {
    const packageLabel = packageEntry.packagePath;
    const manifest = packageEntry.manifest;
    const id = expectString(errors, manifest.id, `${packageLabel}: id`);
    const lowerId = expectString(errors, manifest.lowerId, `${packageLabel}: lowerId`);

    if (id && !isValidPackageId(id)) {
      errors.push(`${packageLabel}: id is not a valid NuGet package ID`);
    }
    if (lowerId && !assertLowercase(lowerId)) {
      errors.push(`${packageLabel}: lowerId must be lowercase`);
    }
    if (id && lowerId && lowerNuGetId(id) !== lowerId) {
      errors.push(`${packageLabel}: lowerId must equal lowercase id`);
    }
    if (lowerId && lowerId !== packageEntry.lowerIdDirectory) {
      errors.push(`${packageLabel}: directory name must match lowerId`);
    }
    if (id) {
      const key = lowerNuGetId(id);
      if (seenIds.has(key)) {
        errors.push(`${packageLabel}: duplicate package id also declared in ${seenIds.get(key)}`);
      } else {
        seenIds.set(key, packageLabel);
      }
    }

    expectString(errors, manifest.source?.repository, `${packageLabel}: source.repository`);
    if (manifest.policy?.requireSylinkoPrefix !== undefined && typeof manifest.policy.requireSylinkoPrefix !== "boolean") {
      errors.push(`${packageLabel}: policy.requireSylinkoPrefix must be boolean`);
    }
    if (manifest.policy?.allowOriginalPackageId !== undefined && typeof manifest.policy.allowOriginalPackageId !== "boolean") {
      errors.push(`${packageLabel}: policy.allowOriginalPackageId must be boolean`);
    }

    for (const versionEntry of packageEntry.versions) {
      const label = versionEntry.filePath;
      const versionManifest = versionEntry.manifest;
      const version = expectString(errors, versionManifest.version, `${label}: version`);
      const lowerVersion = expectString(errors, versionManifest.lowerVersion, `${label}: lowerVersion`);
      const fileLowerVersion = versionEntry.fileName.slice(0, -".yml".length);

      if (version && !isValidNuGetVersion(version)) {
        errors.push(`${label}: this feed requires a three-part SemVer version`);
      }
      if (lowerVersion && !assertLowercase(lowerVersion)) {
        errors.push(`${label}: lowerVersion must be lowercase`);
      }
      if (version && isValidNuGetVersion(version) && lowerVersion && lowerNuGetVersion(version) !== lowerVersion) {
        errors.push(`${label}: lowerVersion must equal normalized lowercase version without build metadata`);
      }
      if (lowerVersion && lowerVersion !== fileLowerVersion) {
        errors.push(`${label}: file name must match lowerVersion`);
      }

      expectString(errors, versionManifest.source?.repository, `${label}: source.repository`);
      expectString(errors, versionManifest.source?.commit, `${label}: source.commit`);
      expectString(errors, versionManifest.source?.tag, `${label}: source.tag`);
      expectString(errors, versionManifest.source?.workflowRun, `${label}: source.workflowRun`);
      if (versionManifest.source?.repository !== manifest.source?.repository) {
        errors.push(`${label}: source.repository must match package registration`);
      }
      if (versionManifest.listed !== undefined && typeof versionManifest.listed !== "boolean") {
        errors.push(`${label}: listed must be boolean`);
      }
      validateArtifact(errors, versionManifest.artifacts?.nupkg, `${label}: artifacts.nupkg`, true);
      validateArtifact(errors, versionManifest.artifacts?.snupkg, `${label}: artifacts.snupkg`, false);
      validateArtifact(errors, versionManifest.artifacts?.symbols, `${label}: artifacts.symbols`, false);

      if (id && lowerVersion) {
        const key = `${lowerNuGetId(id)}@${lowerVersion}`;
        if (seenVersions.has(key)) {
          errors.push(`${label}: duplicate package version ${key}`);
        }
        seenVersions.add(key);
      }
    }
  }

  return errors;
}

export async function buildVerifiedRecords(bucket: Bucket): Promise<{ records: VerifiedRecord[]; errors: string[] }> {
  const errors = validateBucketManifests(bucket);
  const records: VerifiedRecord[] = [];
  if (errors.length > 0) {
    return { records, errors };
  }

  for (const packageEntry of bucket.packages) {
    const packageManifest = asRequiredPackageManifest(packageEntry.manifest);
    if (!packageManifest) {
      continue;
    }

    for (const versionEntry of packageEntry.versions) {
      const versionManifest = asRequiredVersionManifest(versionEntry.manifest);
      if (!versionManifest) {
        continue;
      }

      try {
        const cacheDirectory = path.join(bucket.rootDirectory, ".tmp", "packages", packageManifest.lowerId, versionManifest.lowerVersion);
        const nupkgPath = path.join(cacheDirectory, "package.nupkg");
        await verifyArtifact(versionManifest.artifacts?.nupkg, nupkgPath, versionEntry.filePath, errors);

        if (versionManifest.artifacts?.snupkg?.url) {
          const snupkgPath = path.join(cacheDirectory, "package.snupkg");
          await verifyArtifact(versionManifest.artifacts.snupkg, snupkgPath, versionEntry.filePath, errors);
        }
        if (versionManifest.artifacts?.symbols?.url) {
          const symbolsPath = path.join(cacheDirectory, "package.symbols.nupkg");
          await verifyArtifact(versionManifest.artifacts.symbols, symbolsPath, versionEntry.filePath, errors);
        }

        const nuspecText = await readNuspecFromNupkg(nupkgPath);
        const metadata = readNuspecMetadata(nuspecText);
        if (metadata.id !== packageManifest.id) {
          errors.push(`${versionEntry.filePath}: nuspec id ${metadata.id} does not match ${packageManifest.id}`);
        }
        if (metadata.version !== versionManifest.version) {
          errors.push(`${versionEntry.filePath}: nuspec version ${metadata.version} does not match ${versionManifest.version}`);
        }

        records.push({
          package: packageManifest,
          version: versionManifest,
          nuspecText,
          metadata,
          assets: await readPackageAssets(nupkgPath, metadata),
          manifestPath: versionEntry.filePath
        });
      } catch (error: unknown) {
        errors.push(`${versionEntry.filePath}: ${errorMessage(error)}`);
      }
    }
  }

  return { records, errors };
}

async function verifyArtifact(
  artifact: RequiredArtifactManifest | undefined,
  filePath: string,
  manifestPath: string,
  errors: string[]
): Promise<void> {
  if (!artifact?.url || !artifact?.sha256) {
    return;
  }
  await downloadIfNeeded(artifact.url, filePath);
  const actual = await sha256File(filePath);
  if (actual.toLowerCase() !== artifact.sha256.toLowerCase()) {
    errors.push(`${manifestPath}: SHA256 mismatch for ${artifact.url}; expected ${artifact.sha256}, got ${actual}`);
  }
}

function validateArtifact(errors: string[], artifact: ArtifactManifest | undefined, label: string, required: boolean): void {
  if (!artifact) {
    if (required) {
      errors.push(`${label}: missing required artifact`);
    }
    return;
  }

  const url = expectString(errors, artifact.url, `${label}.url`);
  const sha256 = expectString(errors, artifact.sha256, `${label}.sha256`);
  if (url && !isGitHubReleaseAssetUrl(url)) {
    errors.push(`${label}.url must be a GitHub Release asset URL`);
  }
  if (sha256 && !/^[0-9a-fA-F]{64}$/.test(sha256)) {
    errors.push(`${label}.sha256 must be 64 hexadecimal characters`);
  }
}

function expectString(errors: string[], value: string | undefined, label: string): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} is required`);
    return null;
  }
  return value;
}

function asRequiredPackageManifest(manifest: PackageManifest): RequiredPackageManifest | null {
  if (
    typeof manifest.id !== "string" ||
    typeof manifest.lowerId !== "string" ||
    typeof manifest.source?.repository !== "string"
  ) {
    return null;
  }

  const required: RequiredPackageManifest = {
    id: manifest.id,
    lowerId: manifest.lowerId,
    source: {
      repository: manifest.source.repository
    }
  };
  if (manifest.policy) {
    required.policy = manifest.policy;
  }
  return required;
}

function asRequiredVersionManifest(manifest: VersionManifest): RequiredVersionManifest | null {
  const nupkg = asRequiredArtifactManifest(manifest.artifacts?.nupkg);
  const snupkg = asRequiredArtifactManifest(manifest.artifacts?.snupkg);
  const symbols = asRequiredArtifactManifest(manifest.artifacts?.symbols);
  if (
    typeof manifest.version !== "string" ||
    typeof manifest.lowerVersion !== "string" ||
    typeof manifest.source?.repository !== "string" ||
    typeof manifest.source.commit !== "string" ||
    typeof manifest.source.tag !== "string" ||
    typeof manifest.source.workflowRun !== "string" ||
    !nupkg
  ) {
    return null;
  }

  const required: RequiredVersionManifest = {
    version: manifest.version,
    lowerVersion: manifest.lowerVersion,
    listed: manifest.listed ?? true,
    source: {
      repository: manifest.source.repository,
      commit: manifest.source.commit,
      tag: manifest.source.tag,
      workflowRun: manifest.source.workflowRun
    },
    artifacts: buildRequiredArtifacts(nupkg, snupkg, symbols)
  };
  if (typeof manifest.review?.reason === "string") {
    required.review = {
      reason: manifest.review.reason
    };
  }
  return required;
}

function buildRequiredArtifacts(
  nupkg: RequiredArtifactManifest,
  snupkg: RequiredArtifactManifest | undefined,
  symbols: RequiredArtifactManifest | undefined
): RequiredVersionManifest["artifacts"] {
  const artifacts: RequiredVersionManifest["artifacts"] = { nupkg };
  if (snupkg) {
    artifacts.snupkg = snupkg;
  }
  if (symbols) {
    artifacts.symbols = symbols;
  }
  return artifacts;
}

function asRequiredArtifactManifest(artifact: ArtifactManifest | undefined): RequiredArtifactManifest | undefined {
  if (typeof artifact?.url !== "string" || typeof artifact.sha256 !== "string") {
    return undefined;
  }
  return {
    url: artifact.url,
    sha256: artifact.sha256
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
