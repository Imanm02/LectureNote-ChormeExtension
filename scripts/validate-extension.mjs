import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (path) => readFileSync(join(root, path), "utf8");
const manifest = JSON.parse(readText("manifest.json"));
const expectedPermissions = ["activeTab", "scripting", "storage"];

assert.equal(manifest.manifest_version, 3, "Manifest V3 is required");
assert.equal(manifest.minimum_chrome_version, "114", "Chrome 114 or newer is required");
assert.deepEqual([...manifest.permissions].sort(), [...expectedPermissions].sort());
assert.equal(manifest.host_permissions, undefined, "Host permissions are not allowed");
assert.equal(manifest.optional_permissions, undefined, "Optional permissions are not allowed");
assert.equal(manifest.optional_host_permissions, undefined, "Optional host permissions are not allowed");
assert.equal(manifest.content_scripts, undefined, "Persistent content scripts are not allowed");
assert.deepEqual(manifest.background, {
  service_worker: "src/background.js",
  type: "module",
});
assert.equal(manifest.web_accessible_resources, undefined, "Web-accessible resources are not needed");
assert.equal(manifest.externally_connectable, undefined, "External messaging is not allowed");
assert.equal(manifest.content_security_policy, undefined, "The default extension CSP is required");
assert.equal(manifest.action.default_popup, "popup.html");
assert.ok(manifest.commands?._execute_action, "The quick-capture command is missing");

function listFiles(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function validatePng(path, expectedSize) {
  const data = readFileSync(join(root, path));
  assert.equal(data.subarray(1, 4).toString("ascii"), "PNG", `${path} is not a PNG file`);
  assert.equal(data.readUInt32BE(16), expectedSize, `${path} has the wrong width`);
  assert.equal(data.readUInt32BE(20), expectedSize, `${path} has the wrong height`);
}

function validateLocalResource(value, htmlFile) {
  assert.doesNotMatch(
    value,
    /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/iu,
    `${htmlFile} loads a nonlocal resource`,
  );
  assert.ok(existsSync(join(root, value)), `Missing page resource: ${value}`);
}

for (const [size, path] of Object.entries(manifest.icons)) {
  assert.ok(existsSync(join(root, path)), `Missing icon: ${path}`);
  validatePng(path, Number(size));
}

const htmlFiles = [manifest.action.default_popup, "notes.html"];
const extensionScripts = new Set();
for (const htmlFile of htmlFiles) {
  const documentValue = new JSDOM(readText(htmlFile)).window.document;
  assert.equal(documentValue.documentElement.lang, "en", `${htmlFile} needs a language`);
  assert.ok(documentValue.querySelector("meta[charset]"), `${htmlFile} needs UTF-8 metadata`);
  assert.ok(documentValue.querySelector('meta[name="viewport"]'), `${htmlFile} needs viewport metadata`);
  assert.ok(documentValue.title.trim(), `${htmlFile} needs a title`);
  assert.equal(documentValue.querySelectorAll("h1").length, 1, `${htmlFile} needs one main heading`);
  assert.equal(documentValue.querySelector("[onload], [onclick], [onerror]"), null, `${htmlFile} has inline code`);

  for (const script of documentValue.querySelectorAll("script")) {
    assert.equal(script.textContent.trim(), "", `${htmlFile} has an inline script`);
    assert.equal(script.type, "module", `${htmlFile} scripts must use modules`);
    assert.ok(script.src, `${htmlFile} has a script without a source`);
    const path = script.getAttribute("src");
    validateLocalResource(path, htmlFile);
    extensionScripts.add(path);
  }

  for (const element of documentValue.querySelectorAll("link[href], img[src], audio[src], video[src], source[src]")) {
    const attribute = element.hasAttribute("href") ? "href" : "src";
    const value = element.getAttribute(attribute);
    validateLocalResource(value, htmlFile);
  }
}

for (const path of listFiles("src").filter((file) => extname(file) === ".js")) {
  const result = spawnSync(process.execPath, ["--check", join(root, path)], { encoding: "utf8" });
  assert.equal(result.status, 0, `${path} does not parse:\n${result.stderr}`);
  const source = readText(path);
  assert.doesNotMatch(source, /\b(innerHTML|outerHTML|insertAdjacentHTML)\b/u, `${path} uses an HTML sink`);
  assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\s*\(/u, `${path} uses dynamic code`);
  assert.doesNotMatch(source, /\bfetch\s*\(/u, `${path} makes a network request`);
}

for (const script of extensionScripts) {
  assert.ok(existsSync(join(root, script)), `Missing extension script: ${script}`);
}

const trackedExtensionFiles = [
  "manifest.json",
  ...htmlFiles,
  ...listFiles("src").filter((file) => extname(file) === ".js"),
];
for (const path of trackedExtensionFiles) {
  const source = readText(path);
  assert.doesNotMatch(source, /sk-[A-Za-z0-9_-]{16,}/u, `${path} contains an API credential`);
  assert.doesNotMatch(source, /gh[pousr]_[A-Za-z0-9]{20,}/u, `${path} contains a GitHub token`);
}

console.log(`Extension validation passed for ${relative(root, join(root, "manifest.json"))}.`);
