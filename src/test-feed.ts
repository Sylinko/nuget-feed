import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { parseManifestYaml, stringifyManifestYaml } from "./lib/manifest-yaml.ts";
import { readNuspecMetadata } from "./lib/nuget-package.ts";
import { compareVersionsText, isSemVer2Package, lowerNuGetVersion } from "./lib/nuget-version.ts";
import { generateFeed } from "./lib/nuget-v3.ts";
import type { VerifiedRecord } from "./lib/types.ts";
import worker from "../worker/src/index.ts";

testManifestParsing();
testNuspecAndVersions();
await testGenerationAndQueries();
console.log("feed metadata and discovery smoke tests passed.");

function testManifestParsing(): void {
  const manifest = { version: "6.0.0", review: { reason: 'A "quoted" value: C:\\path\nnext line' }, policy: { enabled: true }, note: "true" };
  assert.deepEqual(parseManifestYaml(stringifyManifestYaml(manifest)), manifest);
  assert.throws(() => parseManifestYaml("id: One\nid: Two\n"), /unique|duplicate/i);
  assert.throws(() => parseManifestYaml("id: &id One\nlowerId: *id\n"), /alias/i);
  assert.throws(() => parseManifestYaml("id: !custom One\n"), /tag/i);
  assert.throws(() => parseManifestYaml("id: 123\n"), /quote numeric/);
}

function testNuspecAndVersions(): void {
  const metadata = readNuspecMetadata(`<p:package xmlns:p="urn:nuget"><p:metadata minClientVersion="3.6">
    <p:id>Example.Alpha</p:id><p:version>6.0.0</p:version>
    <p:authors>A &amp; B &#67;</p:authors><p:description><![CDATA[Description <text>]]></p:description>
    <p:license type="expression">MIT</p:license><p:tags>library nuget</p:tags>
    <p:dependencies><p:group targetFramework="net8.0"><p:dependency id="Example.Dependency" version="[1.0.0,2.0.0-alpha.1)" /></p:group>
    <p:group targetFramework="net9.0" /></p:dependencies></p:metadata></p:package>`);
  assert.equal(metadata.authors, "A & B C");
  assert.equal(metadata.description, "Description <text>");
  assert.equal(metadata.licenseExpression, "MIT");
  assert.equal(metadata.minClientVersion, "3.6");
  assert.deepEqual(metadata.dependencyGroups, [
    { targetFramework: "net8.0", dependencies: [{ id: "Example.Dependency", range: "[1.0.0,2.0.0-alpha.1)" }] },
    { targetFramework: "net9.0", dependencies: [] }
  ]);
  assert.equal(isSemVer2Package(metadata), true);
  assert.throws(() => readNuspecMetadata("<!DOCTYPE package><package />"), /DTD/);
  assert.throws(() => readNuspecMetadata("<package><metadata></package>"), /invalid nuspec XML/);
  assert.ok(compareVersionsText("1.0.0-rc.10", "1.0.0-rc.2") > 0);
  assert.ok(compareVersionsText("1.0.0", "1.0.0-rc.10") > 0);
  assert.equal(compareVersionsText("1.0.0+one", "1.0.0+two"), 0);
  assert.equal(lowerNuGetVersion("1.0.0-RC+Build"), "1.0.0-rc");
}

async function testGenerationAndQueries(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "nuget-feed-discovery-"));
  try {
    const old = record("Example.Alpha", "6.0.0");
    old.metadata.iconFile = "icon.png";
    old.metadata.readmeFile = "README.md";
    old.assets = [{ name: "icon.png", content: Buffer.from("icon") }, { name: "README.md", content: Buffer.from("# README\n<script>alert(1)</script>") }];
    const dependent = record("Example.Beta", "1.0.0");
    dependent.metadata.dependencyGroups = [{ dependencies: [{ id: "Other", range: "[1.0.0+build,)" }] }];
    const hidden = record("Example.Alpha", "999.20261001.8");
    hidden.version.listed = false;
    const records = [hidden, record("Example.Alpha", "7.0.0-beta.2"), old, record("Example.Alpha", "7.0.0-beta"), dependent];
    await generateFeed(root, records);
    const generated = path.join(root, "generated");
    const assets = {
      async fetch(input: RequestInfo | URL): Promise<Response> {
        const url = new URL(input instanceof Request ? input.url : String(input));
        try {
          const content = await readFile(path.join(generated, decodeURIComponent(url.pathname).slice(1)));
          return new Response(content);
        } catch {
          return new Response(null, { status: 404 });
        }
      }
    };
    const env = { ASSETS: assets as Env["ASSETS"] };
    const request = (pathname: string, method = "GET") => worker.fetch(new Request(`https://nuget.sylinko.com${pathname}`, { method }), env);
    const query = async (pathname: string) => {
      const response = await request(pathname);
      assert.equal(response.status, 200);
      return response.json<{ totalHits?: number; data: { id: string; version: string; versions: { version: string; downloads: number }[] }[] }>();
    };
    const index = JSON.parse(await readFile(path.join(generated, "v3/index.json"), "utf8"));
    assert.ok(index.resources.some((resource: { "@type": string }) => resource["@type"] === "SearchQueryService"));
    const registrationResponse = await request("/v3/registration/example.alpha/index.json");
    assert.equal(registrationResponse.headers.get("Content-Encoding"), "gzip");
    const registration = JSON.parse(gunzipSync(Buffer.from(await registrationResponse.arrayBuffer())).toString("utf8"));
    const page = registration.items[0];
    assert.deepEqual(page.items.map((leaf: { catalogEntry: { version: string } }) => leaf.catalogEntry.version), ["6.0.0", "7.0.0-beta", "7.0.0-beta.2", "999.20261001.8"]);
    const leaf = JSON.parse(await readFile(path.join(generated, "v3/registration/example.alpha/6.0.0.json"), "utf8"));
    assert.equal(typeof leaf.catalogEntry, "string");
    const catalog = JSON.parse(await readFile(path.join(generated, "catalog/example.alpha/6.0.0.json"), "utf8"));
    assert.equal(catalog.iconUrl, "https://nuget.sylinko.com/metadata/example.alpha/6.0.0/icon.png");
    assert.deepEqual(catalog.dependencyGroups, []);
    assert.match(await readFile(path.join(generated, "readme/example.alpha/6.0.0/readme.html"), "utf8"), /&lt;script&gt;/);
    assert.equal(await readFile(path.join(generated, "v3-flatcontainer/example.alpha/6.0.0/example.alpha.nuspec"), "utf8"), old.nuspecText);

    const browse = await query("/v3/query");
    assert.equal(browse.totalHits, 1);
    assert.equal(browse.data[0].version, "6.0.0");
    assert.equal((await query("/v3/query?semVerLevel=2.0.0")).totalHits, 2);
    assert.equal((await query("/v3/query?prerelease=true")).data[0].version, "7.0.0-beta");
    assert.equal((await query("/v3/query?prerelease=true&semVerLevel=2.0.0")).data[0].version, "7.0.0-beta.2");
    const pageResult = await query("/v3/query?semVerLevel=2.0.0&skip=1&take=1");
    assert.equal(pageResult.totalHits, 2);
    assert.equal(pageResult.data.length, 1);
    assert.equal(pageResult.data[0].id, "Example.Beta");
    assert.equal((await query("/v3/query?q=sample%20alpha")).totalHits, 1);
    assert.equal((await query("/v3/query?packageType=DotnetTool")).totalHits, 0);
    const autocomplete = await request("/v3/autocomplete?id=EXAMPLE.ALPHA&prerelease=true&semVerLevel=2.0.0&take=1");
    assert.deepEqual(await autocomplete.json(), { data: ["6.0.0", "7.0.0-beta", "7.0.0-beta.2"] });
    const ids = await request("/v3/autocomplete?q=alpha");
    assert.deepEqual(await ids.json(), { totalHits: 1, data: ["Example.Alpha"] });
    assert.deepEqual(await (await request("/v3/autocomplete?id=unknown")).json(), { data: [] });
    for (const pathname of ["/v3/query?take=-1", "/v3/query?prerelease=maybe", "/v3/query?semVerLevel=bad", "/v3-flatcontainer/%zz/1.0.0/x.nupkg"]) {
      assert.equal((await request(pathname)).status, 400);
    }
    assert.equal((await request("/v3/query", "POST")).status, 405);
    assert.equal(await (await request("/v3/query", "HEAD")).text(), "");
    assert.equal(await (await request("/v3/registration/example.alpha/6.0.0.json", "HEAD")).text(), "");
    const redirect = await request("/v3-flatcontainer/example.alpha/6.0.0/example.alpha.6.0.0.nupkg");
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.get("Location"), old.version.artifacts.nupkg.url);
    assert.equal((await request("/v3-flatcontainer/example.alpha/999.20261001.8/example.alpha.999.20261001.8.nupkg")).status, 307);
    assert.equal((await request("/v3-flatcontainer/example.alpha/0.0.0/example.alpha.0.0.0.nupkg")).status, 404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function record(id: string, version: string): VerifiedRecord {
  const lowerId = id.toLowerCase();
  const lowerVersion = lowerNuGetVersion(version);
  return {
    package: { id, lowerId, source: { repository: "Sylinko/Example" } },
    version: {
      version,
      lowerVersion,
      listed: true,
      source: { repository: "Sylinko/Example", commit: "abc123", tag: "nuget/Example/1", workflowRun: "https://github.com/Sylinko/Example/actions/runs/1" },
      artifacts: { nupkg: { url: `https://github.com/Sylinko/Example/releases/download/nuget%2FExample%2F1/${id}.${version}.nupkg`, sha256: "0".repeat(64) } }
    },
    nuspecText: `<package><metadata><id>${id}</id><version>${version}</version></metadata></package>`,
    metadata: { id, version, description: `A sample ${id} library`, authors: "Author", tags: ["sample"], packageTypes: [{ name: "Dependency" }], dependencyGroups: [] },
    assets: [],
    manifestPath: `bucket/${lowerId}/versions/${lowerVersion}.yml`
  };
}
