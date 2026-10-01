import { writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { cleanDir, ensureDir, writeJson, writeText } from "./file-system.ts";
import { compareVersionsText, isPrereleaseVersion, isSemVer2Package } from "./nuget-version.ts";
import type { VerifiedRecord } from "./types.ts";
import type { DiscoveryIndex, DiscoveryMetadata, DiscoveryPackage } from "./discovery.ts";

export const FEED_BASE_URL = "https://nuget.sylinko.com";

export async function generateFeed(rootDirectory: string, records: VerifiedRecord[], feedBaseUrl = FEED_BASE_URL): Promise<void> {
  const baseUrl = new URL(feedBaseUrl);
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
    throw new Error("Feed base URL must be an HTTP(S) origin without credentials, path, query, or fragment");
  }
  feedBaseUrl = baseUrl.origin;
  const generatedDirectory = path.join(rootDirectory, "generated");
  await cleanDir(generatedDirectory);
  const orderedRecords = [...records].sort((left, right) => {
    const idOrder = left.package.lowerId < right.package.lowerId ? -1 : left.package.lowerId > right.package.lowerId ? 1 : 0;
    return idOrder || compareVersionsText(left.version.version, right.version.version);
  });
  const routes = Object.fromEntries(orderedRecords.map((record) => [
    `${record.package.lowerId}@${record.version.lowerVersion}`,
    { id: record.package.id, version: record.version.version, nupkg: record.version.artifacts.nupkg.url, sha256: record.version.artifacts.nupkg.sha256 }
  ]));
  await writeJson(path.join(generatedDirectory, "routes.json"), routes);
  await writeJson(path.join(generatedDirectory, "catalog.json"), {
    generatedAt: new Date().toISOString(),
    packages: orderedRecords.map((record) => ({
      id: record.package.id,
      lowerId: record.package.lowerId,
      version: record.version.version,
      lowerVersion: record.version.lowerVersion,
      listed: record.version.listed,
      source: record.version.source,
      artifacts: record.version.artifacts,
      ...(record.version.review ? { review: record.version.review } : {})
    }))
  });
  await writeJson(path.join(generatedDirectory, "v3", "index.json"), {
    version: "3.0.0",
    resources: [
      { "@id": `${feedBaseUrl}/v3-flatcontainer/`, "@type": "PackageBaseAddress/3.0.0" },
      { "@id": `${feedBaseUrl}/v3/registration/`, "@type": "RegistrationsBaseUrl/3.6.0" },
      { "@id": `${feedBaseUrl}/v3/query`, "@type": "SearchQueryService" },
      { "@id": `${feedBaseUrl}/v3/query`, "@type": "SearchQueryService/3.5.0" },
      { "@id": `${feedBaseUrl}/v3/autocomplete`, "@type": "SearchAutocompleteService" },
      { "@id": `${feedBaseUrl}/v3/autocomplete`, "@type": "SearchAutocompleteService/3.5.0" }
    ]
  });

  const discovery: DiscoveryIndex = { schemaVersion: 1, packages: [] };
  const groups = Map.groupBy(orderedRecords, (record) => record.package.lowerId);
  for (const [lowerId, packageRecords] of groups) {
    const registration = `${feedBaseUrl}/v3/registration/${lowerId}/index.json`;
    const discoveryPackage: DiscoveryPackage = { id: packageRecords[0].package.id, lowerId, registration, versions: [] };
    const leaves = [];
    await writeJson(path.join(generatedDirectory, "v3-flatcontainer", lowerId, "index.json"), {
      versions: packageRecords.map((record) => record.version.lowerVersion)
    });
    for (const record of packageRecords) {
      const lowerVersion = record.version.lowerVersion;
      const leafUrl = `${feedBaseUrl}/v3/registration/${lowerId}/${lowerVersion}.json`;
      const contentUrl = `${feedBaseUrl}/v3-flatcontainer/${lowerId}/${lowerVersion}/${lowerId}.${lowerVersion}.nupkg`;
      const catalogUrl = `${feedBaseUrl}/catalog/${lowerId}/${lowerVersion}.json`;
      const { iconFile, licenseFile, readmeFile, ...metadata } = record.metadata;
      const catalogEntry = {
        "@id": catalogUrl,
        "@type": "PackageDetails",
        ...metadata,
        listed: record.version.listed,
        isPrerelease: isPrereleaseVersion(record.version.version),
        sourceRepository: record.version.source.repository,
        sourceCommit: record.version.source.commit,
        releaseTag: record.version.source.tag,
        ...await writeMetadataAssets(generatedDirectory, record, feedBaseUrl)
      };
      await writeText(path.join(generatedDirectory, "v3-flatcontainer", lowerId, lowerVersion, `${lowerId}.nuspec`), record.nuspecText);
      await writeJson(path.join(generatedDirectory, "catalog", lowerId, `${lowerVersion}.json`), catalogEntry);
      const leaf = { "@id": leafUrl, "@type": "Package", registration, packageContent: contentUrl };
      leaves.push({ ...leaf, catalogEntry });
      await writeRegistrationJson(path.join(generatedDirectory, "v3", "registration", lowerId, `${lowerVersion}.json`), {
        ...leaf,
        listed: record.version.listed,
        catalogEntry: catalogUrl
      });
      const discoveryMetadata: DiscoveryMetadata = { tags: catalogEntry.tags, packageTypes: catalogEntry.packageTypes };
      for (const key of ["authors", "description", "title", "summary", "projectUrl", "licenseUrl", "iconUrl"] as const) {
        if (catalogEntry[key] !== undefined) {
          discoveryMetadata[key] = catalogEntry[key];
        }
      }
      discoveryPackage.versions.push({
        version: record.version.version,
        lowerVersion,
        registrationLeaf: leafUrl,
        listed: record.version.listed,
        isPrerelease: catalogEntry.isPrerelease,
        isSemVer2: isSemVer2Package(record.metadata),
        metadata: discoveryMetadata
      });
    }
    await writeRegistrationJson(path.join(generatedDirectory, "v3", "registration", lowerId, "index.json"), {
      "@id": registration,
      "@type": ["catalog:CatalogRoot", "PackageRegistration", "catalog:Permalink"],
      count: 1,
      items: [{
        "@id": `${registration}#page`,
        "@type": "PackageRegistrationPage",
        count: leaves.length,
        lower: packageRecords[0].version.lowerVersion,
        upper: packageRecords[packageRecords.length - 1].version.lowerVersion,
        items: leaves
      }]
    });
    discovery.packages.push(discoveryPackage);
  }
  await writeJson(path.join(generatedDirectory, "discovery.json"), discovery);
}

async function writeRegistrationJson(filePath: string, value: object): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeText(filePath, content);
  // The advertised 3.6.0 registration hive requires gzip. The Worker serves this
  // precompressed companion with explicit encoding rather than CDN negotiation.
  await writeFile(`${filePath}.gz`, gzipSync(content));
}

async function writeMetadataAssets(generatedDirectory: string, record: VerifiedRecord, feedBaseUrl: string): Promise<{ iconUrl?: string; licenseUrl?: string; readmeUrl?: string }> {
  const result: { iconUrl?: string; licenseUrl?: string; readmeUrl?: string } = {};
  for (const asset of record.assets) {
    const assetParts = ["metadata", record.package.lowerId, record.version.lowerVersion, ...asset.name.split("/")];
    const target = path.join(generatedDirectory, ...assetParts);
    await ensureDir(path.dirname(target));
    await writeFile(target, asset.content);
    const assetUrl = `${feedBaseUrl}/${assetParts.map(encodeURIComponent).join("/")}`;
    if (asset.name === record.metadata.iconFile) {
      result.iconUrl = assetUrl;
    }
    if (asset.name === record.metadata.licenseFile) {
      result.licenseUrl = assetUrl;
    }
    if (asset.name === record.metadata.readmeFile) {
      // Serve a safe HTML view of the original text without executing package HTML.
      // Markdown rendering is deliberately outside the initial metadata scope.
      const htmlName = "readme.html";
      const htmlPath = path.join(generatedDirectory, "readme", record.package.lowerId, record.version.lowerVersion, htmlName);
      const escapedText = asset.content.toString("utf8").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      await writeText(htmlPath, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Package README</title><pre style="white-space:pre-wrap">${escapedText}</pre></html>`);
      result.readmeUrl = `${feedBaseUrl}/readme/${record.package.lowerId}/${record.version.lowerVersion}/${htmlName}`;
    }
  }
  return result;
}
