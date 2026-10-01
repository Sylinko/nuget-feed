import { SemVer, compare, valid } from "semver";
import type { PackageMetadata } from "./types.ts";

export function lowerNuGetId(id: string): string {
  return id.toLowerCase();
}

export function isValidPackageId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

/** This feed publishes three-part SemVer versions; it does not evaluate NuGet ranges. */
export function isValidNuGetVersion(version: string): boolean {
  return typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+]|$)/.test(version) && valid(version) !== null;
}

/** NuGet identities ignore build metadata and prerelease casing. */
export function lowerNuGetVersion(version: string): string {
  return new SemVer(version.toLowerCase()).version;
}

export function assertLowercase(value: string): boolean {
  return typeof value === "string" && value === value.toLowerCase();
}

export function compareVersionsText(left: string, right: string): number {
  return compare(left.toLowerCase(), right.toLowerCase());
}

export function isPrereleaseVersion(version: string): boolean {
  return new SemVer(version).prerelease.length > 0;
}

export function isSemVer2Package(metadata: PackageMetadata): boolean {
  const version = new SemVer(metadata.version);
  if (version.build.length > 0 || version.prerelease.length > 1) {
    return true;
  }
  // Recognize only SemVer2 traits in dependency-bound text. Preserve ranges verbatim;
  // this does not parse, normalize, or evaluate NuGet range semantics.
  return metadata.dependencyGroups.some((group) => group.dependencies.some((dependency) =>
    dependency.range !== undefined && /\+|-[^,\]\)\s]*\./.test(dependency.range)
  ));
}
