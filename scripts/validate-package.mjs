import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildExtensionPackage,
  checksumFileContents,
  projectRoot,
  readStoredZip,
} from "./release-package.mjs";

const expected = buildExtensionPackage();
const outputDirectory = join(projectRoot, "dist");
const archive = await readFile(join(outputDirectory, expected.archiveName));
const checksum = await readFile(join(outputDirectory, expected.checksumName), "utf8");

assert.deepEqual(archive, expected.archive, "Release ZIP does not match the current extension files");
assert.equal(
  checksum,
  checksumFileContents(expected.checksum, expected.archiveName),
  "Release checksum file is wrong",
);

const entries = readStoredZip(archive);
assert.deepEqual([...entries.keys()], expected.files, "Release ZIP file list is wrong");
for (const name of expected.files) {
  assert.ok(entries.has(name), `Release ZIP is missing ${name}`);
}

console.log(
  `Release package validation passed for ${expected.archiveName} (${expected.files.length} files).`,
);
