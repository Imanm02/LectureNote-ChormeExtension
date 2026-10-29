import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DATE_1980_01_01 = 0x0021;
const ZIP_VERSION = 20;
const MAX_ZIP_32 = 0xffffffff;
const MAX_ZIP_16 = 0xffff;
const TEXT_PACKAGE_NAMES = new Set(["LICENSE"]);
const TEXT_PACKAGE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".svg",
  ".txt",
  ".xml",
]);

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function archivePath(root, path) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  assert.ok(
    resolvedPath.startsWith(`${resolvedRoot}${sep}`),
    `Package file is outside the project: ${resolvedPath}`,
  );
  return relative(resolvedRoot, resolvedPath).split(sep).join("/");
}

function resolveLocalReference(root, fromFile, reference) {
  assert.ok(reference, `${fromFile} has an empty resource reference`);
  assert.doesNotMatch(
    reference,
    /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/iu,
    `${fromFile} has a nonlocal resource reference: ${reference}`,
  );
  const withoutFragment = reference.split("#", 1)[0].split("?", 1)[0];
  if (!withoutFragment) {
    return null;
  }
  const resolved = resolve(root, dirname(fromFile), withoutFragment);
  const path = archivePath(root, resolved);
  assert.ok(existsSync(resolved), `Missing package resource: ${path}`);
  assert.ok(statSync(resolved).isFile(), `Package resource is not a file: ${path}`);
  return path;
}

function addPageResources(root, pagePath, files, pendingPages) {
  const source = readFileSync(join(root, pagePath), "utf8");
  const documentValue = new JSDOM(source).window.document;
  for (const element of documentValue.querySelectorAll("[href], [src]")) {
    const attribute = element.hasAttribute("href") ? "href" : "src";
    const reference = element.getAttribute(attribute)?.trim();
    if (!reference || reference.startsWith("#")) {
      continue;
    }
    const path = resolveLocalReference(root, pagePath, reference);
    if (!path) {
      continue;
    }
    files.add(path);
    if (extname(path) === ".html") {
      pendingPages.add(path);
    }
  }
}

function addCssResources(root, cssPath, files) {
  const source = readFileSync(join(root, cssPath), "utf8");
  assert.doesNotMatch(source, /@import\b/iu, `${cssPath} uses a CSS import`);
  const matches = source.matchAll(/(?:@import\s+)?url\(\s*["']?([^"')]+)["']?\s*\)/giu);
  for (const match of matches) {
    const reference = match[1].trim();
    const path = resolveLocalReference(root, cssPath, reference);
    if (path) {
      files.add(path);
    }
  }
}

export function assertVersionAgreement(packageJson, manifest) {
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/u, "Package version must use three numbers");
  assert.equal(
    manifest.version,
    packageJson.version,
    `manifest.json version ${manifest.version} does not match package.json ${packageJson.version}`,
  );
}

export function getExtensionPackageFiles(root = projectRoot) {
  const packageJson = readJson(root, "package.json");
  const manifest = readJson(root, "manifest.json");
  assertVersionAgreement(packageJson, manifest);

  const files = new Set(["LICENSE", "manifest.json"]);
  if (existsSync(join(root, "PRIVACY.md"))) {
    files.add("PRIVACY.md");
  }

  const manifestResources = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
  ].filter(Boolean);
  for (const path of manifestResources) {
    const resolved = resolve(root, path);
    const normalized = archivePath(root, resolved);
    assert.ok(existsSync(resolved), `Missing manifest resource: ${normalized}`);
    files.add(normalized);
  }

  for (const path of listFiles(join(root, "src"))) {
    if (extname(path) === ".js") {
      files.add(archivePath(root, path));
    }
  }

  const pendingPages = new Set(
    [...files].filter((path) => extname(path) === ".html"),
  );
  const visitedPages = new Set();
  while (pendingPages.size > 0) {
    const pagePath = pendingPages.values().next().value;
    pendingPages.delete(pagePath);
    if (visitedPages.has(pagePath)) {
      continue;
    }
    visitedPages.add(pagePath);
    addPageResources(root, pagePath, files, pendingPages);
  }

  for (const cssPath of [...files].filter((path) => extname(path) === ".css")) {
    addCssResources(root, cssPath, files);
  }

  return [...files].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function assertSafeArchiveName(name) {
  assert.equal(typeof name, "string", "ZIP path must be a string");
  assert.equal(name, name.replaceAll("\\", "/"), `ZIP path uses a backslash: ${name}`);
  assert.ok(!name.startsWith("/"), `ZIP path is absolute: ${name}`);
  const parts = name.split("/");
  assert.ok(parts.every((part) => part && part !== "." && part !== ".."), `Unsafe ZIP path: ${name}`);
  for (const part of parts) {
    assert.ok(
      ![...part].some(
        (character) => character.codePointAt(0) <= 0x1f || '<>:"|?*'.includes(character),
      ),
      `Unsafe ZIP path: ${name}`,
    );
    assert.ok(!/[. ]$/u.test(part), `Unsafe ZIP path: ${name}`);
    assert.doesNotMatch(
      part,
      /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\..*)?$/iu,
      `Unsafe ZIP path: ${name}`,
    );
  }
}

export function buildStoredZip(entries) {
  assert.ok(entries.length > 0, "The extension package cannot be empty");
  assert.ok(entries.length <= MAX_ZIP_16, "The extension package has too many files");

  const seenNames = new Set();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    assertSafeArchiveName(entry.name);
    assert.ok(!seenNames.has(entry.name), `Duplicate ZIP path: ${entry.name}`);
    seenNames.add(entry.name);
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    assert.ok(name.length <= MAX_ZIP_16, `ZIP path is too long: ${entry.name}`);
    assert.ok(data.length <= MAX_ZIP_32, `ZIP file is too large: ${entry.name}`);
    assert.ok(localOffset <= MAX_ZIP_32, "ZIP package is too large");
    const checksum = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_LOCAL_FILE, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(ZIP_DATE_1980_01_01, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_FILE, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION, 6);
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(ZIP_DATE_1980_01_01, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);

    localOffset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  assert.ok(centralDirectory.length <= MAX_ZIP_32, "ZIP directory is too large");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function readStoredZip(archive) {
  assert.ok(archive.length >= 22, "ZIP package is incomplete");
  const endOffset = archive.length - 22;
  assert.equal(archive.readUInt32LE(endOffset), ZIP_END, "ZIP package has no end record");
  assert.equal(archive.readUInt16LE(endOffset + 20), 0, "ZIP comments are not allowed");
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  assert.equal(centralOffset + centralSize, endOffset, "ZIP directory offsets are invalid");

  const entries = new Map();
  const localOffsets = new Map();
  let offset = 0;
  while (offset < centralOffset) {
    assert.equal(archive.readUInt32LE(offset), ZIP_LOCAL_FILE, "ZIP local header is invalid");
    assert.equal(archive.readUInt16LE(offset + 8), 0, "ZIP entries must be stored without compression");
    const checksum = archive.readUInt32LE(offset + 14);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const size = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    assert.equal(compressedSize, size, "Stored ZIP entry sizes do not match");
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + size;
    assert.ok(dataEnd <= centralOffset, "ZIP entry crosses the central directory");
    const name = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
    assertSafeArchiveName(name);
    assert.ok(!entries.has(name), `Duplicate ZIP path: ${name}`);
    const data = archive.subarray(dataStart, dataEnd);
    assert.equal(crc32(data), checksum, `ZIP checksum failed for ${name}`);
    entries.set(name, Buffer.from(data));
    localOffsets.set(name, offset);
    offset = dataEnd;
  }
  assert.equal(offset, centralOffset, "ZIP local entries do not fill the data section");
  assert.equal(entries.size, entryCount, "ZIP entry count is wrong");

  let centralCursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(archive.readUInt32LE(centralCursor), ZIP_CENTRAL_FILE, "ZIP directory entry is invalid");
    assert.equal(archive.readUInt16LE(centralCursor + 10), 0, "ZIP directory uses compression");
    const nameLength = archive.readUInt16LE(centralCursor + 28);
    const extraLength = archive.readUInt16LE(centralCursor + 30);
    const commentLength = archive.readUInt16LE(centralCursor + 32);
    const localHeaderOffset = archive.readUInt32LE(centralCursor + 42);
    const nameStart = centralCursor + 46;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
    assert.ok(entries.has(name), `ZIP directory references a missing entry: ${name}`);
    assert.equal(localOffsets.get(name), localHeaderOffset, `ZIP offset is wrong for ${name}`);
    centralCursor = nameStart + nameLength + extraLength + commentLength;
  }
  assert.equal(centralCursor, endOffset, "ZIP directory size is wrong");
  return entries;
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function normalizePackageFile(name, data) {
  const source = Buffer.from(data);
  if (
    !TEXT_PACKAGE_NAMES.has(name) &&
    !TEXT_PACKAGE_EXTENSIONS.has(extname(name).toLowerCase())
  ) {
    return source;
  }

  const text = source.toString("utf8");
  assert.deepEqual(
    Buffer.from(text, "utf8"),
    source,
    `Package text file is not valid UTF-8: ${name}`,
  );
  return Buffer.from(text.replaceAll("\r\n", "\n").replaceAll("\r", "\n"), "utf8");
}

export function buildExtensionPackage(root = projectRoot) {
  const packageJson = readJson(root, "package.json");
  const manifest = readJson(root, "manifest.json");
  assertVersionAgreement(packageJson, manifest);
  const files = getExtensionPackageFiles(root);
  const entries = files.map((name) => ({
    name,
    data: normalizePackageFile(name, readFileSync(join(root, name))),
  }));
  const archive = buildStoredZip(entries);
  const archiveName = `lecture-notes-${packageJson.version}.zip`;
  return {
    archive,
    archiveName,
    checksum: sha256(archive),
    checksumName: `${archiveName}.sha256`,
    files,
    version: packageJson.version,
  };
}

export function checksumFileContents(checksum, archiveName) {
  assert.equal(basename(archiveName), archiveName, "Checksum filename must not include a path");
  return `${checksum}  ${archiveName}\n`;
}
