import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { releaseBatch, sanitizedReleaseTag } from "../../../src/lib/release-batch.ts";
import type { ReleasedPackage } from "../../../src/lib/release-batch.ts";

type ReleaseInput = {
  feedRepository: string;
  feedRepositoryPath: string;
  releaseTag: string;
  artifactsDirectory: string;
  sourceRepository: string;
  sourceCommit: string;
  serverUrl: string;
  runId: string;
  workspace: string;
};

const input: ReleaseInput = {
  feedRepository: requiredEnv("FEED_REPOSITORY"),
  feedRepositoryPath: requiredEnv("FEED_REPOSITORY_PATH"),
  releaseTag: requiredEnv("RELEASE_TAG"),
  artifactsDirectory: process.env.ARTIFACTS_DIRECTORY || "artifacts",
  sourceRepository: requiredEnv("GITHUB_REPOSITORY"),
  sourceCommit: requiredEnv("GITHUB_SHA"),
  serverUrl: process.env.GITHUB_SERVER_URL || "https://github.com",
  runId: requiredEnv("GITHUB_RUN_ID"),
  workspace: requiredEnv("GITHUB_WORKSPACE")
};

const releasedPackages = await releaseBatch({
  feedRepositoryPath: input.feedRepositoryPath,
  artifactsDirectory: resolve(input.workspace, input.artifactsDirectory),
  releaseTag: input.releaseTag,
  sourceRepository: input.sourceRepository,
  sourceCommit: input.sourceCommit,
  serverUrl: input.serverUrl,
  runId: input.runId
});

const branch = `release/batch/${sanitizedReleaseTag(input.releaseTag)}`;
git(["config", "user.name", "sylinko-nuget-feed-release"], input.feedRepositoryPath);
git(["config", "user.email", "actions@github.com"], input.feedRepositoryPath);
git(["checkout", "-B", branch], input.feedRepositoryPath);
git(["add", ...releasedPackages.map((item) => item.manifestPath)], input.feedRepositoryPath);
git(["commit", "-m", `Release packages from ${input.releaseTag}`], input.feedRepositoryPath);
git(["push", "-u", "origin", branch], input.feedRepositoryPath);

const body = [
  `Releases packages from \`${input.releaseTag}\` to the Sylinko NuGet feed.`,
  "",
  ...packageLines(releasedPackages),
  "",
  `Source: ${input.sourceRepository}@${input.sourceCommit}`,
  `Release tag: ${input.releaseTag}`
].join("\n");

git([
  "pr",
  "create",
  "--repo",
  input.feedRepository,
  "--base",
  "main",
  "--head",
  branch,
  "--title",
  `Release packages from ${input.releaseTag}`,
  "--body",
  body
], input.feedRepositoryPath, "gh");

console.log(`Created release PR for ${releasedPackages.length} package(s) from ${input.releaseTag}.`);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

function git(args: string[], cwd: string, command = "git"): void {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env
  });
}

function packageLines(packages: ReleasedPackage[]): string[] {
  return packages.map((item) => `- ${item.id} ${item.version}`);
}
