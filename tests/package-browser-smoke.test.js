import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resolvePackageEntryPath,
  runSmokeScriptProcess,
  withExtractedStoredZip,
} from "../scripts/package-browser-smoke.mjs";
import { buildStoredZip } from "../scripts/release-package.mjs";

function sampleArchive() {
  return buildStoredZip([
    {
      name: "manifest.json",
      data: Buffer.from('{"manifest_version":3,"name":"Package test","version":"1.0.0"}'),
    },
    { name: "src/background.js", data: Buffer.from("export const ready = true;\n") },
  ]);
}

async function assertMissing(path) {
  await assert.rejects(access(path), { code: "ENOENT" });
}

test("packaged browser helper extracts files and removes its directory", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "lecture-notes-package-test-"));
  let extractedDirectory;
  try {
    const result = await withExtractedStoredZip(
      sampleArchive(),
      async (directory) => {
        extractedDirectory = directory;
        assert.equal(
          await readFile(join(directory, "src", "background.js"), "utf8"),
          "export const ready = true;\n",
        );
        return "smoke result";
      },
      { temporaryDirectory },
    );

    assert.equal(result, "smoke result");
    await assertMissing(extractedDirectory);
    assert.deepEqual(await readdir(temporaryDirectory), []);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("packaged browser helper cleans up after a smoke failure", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "lecture-notes-package-test-"));
  let extractedDirectory;
  try {
    await assert.rejects(
      withExtractedStoredZip(
        sampleArchive(),
        (directory) => {
          extractedDirectory = directory;
          throw new Error("Expected smoke failure");
        },
        { temporaryDirectory },
      ),
      /Expected smoke failure/u,
    );

    await assertMissing(extractedDirectory);
    assert.deepEqual(await readdir(temporaryDirectory), []);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("packaged browser helper rejects unsafe entry names", () => {
  const directory = join(tmpdir(), "lecture-notes-safe-root");
  for (const name of [
    "../secret.txt",
    "/absolute.txt",
    "C:/drive.txt",
    "src\\backslash.js",
    "src/CON",
    "src/trailing.",
  ]) {
    assert.throws(() => resolvePackageEntryPath(directory, name), /ZIP path|Unsafe/u, name);
    assert.throws(
      () => buildStoredZip([{ name, data: Buffer.from("unsafe") }]),
      /ZIP path|Unsafe/u,
      name,
    );
  }
});

test("packaged browser helper cleans up after unsafe archive extraction", async () => {
  const safeArchive = buildStoredZip([
    {
      name: "manifest.json",
      data: Buffer.from('{"manifest_version":3,"name":"Package test","version":"1.0.0"}'),
    },
    { name: "aa/x", data: Buffer.from("unsafe") },
  ]);
  const unsafeArchive = Buffer.from(safeArchive);
  const safeName = Buffer.from("aa/x");
  let offset = 0;
  while ((offset = unsafeArchive.indexOf(safeName, offset)) !== -1) {
    unsafeArchive.write("../x", offset, "utf8");
    offset += safeName.length;
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "lecture-notes-package-test-"));
  try {
    await assert.rejects(
      withExtractedStoredZip(unsafeArchive, () => undefined, { temporaryDirectory }),
      /Unsafe ZIP path/u,
    );
    assert.deepEqual(await readdir(temporaryDirectory), []);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("packaged browser helper rejects unsafe smoke script names", async () => {
  await assert.rejects(
    runSmokeScriptProcess("../outside.mjs", process.cwd(), "Invalid smoke"),
    /Smoke script name is invalid/u,
  );
});
