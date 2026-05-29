import path from "node:path";
import { cleanDir, writeJson, writeText } from "./file-system.ts";
import { compareVersionsText } from "./nuget-version.ts";
import type { JsonValue, VerifiedRecord } from "./types.ts";

const FEED_BASE_URL = "https://nuget.sylinko.com";

export async function generateFeed(rootDirectory: string, records: VerifiedRecord[]): Promise<void> {
  const generatedDirectory = path.join(rootDirectory, "generated");
  await cleanDir(generatedDirectory);

  const orderedRecords = [...records].sort((left, right) => {
    const idCompare = left.package.lowerId.localeCompare(right.package.lowerId);
    return idCompare || compareVersionsText(left.version.lowerVersion, right.version.lowerVersion);
  });

  await writeJson(path.join(generatedDirectory, "routes.json"), buildRoutes(orderedRecords));
  await writeJson(path.join(generatedDirectory, "catalog.json"), buildCatalog(orderedRecords));
  await writeJson(path.join(generatedDirectory, "v3", "index.json"), buildServiceIndex());
  await writeFlatContainer(generatedDirectory, orderedRecords);
  await writeRegistration(generatedDirectory, orderedRecords);
}

function buildServiceIndex(): JsonValue {
  return {
    version: "3.0.0",
    resources: [
      {
        "@id": `${FEED_BASE_URL}/v3-flatcontainer/`,
        "@type": "PackageBaseAddress/3.0.0",
        comment: "Sylinko package content"
      },
      {
        "@id": `${FEED_BASE_URL}/v3/registration/`,
        "@type": "RegistrationsBaseUrl/3.6.0",
        comment: "Sylinko package metadata"
      }
    ]
  };
}

function buildRoutes(records: VerifiedRecord[]): JsonValue {
  const routes: Record<string, JsonValue> = {};
  for (const record of records) {
    routes[`${record.package.lowerId}@${record.version.lowerVersion}`] = {
      id: record.package.id,
      version: record.version.version,
      nupkg: record.version.artifacts.nupkg.url,
      sha256: record.version.artifacts.nupkg.sha256
    };
  }
  return routes;
}

function buildCatalog(records: VerifiedRecord[]): JsonValue {
  return {
    generatedAt: new Date().toISOString(),
    packages: records.map((record) => {
      const item: Record<string, JsonValue> = {
        id: record.package.id,
        lowerId: record.package.lowerId,
        version: record.version.version,
        lowerVersion: record.version.lowerVersion,
        source: record.version.source,
        artifacts: record.version.artifacts
      };
      if (record.version.review) {
        item.review = record.version.review;
      }
      return item;
    })
  };
}

async function writeFlatContainer(generatedDirectory: string, records: VerifiedRecord[]): Promise<void> {
  for (const [lowerId, packageRecords] of groupByLowerId(records)) {
    const versions = packageRecords.map((record) => record.version.lowerVersion);
    await writeJson(path.join(generatedDirectory, "v3-flatcontainer", lowerId, "index.json"), { versions });

    for (const record of packageRecords) {
      await writeText(
        path.join(generatedDirectory, "v3-flatcontainer", lowerId, record.version.lowerVersion, `${lowerId}.nuspec`),
        record.nuspecText
      );
    }
  }
}

async function writeRegistration(generatedDirectory: string, records: VerifiedRecord[]): Promise<void> {
  for (const [lowerId, packageRecords] of groupByLowerId(records)) {
    if (packageRecords.length === 0) {
      continue;
    }

    const leaves = packageRecords.map((record) => registrationLeaf(record));
    const index = {
      "@id": `${FEED_BASE_URL}/v3/registration/${lowerId}/index.json`,
      "@type": ["catalog:CatalogRoot", "PackageRegistration", "catalog:Permalink"],
      count: 1,
      items: [
        {
          "@id": `${FEED_BASE_URL}/v3/registration/${lowerId}/index.json#page`,
          "@type": "PackageRegistrationPage",
          count: leaves.length,
          lower: packageRecords[0].version.lowerVersion,
          upper: packageRecords[packageRecords.length - 1].version.lowerVersion,
          items: leaves
        }
      ]
    };

    await writeJson(path.join(generatedDirectory, "v3", "registration", lowerId, "index.json"), index);
    for (let index = 0; index < packageRecords.length; index += 1) {
      await writeJson(
        path.join(generatedDirectory, "v3", "registration", lowerId, `${packageRecords[index].version.lowerVersion}.json`),
        leaves[index]
      );
    }
  }
}

function registrationLeaf(record: VerifiedRecord): JsonValue {
  const lowerId = record.package.lowerId;
  const lowerVersion = record.version.lowerVersion;
  const catalogEntry: Record<string, JsonValue> = {
    "@id": `${FEED_BASE_URL}/catalog/${lowerId}/${lowerVersion}.json`,
    "@type": "PackageDetails",
    id: record.package.id,
    version: record.version.version,
    listed: true,
    sourceRepository: record.version.source.repository,
    sourceCommit: record.version.source.commit,
    releaseTag: record.version.source.tag
  };
  return {
    "@id": `${FEED_BASE_URL}/v3/registration/${lowerId}/${lowerVersion}.json`,
    "@type": "Package",
    registration: `${FEED_BASE_URL}/v3/registration/${lowerId}/index.json`,
    packageContent: `${FEED_BASE_URL}/v3-flatcontainer/${lowerId}/${lowerVersion}/${lowerId}.${lowerVersion}.nupkg`,
    catalogEntry
  };
}

function groupByLowerId(records: VerifiedRecord[]): [string, VerifiedRecord[]][] {
  const groups = new Map<string, VerifiedRecord[]>();
  for (const record of records) {
    if (!groups.has(record.package.lowerId)) {
      groups.set(record.package.lowerId, []);
    }
    groups.get(record.package.lowerId)?.push(record);
  }
  return [...groups.entries()];
}
