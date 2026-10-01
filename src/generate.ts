import { readBucket, buildVerifiedRecords } from "./lib/bucket.ts";
import { generateFeed } from "./lib/nuget-v3.ts";

const rootDirectory = process.cwd();
const bucket = await readBucket(rootDirectory);
const { records, errors } = await buildVerifiedRecords(bucket);

if (errors.length > 0) {
  console.error("Cannot generate NuGet feed:");
  for (const error of new Set(errors)) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

await generateFeed(rootDirectory, records, process.env.FEED_BASE_URL);
console.log(`Generated NuGet feed metadata for ${records.length} package version(s).`);
