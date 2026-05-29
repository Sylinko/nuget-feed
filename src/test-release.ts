import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { releaseBatch } from "./lib/release-batch.ts";
import { pathExists, readText, writeText } from "./lib/file-system.ts";

type Fixture = {
  root: string;
  artifacts: string;
};

await testBatchReleaseWritesMultipleManifests();
await testDuplicatePackageVersionFails();
await testUnmatchedSymbolsPackageFails();
await testMissingPackageManifestFails();

console.log("release batch smoke tests passed.");

async function testBatchReleaseWritesMultipleManifests(): Promise<void> {
  await usingFixture(async (fixture) => {
    await writePackageManifest(fixture.root, "Example.Alpha", "example.alpha");
    await writePackageManifest(fixture.root, "Example.Beta", "example.beta");
    await writeNupkg(path.join(fixture.artifacts, "Example.Alpha.1.0.0.nupkg"), "Example.Alpha", "1.0.0");
    await writeFile(path.join(fixture.artifacts, "example.alpha.1.0.0.symbols.nupkg"), "symbols");
    await writeNupkg(path.join(fixture.artifacts, "Example.Beta.2.0.0.nupkg"), "Example.Beta", "2.0.0");

    const released = await releaseBatch(defaultInput(fixture));
    assert.equal(released.length, 2);
    assert.equal(await pathExists(path.join(fixture.root, "bucket", "example.alpha", "versions", "1.0.0.yml")), true);
    assert.equal(await pathExists(path.join(fixture.root, "bucket", "example.beta", "versions", "2.0.0.yml")), true);

    const alphaManifest = await readText(path.join(fixture.root, "bucket", "example.alpha", "versions", "1.0.0.yml"));
    const betaManifest = await readText(path.join(fixture.root, "bucket", "example.beta", "versions", "2.0.0.yml"));
    assert.match(alphaManifest, /tag: nuget\/Example\/batch-1/);
    assert.match(betaManifest, /tag: nuget\/Example\/batch-1/);
    assert.match(alphaManifest, /symbols:/);
    assert.match(alphaManifest, /Example.Alpha.1.0.0.nupkg/);
    assert.match(betaManifest, /Example.Beta.2.0.0.nupkg/);
  });
}

async function testDuplicatePackageVersionFails(): Promise<void> {
  await usingFixture(async (fixture) => {
    await writePackageManifest(fixture.root, "Example.Alpha", "example.alpha");
    await writeNupkg(path.join(fixture.artifacts, "Example.Alpha.1.0.0.nupkg"), "Example.Alpha", "1.0.0");
    await writeNupkg(path.join(fixture.artifacts, "renamed.nupkg"), "Example.Alpha", "1.0.0");

    await assert.rejects(
      () => releaseBatch(defaultInput(fixture)),
      /duplicate package version in artifacts: example\.alpha@1\.0\.0/
    );
  });
}

async function testUnmatchedSymbolsPackageFails(): Promise<void> {
  await usingFixture(async (fixture) => {
    await writePackageManifest(fixture.root, "Example.Alpha", "example.alpha");
    await writeNupkg(path.join(fixture.artifacts, "Example.Alpha.1.0.0.nupkg"), "Example.Alpha", "1.0.0");
    await writeFile(path.join(fixture.artifacts, "Example.Other.1.0.0.symbols.nupkg"), "symbols");

    await assert.rejects(
      () => releaseBatch(defaultInput(fixture)),
      /unmatched symbol package asset/
    );
  });
}

async function testMissingPackageManifestFails(): Promise<void> {
  await usingFixture(async (fixture) => {
    await writeNupkg(path.join(fixture.artifacts, "Example.Alpha.1.0.0.nupkg"), "Example.Alpha", "1.0.0");

    await assert.rejects(
      () => releaseBatch(defaultInput(fixture)),
      /package manifest does not exist/
    );
  });
}

async function usingFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "nuget-feed-release-"));
  const artifacts = path.join(root, "artifacts");
  await mkdir(artifacts, { recursive: true });
  try {
    await run({ root, artifacts });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function defaultInput(fixture: Fixture): Parameters<typeof releaseBatch>[0] {
  return {
    feedRepositoryPath: fixture.root,
    artifactsDirectory: fixture.artifacts,
    releaseTag: "nuget/Example/batch-1",
    sourceRepository: "Sylinko/Example",
    sourceCommit: "abc123",
    serverUrl: "https://github.com",
    runId: "42"
  };
}

async function writePackageManifest(root: string, id: string, lowerId: string): Promise<void> {
  await writeText(path.join(root, "bucket", lowerId, "package.yml"), [
    `id: ${id}`,
    `lowerId: ${lowerId}`,
    "",
    "source:",
    "  repository: Sylinko/Example",
    ""
  ].join("\n"));
}

async function writeNupkg(filePath: string, id: string, version: string): Promise<void> {
  const nuspec = [
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<package>",
    "  <metadata>",
    `    <id>${id}</id>`,
    `    <version>${version}</version>`,
    "  </metadata>",
    "</package>"
  ].join("\n");
  await writeZip(filePath, `${id}.nuspec`, Buffer.from(nuspec, "utf8"));
}

async function writeZip(filePath: string, entryName: string, content: Buffer): Promise<void> {
  const name = Buffer.from(entryName, "utf8");
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt32LE(0, 10);
  localHeader.writeUInt32LE(0, 14);
  localHeader.writeUInt32LE(content.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(name.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt32LE(0, 12);
  centralHeader.writeUInt32LE(0, 16);
  centralHeader.writeUInt32LE(content.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(name.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);

  const local = Buffer.concat([localHeader, name, content]);
  const central = Buffer.concat([centralHeader, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  end.writeUInt16LE(0, 20);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.concat([local, central, end]));
}
