import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildExtensionPackage,
  checksumFileContents,
  projectRoot,
} from "./release-package.mjs";

const release = buildExtensionPackage();
const outputDirectory = join(projectRoot, "dist");
const archivePath = join(outputDirectory, release.archiveName);
const checksumPath = join(outputDirectory, release.checksumName);

await mkdir(outputDirectory, { recursive: true });
await writeFile(archivePath, release.archive);
await writeFile(
  checksumPath,
  checksumFileContents(release.checksum, release.archiveName),
  "utf8",
);

console.log(`Created ${release.archiveName} with ${release.files.length} files.`);
console.log(`SHA-256: ${release.checksum}`);
