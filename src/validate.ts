import path from "node:path";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { buildVerifiedRecords, readBucket } from "./lib/bucket.ts";
import { walkFiles, readText } from "./lib/file-system.ts";
import { FEED_BASE_URL } from "./lib/nuget-v3.ts";

const rootDirectory = process.cwd();
const feedBaseUrl = new URL(process.env.FEED_BASE_URL ?? FEED_BASE_URL).origin;
const bucket = await readBucket(rootDirectory);
const { errors: verificationErrors } = await buildVerifiedRecords(bucket);
const generatedErrors = await validateGenerated(rootDirectory);
const errors = [...new Set([...verificationErrors, ...generatedErrors])];

if (errors.length > 0) {
  console.error("NuGet feed validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`NuGet feed validation passed (${bucket.packages.length} package manifest(s)).`);

async function validateGenerated(root: string): Promise<string[]> {
  const errors: string[] = [];
  const generatedDirectory = path.join(root, "generated");
  const files = await walkFiles(generatedDirectory);
  if (files.length === 0) {
    return errors;
  }
  const jsonDocuments = new Map<string, unknown>();

  for (const file of files) {
    const lower = file.toLowerCase();
    if (lower.endsWith(".nupkg") || lower.endsWith(".snupkg")) {
      errors.push(`${file}: generated output must not contain package binaries`);
    }
    try {
      if (lower.endsWith(".json")) {
        jsonDocuments.set(file, JSON.parse(await readText(file)));
      }
      if (lower.endsWith(".json.gz")) {
        const content = gunzipSync(await readFile(file)).toString("utf8");
        if (content !== await readText(file.slice(0, -3))) {
          errors.push(`${file}: gzip content does not match its registration JSON`);
        }
      }
    } catch (error: unknown) {
      errors.push(`${file}: ${errorMessage(error)}`);
    }
  }

  const routesPath = path.join(generatedDirectory, "routes.json");
  const routes = jsonDocuments.get(routesPath);
  const routeKeys = new Set(routes && typeof routes === "object" ? Object.keys(routes) : []);
  for (const relative of ["routes.json", "discovery.json", "v3/index.json"]) {
    if (!jsonDocuments.has(path.join(generatedDirectory, relative))) {
      errors.push(`${relative}: required generated JSON missing or invalid; run pnpm generate`);
    }
  }
  for (const [file, document] of jsonDocuments) {
    for (const reference of feedReferences(document)) {
      const url = new URL(reference);
      const pathname = decodeURIComponent(url.pathname);
      if (["/v3/query", "/v3/autocomplete"].includes(pathname)) {
        continue;
      }
      if (pathname.endsWith(".nupkg")) {
        const parts = pathname.split("/");
        if (!routeKeys.has(`${parts[2]}@${parts[3]}`)) {
          errors.push(`${file}: missing package route ${reference}`);
        }
        continue;
      }
      const target = path.resolve(generatedDirectory, pathname.slice(1));
      const hasTarget = pathname.endsWith("/") ? files.some((candidate) => candidate.startsWith(target + path.sep)) : files.includes(target);
      if (!hasTarget) {
        errors.push(`${file}: unresolved feed reference ${reference}`);
      }
    }
    if (file.includes(`${path.sep}registration${path.sep}`) && !files.includes(`${file}.gz`)) {
      errors.push(`${file}: missing gzip registration companion`);
    }
  }
  return errors;
}

function feedReferences(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(feedReferences);
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => {
      if (["@id", "registration", "registrationLeaf", "packageContent", "catalogEntry", "iconUrl", "licenseUrl", "readmeUrl"].includes(key) && typeof child === "string") {
        return child.startsWith(`${feedBaseUrl}/`) ? [child] : [];
      }
      return feedReferences(child);
    });
  }
  return [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
