import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertSafeArchiveName,
  buildExtensionPackage,
  projectRoot,
  readStoredZip,
} from "./release-package.mjs";

export const packageSmokePrefix = "lecture-notes-package-smoke-";

function isWithin(directory, path) {
  const resolvedDirectory = resolve(directory);
  const resolvedPath = resolve(path);
  return resolvedPath.startsWith(`${resolvedDirectory}${sep}`);
}

export function resolvePackageEntryPath(directory, name) {
  assertSafeArchiveName(name);
  const parts = name.split("/");
  const target = resolve(directory, ...parts);
  assert.ok(isWithin(directory, target), `ZIP path leaves the extraction directory: ${name}`);
  return target;
}

function assertTemporaryRoot(directory, temporaryDirectory) {
  const resolvedDirectory = resolve(directory);
  assert.ok(
    isWithin(temporaryDirectory, resolvedDirectory),
    "Package smoke directory must stay under its temporary directory",
  );
  assert.ok(
    basename(resolvedDirectory).startsWith(packageSmokePrefix),
    "Package smoke directory has an unexpected name",
  );
  return resolvedDirectory;
}

export async function extractStoredZipPackage(archive, directory) {
  const entries = readStoredZip(archive);
  assert.ok(entries.has("manifest.json"), "Extension package is missing manifest.json");

  for (const [name, data] of entries) {
    const target = resolvePackageEntryPath(directory, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: "wx" });
  }

  return [...entries.keys()];
}

export async function withExtractedStoredZip(
  archive,
  action,
  { temporaryDirectory = tmpdir() } = {},
) {
  assert.equal(typeof action, "function", "Package smoke action must be a function");
  const resolvedTemporaryDirectory = resolve(temporaryDirectory);
  await mkdir(resolvedTemporaryDirectory, { recursive: true });
  const directory = await mkdtemp(join(resolvedTemporaryDirectory, packageSmokePrefix));
  const safeDirectory = assertTemporaryRoot(directory, resolvedTemporaryDirectory);

  try {
    await extractStoredZipPackage(archive, safeDirectory);
    return await action(safeDirectory);
  } finally {
    assertTemporaryRoot(safeDirectory, resolvedTemporaryDirectory);
    await rm(safeDirectory, { recursive: true, force: true });
  }
}

export async function runBrowserSmokeProcess(extensionRoot) {
  const browserSmokePath = join(projectRoot, "scripts", "browser-smoke.mjs");
  const child = spawn(process.execPath, [browserSmokePath, extensionRoot], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
  const result = await new Promise((resolveResult, rejectResult) => {
    child.once("error", rejectResult);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  assert.equal(result.signal, null, `Packaged browser smoke stopped on signal ${result.signal}`);
  assert.equal(result.code, 0, `Packaged browser smoke exited with code ${result.code}`);
}

export async function runPackagedBrowserSmoke({
  archivePath,
  runSmoke = runBrowserSmokeProcess,
  temporaryDirectory,
} = {}) {
  const release = buildExtensionPackage();
  const storedArchivePath = archivePath || join(projectRoot, "dist", release.archiveName);
  const archive = await readFile(storedArchivePath);

  await withExtractedStoredZip(
    archive,
    runSmoke,
    temporaryDirectory ? { temporaryDirectory } : undefined,
  );
  console.log(`Packaged browser smoke passed for ${basename(storedArchivePath)}.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  await runPackagedBrowserSmoke();
}
