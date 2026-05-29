export interface Env {
  ASSETS: AssetFetcher;
}

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

type Route = {
  id: string;
  version: string;
  nupkg: string;
  sha256: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const nupkgRoute = parseNupkgRoute(url.pathname);

    if (nupkgRoute) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" }
        });
      }

      const routes = await loadRoutes(request, env);
      const route = routes[`${nupkgRoute.lowerId}@${nupkgRoute.lowerVersion}`];
      if (!route) {
        return new Response("Package not found", { status: 404 });
      }

      return new Response(null, {
        status: 307,
        headers: {
          Location: route.nupkg,
          "Cache-Control": "public, max-age=300"
        }
      });
    }

    return env.ASSETS.fetch(request);
  }
};

function parseNupkgRoute(pathname: string): { lowerId: string; lowerVersion: string } | null {
  const parts = pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part).toLowerCase());
  if (parts.length !== 4 || parts[0] !== "v3-flatcontainer") {
    return null;
  }

  const [, lowerId, lowerVersion, fileName] = parts;
  if (fileName !== `${lowerId}.${lowerVersion}.nupkg`) {
    return null;
  }

  return { lowerId, lowerVersion };
}

async function loadRoutes(request: Request, env: Env): Promise<Record<string, Route>> {
  const routesUrl = new URL("/routes.json", request.url);
  const response = await env.ASSETS.fetch(new Request(routesUrl, { method: "GET" }));
  if (!response.ok) {
    throw new Error(`routes.json unavailable: HTTP ${response.status}`);
  }
  const data: unknown = await response.json();
  return data as Record<string, Route>;
}
