import path from "node:path";
import { buildVerifiedRecords, readBucket } from "./lib/bucket.ts";
import { walkFiles, readText } from "./lib/file-system.ts";

const rootDirectory = process.cwd();
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

  for (const file of files) {
    const lower = file.toLowerCase();
    if (lower.endsWith(".nupkg") || lower.endsWith(".snupkg")) {
      errors.push(`${file}: generated output must not contain package binaries`);
    }
  }

  const serviceIndexPath = path.join(generatedDirectory, "v3", "index.json");
  if (files.includes(serviceIndexPath)) {
    try {
      JSON.parse(await readText(serviceIndexPath));
    } catch (error: unknown) {
      errors.push(`${serviceIndexPath}: invalid JSON: ${errorMessage(error)}`);
    }
  }

  const routesPath = path.join(generatedDirectory, "routes.json");
  if (files.includes(routesPath)) {
    try {
      const routes = JSON.parse(await readText(routesPath));
      const keys = Object.keys(routes);
      if (new Set(keys).size !== keys.length) {
        errors.push(`${routesPath}: duplicate route key`);
      }
    } catch (error: unknown) {
      errors.push(`${routesPath}: invalid JSON: ${errorMessage(error)}`);
    }
  }

  return errors;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
