import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { walkFiles } from "../../../src/lib/file-system.ts";

type ReleaseAssetInput = {
  releaseTag: string;
  artifactsDirectory: string;
  sourceRepository: string;
  sourceCommit: string;
  workspace: string;
};

const input: ReleaseAssetInput = {
  releaseTag: requiredEnv("RELEASE_TAG"),
  artifactsDirectory: process.env.ARTIFACTS_DIRECTORY || "artifacts",
  sourceRepository: requiredEnv("GITHUB_REPOSITORY"),
  sourceCommit: requiredEnv("GITHUB_SHA"),
  workspace: requiredEnv("GITHUB_WORKSPACE")
};

const artifactsDirectory = resolve(input.workspace, input.artifactsDirectory);
const assets = (await walkFiles(artifactsDirectory))
  .filter((file) => file.toLowerCase().endsWith(".nupkg") || file.toLowerCase().endsWith(".snupkg"))
  .sort((left, right) => left.localeCompare(right));

if (assets.length === 0) {
  throw new Error(`expected at least one .nupkg or .snupkg in ${artifactsDirectory}`);
}

if (!releaseExists(input.sourceRepository, input.releaseTag)) {
  gh([
    "release",
    "create",
    input.releaseTag,
    "--repo",
    input.sourceRepository,
    "--target",
    input.sourceCommit,
    "--title",
    input.releaseTag,
    "--notes",
    `NuGet packages from ${input.sourceCommit}.`
  ]);
}

gh([
  "release",
  "upload",
  input.releaseTag,
  ...assets,
  "--repo",
  input.sourceRepository,
  "--clobber"
]);

console.log(`Uploaded ${assets.length} package asset(s) to ${input.sourceRepository} release ${input.releaseTag}.`);

function releaseExists(repository: string, releaseTag: string): boolean {
  try {
    gh(["release", "view", releaseTag, "--repo", repository]);
    return true;
  } catch {
    return false;
  }
}

function gh(args: string[]): void {
  execFileSync("gh", args, {
    stdio: "inherit",
    env: process.env
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}
