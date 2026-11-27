import { execFileSync } from "node:child_process";

export type UploadReleaseAssetsInput = {
  releaseTag: string;
  assetPaths: string[];
  sourceRepository: string;
  sourceCommit: string;
  token: string;
};

export type DownloadExistingReleaseAssetsInput = {
  releaseTag: string;
  sourceRepository: string;
  targetDirectory: string;
  token: string;
};

export function uploadGitHubReleaseAssets(input: UploadReleaseAssetsInput): void {
  if (input.assetPaths.length === 0) {
    throw new Error("expected at least one validated package asset to upload");
  }

  if (!releaseExists(input.sourceRepository, input.releaseTag, input.token)) {
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
    ], input.token);
  }

  gh([
    "release",
    "upload",
    input.releaseTag,
    ...input.assetPaths,
    "--repo",
    input.sourceRepository,
    "--clobber"
  ], input.token);

  console.log(`Uploaded ${input.assetPaths.length} package asset(s) to ${input.sourceRepository} release ${input.releaseTag}.`);
}

export function downloadExistingReleaseAssets(input: DownloadExistingReleaseAssetsInput): { targetCommit: string | undefined } {
  const rawCommitish = ghQuery([
    "release",
    "view",
    input.releaseTag,
    "--repo",
    input.sourceRepository,
    "--json",
    "targetCommitish",
    "--jq",
    ".targetCommitish"
  ], input.token).trim();

  gh([
    "release",
    "download",
    input.releaseTag,
    "--repo",
    input.sourceRepository,
    "--dir",
    input.targetDirectory,
    "--pattern",
    "*.nupkg",
    "--pattern",
    "*.snupkg"
  ], input.token);

  const targetCommit = /^[0-9a-f]{40}$/i.test(rawCommitish) ? rawCommitish : undefined;
  return { targetCommit };
}

function releaseExists(repository: string, releaseTag: string, token: string): boolean {
  try {
    ghQuery(["release", "view", releaseTag, "--repo", repository, "--json", "tagName", "--jq", ".tagName"], token);
    return true;
  } catch {
    return false;
  }
}

function gh(args: string[], token: string): void {
  execFileSync("gh", args, {
    stdio: "inherit",
    env: { ...process.env, GH_TOKEN: token }
  });
}

function ghQuery(args: string[], token: string): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GH_TOKEN: token }
  });
}
