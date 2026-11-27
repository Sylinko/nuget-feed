import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { releaseBatch, sanitizedReleaseTag } from "../../../src/lib/release-batch.ts";
import type { ReleasedPackage } from "../../../src/lib/release-batch.ts";
import { downloadExistingReleaseAssets, uploadGitHubReleaseAssets } from "./create-github-release.ts";

type ReleaseInput = {
  feedToken: string;
  githubToken: string;
  feedRepository: string;
  feedRepositoryPath: string;
  releaseTag: string;
  artifactsDirectory: string;
  reuseExistingRelease: boolean;
  sourceRepository: string;
  sourceCommit: string;
  serverUrl: string;
  runId: string;
  workspace: string;
};

const input: ReleaseInput = {
  feedToken: requiredEnv("FEED_TOKEN"),
  githubToken: requiredEnv("GITHUB_TOKEN"),
  feedRepository: requiredEnv("FEED_REPOSITORY"),
  feedRepositoryPath: requiredEnv("FEED_REPOSITORY_PATH"),
  releaseTag: requiredEnv("RELEASE_TAG"),
  artifactsDirectory: process.env.ARTIFACTS_DIRECTORY || "artifacts",
  reuseExistingRelease: (process.env.REUSE_EXISTING_RELEASE || "false").toLowerCase() === "true",
  sourceRepository: requiredEnv("GITHUB_REPOSITORY"),
  sourceCommit: requiredEnv("GITHUB_SHA"),
  serverUrl: process.env.GITHUB_SERVER_URL || "https://github.com",
  runId: requiredEnv("GITHUB_RUN_ID"),
  workspace: requiredEnv("GITHUB_WORKSPACE")
};

let temporaryArtifactsDirectory: string | undefined;

try {
  // 1. Acquire artifacts (from workspace build outputs or an existing GitHub Release).
  let artifactsDirectory = resolve(input.workspace, input.artifactsDirectory);
  let effectiveCommit = input.sourceCommit;
  if (input.reuseExistingRelease) {
    temporaryArtifactsDirectory = await mkdtemp(join(tmpdir(), "sylinko-nuget-reuse-"));
    artifactsDirectory = temporaryArtifactsDirectory;
    const { targetCommit } = downloadExistingReleaseAssets({
      releaseTag: input.releaseTag,
      sourceRepository: input.sourceRepository,
      targetDirectory: artifactsDirectory,
      token: input.githubToken
    });
    effectiveCommit = targetCommit ?? input.sourceCommit;
  }

  // 2. Validate package identities, versions, and feed immutability BEFORE any remote mutations.
  const releasedPackages = await releaseBatch({
    feedRepositoryPath: input.feedRepositoryPath,
    artifactsDirectory,
    releaseTag: input.releaseTag,
    sourceRepository: input.sourceRepository,
    sourceCommit: effectiveCommit,
    serverUrl: input.serverUrl,
    runId: input.runId
  });

  // 3. Create/update the producer GitHub Release only after feed validation succeeds.
  if (!input.reuseExistingRelease) {
    uploadGitHubReleaseAssets({
      releaseTag: input.releaseTag,
      assetPaths: collectAssetPaths(releasedPackages),
      sourceRepository: input.sourceRepository,
      sourceCommit: effectiveCommit,
      token: input.githubToken
    });
  }

  // 4. Push branch and create or update the feed PR idempotently.
  const branch = `release/batch/${sanitizedReleaseTag(input.releaseTag)}`;
  run("git", ["config", "user.name", "sylinko-nuget-feed-release"], input.feedRepositoryPath, input.feedToken);
  run("git", ["config", "user.email", "actions@github.com"], input.feedRepositoryPath, input.feedToken);
  run("git", ["checkout", "-B", branch], input.feedRepositoryPath, input.feedToken);
  run("git", ["add", ...releasedPackages.map((item) => item.manifestPath)], input.feedRepositoryPath, input.feedToken);
  run("git", ["commit", "-m", `Release packages from ${input.releaseTag}`], input.feedRepositoryPath, input.feedToken);
  run("git", ["push", "--force", "-u", "origin", branch], input.feedRepositoryPath, input.feedToken);

  const title = `Release packages from ${input.releaseTag}`;
  const body = [
    `Releases packages from \`${input.releaseTag}\` to the Sylinko NuGet feed.`,
    "",
    ...packageLines(releasedPackages),
    "",
    `Source: ${input.sourceRepository}@${effectiveCommit}`,
    `Release tag: ${input.releaseTag}`
  ].join("\n");

  const existingPrNumber = runQuery("gh", [
    "pr",
    "list",
    "--repo",
    input.feedRepository,
    "--base",
    "main",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[0].number"
  ], input.feedRepositoryPath, input.feedToken).trim();

  if (existingPrNumber) {
    run("gh", [
      "pr",
      "edit",
      existingPrNumber,
      "--repo",
      input.feedRepository,
      "--title",
      title,
      "--body",
      body
    ], input.feedRepositoryPath, input.feedToken);
    console.log(`Updated release PR #${existingPrNumber} for ${releasedPackages.length} package(s) from ${input.releaseTag}.`);
  } else {
    run("gh", [
      "pr",
      "create",
      "--repo",
      input.feedRepository,
      "--base",
      "main",
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body
    ], input.feedRepositoryPath, input.feedToken);
    console.log(`Created release PR for ${releasedPackages.length} package(s) from ${input.releaseTag}.`);
  }
} finally {
  if (temporaryArtifactsDirectory) {
    await rm(temporaryArtifactsDirectory, { recursive: true, force: true });
  }
}

function collectAssetPaths(packages: ReleasedPackage[]): string[] {
  const paths: string[] = [];
  for (const item of packages) {
    paths.push(item.nupkgPath);
    if (item.snupkgPath) paths.push(item.snupkgPath);
    if (item.symbolsPath) paths.push(item.symbolsPath);
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

function run(command: string, args: string[], cwd: string, token: string): void {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, GH_TOKEN: token }
  });
}

function runQuery(command: string, args: string[], cwd: string, token: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GH_TOKEN: token }
  });
}

function packageLines(packages: ReleasedPackage[]): string[] {
  return packages.map((item) => `- ${item.id} ${item.version}`);
}
