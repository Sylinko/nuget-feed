# Sylinko NuGet Feed

Public NuGet v3 feed for Sylinko-maintained fork packages and public internal packages.

The bucket manifests in `bucket/` are the source of truth. CI validates manifests, downloads GitHub Release artifacts, verifies SHA256, extracts `.nuspec` metadata from `.nupkg`, generates NuGet v3 metadata into `generated/`, and deploys a Cloudflare Worker with Static Assets.

Feed URL:

```bash
dotnet nuget add source https://nuget.sylinko.com/v3/index.json --name Sylinko
```

This repository does not store `.nupkg`, `.snupkg`, or generated feed metadata in Git.

## Layout

```text
bucket/                    Human-reviewed package and version manifests
src/                       Node.js 24 validation and generation scripts
worker/                    Cloudflare Worker and Static Assets config
action.yml                  Shared release action entrypoint
.github/actions/release/   Shared release action implementation
.github/workflows/         PR validation and main deployment
generated/                 Build output, ignored by Git
.tmp/packages/             Download cache, ignored by Git
```

## Local Commands

```bash
pnpm validate
pnpm typecheck
pnpm test:release
pnpm generate
pnpm validate
```

`pnpm generate` writes `generated/` and may download package artifacts into `.tmp/packages/`. Cache hits are still hashed before use.

Deployment and package release steps are documented in [DEPLOYMENT.md](DEPLOYMENT.md).

## Batch Release

Package repositories call the shared release action once per package batch. The action creates the GitHub Release, uploads `.nupkg`, `.symbols.nupkg`, and `.snupkg` assets, scans `artifacts-directory`, reads each package `.nupkg` nuspec, writes one version manifest per package, and opens a single PR.

```yaml
- uses: Sylinko/nuget-feed@main
  with:
    token: ${{ secrets.SYLINKO_NUGET_FEED_TOKEN }}
    release-tag: nuget/Microsoft.ML/${{ inputs.version }}
    artifacts-directory: artifacts
```

For `Sylinko/Microsoft.ML`, the bucket already declares:

```text
bucket/microsoft.ml.tokenizers/package.yml
bucket/microsoft.ml.tokenizers.data.o200kbase/package.yml
```

The release `nuget/Microsoft.ML/<version>` should contain the `.nupkg` files for `Microsoft.ML.Tokenizers` and `Microsoft.ML.Tokenizers.Data.O200kBase`, plus matching `.symbols.nupkg` files when available.
