export function isGitHubReleaseAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com") {
      return false;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 6 && parts[2] === "releases" && parts[3] === "download";
  } catch {
    return false;
  }
}

export function buildGitHubReleaseAssetUrl(repository: string, tag: string, fileName: string): string {
  const url = new URL(`https://github.com/${repository}/releases/download/`);
  url.pathname += `${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
  return url.toString();
}
