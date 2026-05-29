import { appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function setOutput(name: string, value: string): Promise<void> {
  if (process.env.GITHUB_OUTPUT) {
    return appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
  }
  return Promise.resolve();
}

try {
  git(["fetch", "origin", "main"]);
  const head = git(["rev-parse", "HEAD"]);
  const originMain = git(["rev-parse", "origin/main"]);
  const latest = head === originMain;
  await setOutput("latest", latest ? "true" : "false");

  if (latest) {
    console.log(`HEAD ${head} is the latest origin/main.`);
  } else {
    console.log(`HEAD ${head} is older than origin/main ${originMain}; deployment steps should be skipped.`);
  }
} catch (error: unknown) {
  console.error(`failed to check latest main: ${errorMessage(error)}`);
  process.exit(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
