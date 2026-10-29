import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertVersionAgreement,
  buildExtensionPackage,
  buildStoredZip,
  checksumFileContents,
  crc32,
  getExtensionPackageFiles,
  projectRoot,
  readStoredZip,
  sha256,
} from "../scripts/release-package.mjs";

test("release package is deterministic and contains only allowed files", () => {
  const first = buildExtensionPackage();
  const second = buildExtensionPackage();

  assert.deepEqual(first.archive, second.archive);
  assert.equal(first.checksum, sha256(first.archive));
  assert.equal(
    checksumFileContents(first.checksum, first.archiveName),
    `${first.checksum}  ${first.archiveName}\n`,
  );

  const entries = readStoredZip(first.archive);
  assert.deepEqual([...entries.keys()], first.files);
  for (const [name, data] of entries) {
    assert.deepEqual(data, readFileSync(join(projectRoot, name)), `${name} differs from the source file`);
    assert.doesNotMatch(name, /^(?:tests|scripts|node_modules|docs|dist)\//u);
    assert.notEqual(name, "package.json");
    assert.notEqual(name, "package-lock.json");
  }
});

test("release package includes the extension pages and privacy notice", () => {
  const release = buildExtensionPackage();

  for (const name of [
    "manifest.json",
    "popup.html",
    "notes.html",
    "src/background.js",
    "src/popup.js",
    "src/notes.js",
    "PRIVACY.md",
    "LICENSE",
  ]) {
    assert.ok(release.files.includes(name), `Release package is missing ${name}`);
  }
});

test("release discovery starts from the side-panel manifest page", () => {
  const root = mkdtempSync(join(tmpdir(), "lecture-notes-package-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), '{"version":"1.0.0"}');
    writeFileSync(
      join(root, "manifest.json"),
      JSON.stringify({
        version: "1.0.0",
        background: { service_worker: "src/background.js" },
        side_panel: { default_path: "panel.html" },
      }),
    );
    writeFileSync(join(root, "src", "background.js"), "");
    writeFileSync(join(root, "panel.html"), '<link rel="stylesheet" href="panel.css">');
    writeFileSync(join(root, "panel.css"), "body { color: black; }");

    const files = getExtensionPackageFiles(root);

    assert.ok(files.includes("panel.html"));
    assert.ok(files.includes("panel.css"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ZIP writer rejects unsafe and duplicate paths", () => {
  assert.throws(
    () => buildStoredZip([{ name: "../secret.txt", data: Buffer.from("secret") }]),
    /Unsafe ZIP path/u,
  );
  assert.throws(
    () =>
      buildStoredZip([
        { name: "file.txt", data: Buffer.from("one") },
        { name: "file.txt", data: Buffer.from("two") },
      ]),
    /Duplicate ZIP path/u,
  );
});

test("ZIP reader detects changed entry data", () => {
  const archive = buildStoredZip([{ name: "file.txt", data: Buffer.from("original") }]);
  const changed = Buffer.from(archive);
  changed[changed.indexOf(Buffer.from("original"))] ^= 0xff;

  assert.throws(() => readStoredZip(changed), /ZIP checksum failed/u);
});

test("CRC-32 matches the standard check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("manifest and package versions must agree", () => {
  assert.doesNotThrow(() =>
    assertVersionAgreement({ version: "2.0.0" }, { version: "2.0.0" }),
  );
  assert.throws(
    () => assertVersionAgreement({ version: "2.0.0" }, { version: "2.0.1" }),
    /does not match/u,
  );
  assert.throws(
    () => assertVersionAgreement({ version: "2.0" }, { version: "2.0" }),
    /three numbers/u,
  );
});
