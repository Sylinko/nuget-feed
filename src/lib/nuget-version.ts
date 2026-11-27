import type { PackageMetadata } from "./types.ts";

const INT32_MAX = 2_147_483_647;
const LABEL_SEGMENT = /^[0-9A-Za-z-]+$/;
const DIGITS = /^\d+$/;

export type ParsedNuGetVersion = {
  major: number;
  minor: number;
  patch: number;
  revision: number;
  releaseLabels: readonly string[];
  metadata: string | undefined;
  normalized: string;
};

export function lowerNuGetId(id: string): string {
  return id.toLowerCase();
}

export function isValidPackageId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

/** Supports standard 1–4 part NuGet versions per NuGet.Versioning rules; does not evaluate ranges. */
export function parseNuGetVersion(version: string): ParsedNuGetVersion | null {
  if (typeof version !== "string" || version.length === 0 || version.trim() !== version) {
    return null;
  }

  let metadata: string | undefined;
  let versionAndRelease = version;
  const plusIndex = version.indexOf("+");
  if (plusIndex >= 0) {
    metadata = version.slice(plusIndex + 1);
    versionAndRelease = version.slice(0, plusIndex);
    if (metadata.length === 0) {
      return null;
    }
    for (const part of metadata.split(".")) {
      if (!LABEL_SEGMENT.test(part)) {
        return null;
      }
    }
  }

  let releaseLabels: readonly string[] = [];
  let versionCore = versionAndRelease;
  const dashIndex = versionAndRelease.indexOf("-");
  if (dashIndex >= 0) {
    const releasePart = versionAndRelease.slice(dashIndex + 1);
    versionCore = versionAndRelease.slice(0, dashIndex);
    if (releasePart.length === 0) {
      return null;
    }
    const labels = releasePart.split(".");
    for (const label of labels) {
      if (!LABEL_SEGMENT.test(label)) {
        return null;
      }
      if (DIGITS.test(label) && label.length > 1 && label.startsWith("0")) {
        return null;
      }
    }
    releaseLabels = labels;
  }

  const coreParts = versionCore.split(".");
  if (coreParts.length < 1 || coreParts.length > 4) {
    return null;
  }

  const numbers: number[] = [];
  for (const part of coreParts) {
    if (!DIGITS.test(part)) {
      return null;
    }
    const num = Number(part);
    if (!Number.isSafeInteger(num) || num < 0 || num > INT32_MAX) {
      return null;
    }
    numbers.push(num);
  }

  const [major, minor = 0, patch = 0, revision = 0] = numbers;
  const normalizedCore = revision > 0 ? `${major}.${minor}.${patch}.${revision}` : `${major}.${minor}.${patch}`;
  const normalized = releaseLabels.length > 0 ? `${normalizedCore}-${releaseLabels.join(".")}` : normalizedCore;

  return { major, minor, patch, revision, releaseLabels, metadata, normalized };
}

export function isValidNuGetVersion(version: string): boolean {
  return parseNuGetVersion(version) !== null;
}

/** NuGet identities ignore build metadata, trailing zero revision, and prerelease casing. */
export function lowerNuGetVersion(version: string): string {
  return parseOrThrow(version).normalized.toLowerCase();
}

export function assertLowercase(value: string): boolean {
  return typeof value === "string" && value === value.toLowerCase();
}

export function compareVersionsText(left: string, right: string): number {
  const a = parseOrThrow(left);
  const b = parseOrThrow(right);

  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.revision !== b.revision) return a.revision < b.revision ? -1 : 1;

  if (a.releaseLabels.length === 0 && b.releaseLabels.length === 0) return 0;
  if (a.releaseLabels.length === 0) return 1;
  if (b.releaseLabels.length === 0) return -1;

  const limit = Math.min(a.releaseLabels.length, b.releaseLabels.length);
  for (let i = 0; i < limit; i++) {
    const la = a.releaseLabels[i];
    const lb = b.releaseLabels[i];
    const aIsNum = DIGITS.test(la);
    const bIsNum = DIGITS.test(lb);

    if (aIsNum && bIsNum) {
      const na = BigInt(la);
      const nb = BigInt(lb);
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (aIsNum !== bIsNum) {
      return aIsNum ? -1 : 1;
    } else {
      const ca = la.toLowerCase();
      const cb = lb.toLowerCase();
      if (ca !== cb) return ca < cb ? -1 : 1;
    }
  }

  return Math.sign(a.releaseLabels.length - b.releaseLabels.length);
}

export function isPrereleaseVersion(version: string): boolean {
  return parseOrThrow(version).releaseLabels.length > 0;
}

export function isSemVer2Package(metadata: PackageMetadata): boolean {
  const version = parseOrThrow(metadata.version);
  if (version.metadata !== undefined || version.releaseLabels.length > 1) {
    return true;
  }
  // Recognize only SemVer2 traits in dependency-bound text. Preserve ranges verbatim;
  // this does not parse, normalize, or evaluate NuGet range semantics.
  return metadata.dependencyGroups.some((group) => group.dependencies.some((dependency) =>
    dependency.range !== undefined && /\+|-[^,\]\)\s]*\./.test(dependency.range)
  ));
}

function parseOrThrow(version: string): ParsedNuGetVersion {
  const parsed = parseNuGetVersion(version);
  if (!parsed) {
    throw new Error(`Invalid NuGet version: ${version}`);
  }
  return parsed;
}
