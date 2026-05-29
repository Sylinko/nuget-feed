export function lowerNuGetId(id: string): string {
  return id.toLowerCase();
}

export function isValidPackageId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

export function isValidNuGetVersion(version: string): boolean {
  return typeof version === "string" && /^[0-9]+(?:\.[0-9]+){1,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

export function assertLowercase(value: string): boolean {
  return typeof value === "string" && value === value.toLowerCase();
}

export function compareVersionsText(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}
