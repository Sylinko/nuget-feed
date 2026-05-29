import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { JsonValue } from "./types.ts";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function readText(filePath: string): Promise<string> {
  return await readFile(filePath, "utf8");
}

export async function ensureDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

export async function cleanDir(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await ensureDir(directory);
}

export async function writeText(filePath: string, text: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, text, "utf8");
}

export async function writeJson(filePath: string, value: JsonValue): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function listDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function walkFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(current: string): Promise<void> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile()) {
        output.push(child);
      }
    }
  }

  await visit(directory);
  return output.sort();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
