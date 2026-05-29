import type { SimpleYamlObject, SimpleYamlScalar } from "./types.ts";

export function parseSimpleYaml<T extends object = SimpleYamlObject>(text: string, filePath = "YAML"): T {
  const root: SimpleYamlObject = {};
  const stack = [{ indent: -1, value: root }];
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const lineNumber = index + 1;
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }
    if (rawLine.includes("\t")) {
      throw new Error(`${filePath}:${lineNumber}: tabs are not supported`);
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent % 2 !== 0) {
      throw new Error(`${filePath}:${lineNumber}: indentation must use two-space levels`);
    }

    const trimmed = rawLine.trim();
    if (trimmed.startsWith("- ")) {
      throw new Error(`${filePath}:${lineNumber}: sequences are not supported in bucket YAML`);
    }

    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      throw new Error(`${filePath}:${lineNumber}: expected key: value`);
    }

    const key = trimmed.slice(0, separator).trim();
    const rest = trimmed.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new Error(`${filePath}:${lineNumber}: invalid key "${key}"`);
    }

    while (stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;
    if (Object.prototype.hasOwnProperty.call(parent, key)) {
      throw new Error(`${filePath}:${lineNumber}: duplicate key "${key}"`);
    }

    if (rest === "") {
      const child: SimpleYamlObject = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = parseScalar(rest);
    }
  }

  return root as unknown as T;
}

export function stringifySimpleYaml(value: SimpleYamlObject): string {
  return `${stringifyObject(value, 0).join("\n")}\n`;
}

function stringifyObject(value: SimpleYamlObject, indent: number): string[] {
  const lines: string[] = [];
  const padding = " ".repeat(indent);

  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      lines.push(`${padding}${key}:`);
      lines.push(...stringifyObject(child, indent + 2));
    } else {
      lines.push(`${padding}${key}: ${formatScalar(child as SimpleYamlScalar)}`);
    }
  }

  return lines;
}

function parseScalar(value: string): SimpleYamlScalar {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null") {
    return null;
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function formatScalar(value: SimpleYamlScalar): string {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (value === null || value === undefined) {
    return "null";
  }
  const text = String(value);
  if (!text || /^[\s]|[\s]$/.test(text) || /[:#]/.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}
