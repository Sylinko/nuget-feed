import { isMap, parseDocument, stringify, visit } from "yaml";

export function parseManifestYaml<T extends object>(text: string, filePath = "YAML"): T {
  const document = parseDocument(text, { version: "1.2", uniqueKeys: true });
  if (document.errors.length || document.warnings.length) {
    throw new Error(`${filePath}: ${[...document.errors, ...document.warnings].map((error) => error.message).join("; ")}`);
  }
  if (!isMap(document.contents)) {
    throw new Error(`${filePath}: expected a YAML mapping`);
  }
  visit(document, (_, node) => {
    if (node && typeof node === "object" && "tag" in node && node.tag) {
      throw new Error(`${filePath}: explicit YAML tags are not supported`);
    }
  });
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  validateMapping(value, filePath);
  return value as T;
}

export function stringifyManifestYaml(value: object): string {
  return stringify(value, { indent: 2, lineWidth: 0 });
}

function validateMapping(value: unknown, label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected a YAML mapping`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new Error(`${label}: unsupported manifest key ${key}`);
    }
    if (child !== null && typeof child === "object") {
      validateMapping(child, `${label}.${key}`);
    } else if (child !== null && typeof child !== "string" && typeof child !== "boolean") {
      throw new Error(`${label}.${key}: expected a string or boolean; quote numeric-looking strings`);
    }
  }
}
