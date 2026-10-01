/// <reference path="../worker-configuration.d.ts" />
import { gte, valid } from "semver";
import type { DiscoveryIndex, DiscoveryPackage, DiscoveryVersion } from "../../src/lib/discovery.ts";

type Route = { id: string; version: string; nupkg: string; sha256: string };
type QueryOptions = { skip: number; take: number; shouldIncludePrerelease: boolean; shouldIncludeSemVer2: boolean; packageType: string };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const url = new URL(request.url);
    try {
      const endpoint = url.pathname.replace(/\/$/, "");
      if (endpoint === "/v3/query" || endpoint === "/v3/autocomplete") {
        const options = parseQueryOptions(url.searchParams);
        const discovery = await readAssetJson<DiscoveryIndex>(request, env, "/discovery.json");
        if (discovery.schemaVersion !== 1 || !Array.isArray(discovery.packages)) {
          throw new Error("Unsupported discovery asset schema");
        }
        const body = endpoint === "/v3/query" ? search(discovery, url.searchParams, options) : autocomplete(discovery, url.searchParams, options);
        return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" }
        });
      }
      const nupkgRoute = parseNupkgRoute(url.pathname);
      if (nupkgRoute) {
        const routes = await readAssetJson<Record<string, Route>>(request, env, "/routes.json");
        const route = routes[`${nupkgRoute.lowerId}@${nupkgRoute.lowerVersion}`];
        if (!route) {
          return new Response(request.method === "HEAD" ? null : "Package not found", { status: 404 });
        }
        return new Response(null, {
          status: 307,
          headers: { Location: route.nupkg, "Cache-Control": "public, max-age=300" }
        });
      }
      if (url.pathname.startsWith("/v3/registration/") && url.pathname.endsWith(".json")) {
        const assetUrl = new URL(`${url.pathname}.gz`, request.url);
        const response = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
        if (!response.ok) {
          return new Response(request.method === "HEAD" ? null : "Registration not found", { status: response.status });
        }
        return new Response(request.method === "HEAD" ? null : response.body, {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Encoding": "gzip",
            "Cache-Control": "no-cache"
          },
          encodeBody: "manual"
        });
      }
      return env.ASSETS.fetch(request);
    } catch (error: unknown) {
      if (error instanceof URIError || error instanceof QueryParameterError) {
        return new Response(request.method === "HEAD" ? null : error.message, { status: 400 });
      }
      console.error(JSON.stringify({ event: "feed_request_failed", path: url.pathname, error: error instanceof Error ? error.message : String(error) }));
      return new Response(request.method === "HEAD" ? null : "Feed metadata unavailable", { status: 503 });
    }
  }
} satisfies ExportedHandler<Env>;

function search(discovery: DiscoveryIndex, parameters: URLSearchParams, options: QueryOptions): object {
  const terms = (parameters.get("q") ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];
  for (const item of discovery.packages) {
    const versions = eligibleVersions(item, options);
    const latest = versions.at(-1);
    if (!latest) {
      continue;
    }
    const metadata = latest.metadata;
    const text = [item.id, metadata.title, metadata.description, metadata.summary, ...metadata.tags].filter(Boolean).join(" ").toLowerCase();
    if (!terms.every((term) => text.includes(term))) {
      continue;
    }
    results.push({
      id: item.id,
      version: latest.version,
      ...metadata,
      registration: item.registration,
      versions: versions.map((version) => ({ "@id": version.registrationLeaf, version: version.version, downloads: 0 }))
    });
  }
  return { totalHits: results.length, data: results.slice(options.skip, options.skip + options.take) };
}

function autocomplete(discovery: DiscoveryIndex, parameters: URLSearchParams, options: QueryOptions): object {
  const id = parameters.get("id");
  if (id !== null) {
    const item = discovery.packages.find((item) => item.lowerId === id.toLowerCase());
    return { data: item ? eligibleVersions(item, options).map((version) => version.version) : [] };
  }
  const query = (parameters.get("q") ?? "").trim().toLowerCase();
  const ids = discovery.packages.filter((item) => item.lowerId.includes(query) && eligibleVersions(item, options).length > 0).map((item) => item.id);
  return { totalHits: ids.length, data: ids.slice(options.skip, options.skip + options.take) };
}

function eligibleVersions(item: DiscoveryPackage, options: QueryOptions): DiscoveryVersion[] {
  return item.versions.filter((version) => version.listed &&
    (options.shouldIncludePrerelease || !version.isPrerelease) &&
    (options.shouldIncludeSemVer2 || !version.isSemVer2) &&
    (!options.packageType || version.metadata.packageTypes.some((type) => type.name.toLowerCase() === options.packageType))
  );
}

function parseQueryOptions(parameters: URLSearchParams): QueryOptions {
  const semVerLevel = parameters.get("semVerLevel");
  if (semVerLevel !== null && !valid(semVerLevel)) {
    throw new QueryParameterError("semVerLevel must be a semantic version");
  }
  return {
    skip: integerParameter(parameters, "skip", 0, 0),
    take: Math.min(integerParameter(parameters, "take", 20, 1), 1000),
    shouldIncludePrerelease: booleanParameter(parameters, "prerelease"),
    shouldIncludeSemVer2: semVerLevel !== null && gte(semVerLevel, "2.0.0"),
    packageType: (parameters.get("packageType") ?? "").toLowerCase()
  };
}

function integerParameter(parameters: URLSearchParams, name: string, fallback: number, minimum: number): number {
  const text = parameters.get(name);
  if (text === null) {
    return fallback;
  }
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < minimum) {
    throw new QueryParameterError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function booleanParameter(parameters: URLSearchParams, name: string): boolean {
  const value = parameters.get(name)?.toLowerCase();
  if (value !== undefined && value !== "true" && value !== "false") {
    throw new QueryParameterError(`${name} must be true or false`);
  }
  return value === "true";
}

function parseNupkgRoute(pathname: string): { lowerId: string; lowerVersion: string } | null {
  const parts = pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part).toLowerCase());
  if (parts.length !== 4 || parts[0] !== "v3-flatcontainer") {
    return null;
  }
  const [, lowerId, lowerVersion, fileName] = parts;
  return fileName === `${lowerId}.${lowerVersion}.nupkg` ? { lowerId, lowerVersion } : null;
}

async function readAssetJson<T>(request: Request, env: Env, pathname: string): Promise<T> {
  const response = await env.ASSETS.fetch(new Request(new URL(pathname, request.url)));
  if (!response.ok) {
    throw new Error(`${pathname} unavailable: HTTP ${response.status}`);
  }
  return await response.json<T>();
}

class QueryParameterError extends Error {}
