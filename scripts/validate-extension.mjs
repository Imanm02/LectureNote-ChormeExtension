import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

import { validateHtmlAccessibility } from "./extension-html.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (path) => readFileSync(join(root, path), "utf8");
const manifest = JSON.parse(readText("manifest.json"));
const packageJson = JSON.parse(readText("package.json"));
const packageLock = JSON.parse(readText("package-lock.json"));
const expectedPermissions = ["activeTab", "contextMenus", "scripting", "sidePanel", "storage"];
const expectedCommand = {
  suggested_key: {
    default: "Ctrl+Shift+Y",
    mac: "Command+Shift+Y",
  },
};

assert.equal(manifest.manifest_version, 3, "Manifest V3 is required");
assert.match(manifest.version, /^\d+\.\d+\.\d+$/u, "Manifest version must use three numbers");
assert.equal(manifest.version, packageJson.version, "Manifest and package versions must match");
assert.equal(packageLock.version, packageJson.version, "Lockfile and package versions must match");
assert.equal(packageLock.packages?.[""]?.version, packageJson.version, "Lockfile root version is wrong");
assert.deepEqual(
  packageLock.packages?.[""]?.devDependencies,
  packageJson.devDependencies,
  "Lockfile development dependencies do not match package.json",
);
assert.equal(manifest.minimum_chrome_version, "116", "Chrome 116 or newer is required");
assert.ok(manifest.name?.trim(), "Manifest name is required");
assert.ok(manifest.description?.trim(), "Manifest description is required");
assert.ok(manifest.description.length <= 132, "Manifest description is too long");
assert.deepEqual([...manifest.permissions].sort(), [...expectedPermissions].sort());
assert.equal(manifest.host_permissions, undefined, "Host permissions are not allowed");
assert.equal(manifest.optional_permissions, undefined, "Optional permissions are not allowed");
assert.equal(manifest.optional_host_permissions, undefined, "Optional host permissions are not allowed");
assert.equal(manifest.content_scripts, undefined, "Persistent content scripts are not allowed");
assert.equal(manifest.web_accessible_resources, undefined, "Web-accessible resources are not needed");
assert.equal(manifest.externally_connectable, undefined, "External messaging is not allowed");
assert.equal(manifest.content_security_policy, undefined, "The default extension CSP is required");
assert.equal(manifest.update_url, undefined, "A custom update URL is not allowed");
assert.equal(manifest.oauth2, undefined, "OAuth configuration is not allowed");
assert.equal(manifest.sandbox, undefined, "Sandboxed pages are not needed");
assert.deepEqual(manifest.background, {
  service_worker: "src/background.js",
  type: "module",
});
assert.equal(manifest.action.default_popup, "popup.html");
assert.deepEqual(manifest.side_panel, { default_path: "notes.html" });
assert.deepEqual(manifest.commands, { _execute_action: expectedCommand });

function listFiles(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function toProjectPath(path) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  assert.ok(resolvedPath.startsWith(`${resolvedRoot}${sep}`), `Path leaves the project: ${path}`);
  return relative(resolvedRoot, resolvedPath).split(sep).join("/");
}

function validatePng(path, expectedSize) {
  const data = readFileSync(join(root, path));
  assert.equal(data.subarray(1, 4).toString("ascii"), "PNG", `${path} is not a PNG file`);
  assert.equal(data.readUInt32BE(16), expectedSize, `${path} has the wrong width`);
  assert.equal(data.readUInt32BE(20), expectedSize, `${path} has the wrong height`);
}

function validateLocalResource(value, owner) {
  assert.ok(value, `${owner} has an empty resource reference`);
  assert.doesNotMatch(value, /\\/u, `${owner} uses a backslash in a resource path`);
  assert.doesNotMatch(
    value,
    /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/iu,
    `${owner} loads a nonlocal resource`,
  );
  const withoutFragment = value.split("#", 1)[0].split("?", 1)[0];
  if (!withoutFragment) {
    return null;
  }
  const resolved = resolve(root, dirname(owner), withoutFragment);
  const path = toProjectPath(resolved);
  assert.ok(existsSync(resolved), `Missing resource used by ${owner}: ${path}`);
  assert.ok(statSync(resolved).isFile(), `Resource used by ${owner} is not a file: ${path}`);
  return path;
}

function validateManifestResource(path) {
  const normalized = validateLocalResource(path, "manifest.json");
  assert.equal(normalized, path, `Manifest resource path is not normalized: ${path}`);
  return normalized;
}

for (const [size, path] of Object.entries(manifest.icons)) {
  validateManifestResource(path);
  validatePng(path, Number(size));
}
for (const [size, path] of Object.entries(manifest.action.default_icon)) {
  validateManifestResource(path);
  validatePng(path, Number(size));
  assert.equal(path, manifest.icons[size], `Action icon ${size} does not match the extension icon`);
}
validateManifestResource(manifest.background.service_worker);
validateManifestResource(manifest.action.default_popup);
validateManifestResource(manifest.side_panel.default_path);

const htmlFiles = [...new Set([manifest.action.default_popup, manifest.side_panel.default_path])];
const extensionScripts = new Set([manifest.background.service_worker]);
const extensionStyles = new Set();
for (const htmlFile of htmlFiles) {
  const documentValue = new JSDOM(readText(htmlFile)).window.document;
  assert.equal(documentValue.documentElement.lang, "en", `${htmlFile} needs a language`);
  assert.ok(documentValue.querySelector("meta[charset]"), `${htmlFile} needs UTF-8 metadata`);
  assert.ok(documentValue.querySelector('meta[name="viewport"]'), `${htmlFile} needs viewport metadata`);
  assert.equal(documentValue.querySelector('meta[http-equiv="refresh" i]'), null, `${htmlFile} redirects automatically`);
  assert.ok(documentValue.title.trim(), `${htmlFile} needs a title`);
  assert.equal(documentValue.querySelectorAll("h1").length, 1, `${htmlFile} needs one main heading`);
  assert.equal(documentValue.querySelector("base, iframe, object, embed"), null, `${htmlFile} embeds another document`);
  validateHtmlAccessibility(documentValue, htmlFile);

  for (const element of documentValue.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      assert.ok(!attribute.name.startsWith("on"), `${htmlFile} has inline event code`);
    }
  }

  for (const script of documentValue.querySelectorAll("script")) {
    assert.equal(script.textContent.trim(), "", `${htmlFile} has an inline script`);
    assert.equal(script.type, "module", `${htmlFile} scripts must use modules`);
    assert.ok(script.src, `${htmlFile} has a script without a source`);
    const path = validateLocalResource(script.getAttribute("src"), htmlFile);
    assert.equal(extname(path), ".js", `${htmlFile} loads a non-JavaScript script`);
    extensionScripts.add(path);
  }

  for (const element of documentValue.querySelectorAll("[href], [src]")) {
    if (element.localName === "script") {
      continue;
    }
    const attribute = element.hasAttribute("href") ? "href" : "src";
    const value = element.getAttribute(attribute)?.trim();
    if (!value || value.startsWith("#")) {
      continue;
    }
    const path = validateLocalResource(value, htmlFile);
    if (element.localName === "link" && element.rel === "stylesheet") {
      assert.equal(extname(path), ".css", `${htmlFile} loads a non-CSS stylesheet`);
      extensionStyles.add(path);
    }
  }
}

const staticImportPatterns = [
  /\b(?:import|export)\s+[^;]*?\sfrom\s*["']([^"']+)["']/gu,
  /\bimport\s*["']([^"']+)["']/gu,
];
const networkChecks = [
  [/(?:^|\W)fetch\s*\(/u, "fetch"],
  [/\bXMLHttpRequest\b/u, "XMLHttpRequest"],
  [/\bWebSocket\b/u, "WebSocket"],
  [/\bWebTransport\b/u, "WebTransport"],
  [/\bEventSource\b/u, "EventSource"],
  [/\bsendBeacon\s*\(/u, "sendBeacon"],
  [/\bimportScripts\s*\(/u, "importScripts"],
];

for (const path of listFiles("src").filter((file) => extname(file) === ".js")) {
  const result = spawnSync(process.execPath, ["--check", join(root, path)], { encoding: "utf8" });
  assert.equal(result.status, 0, `${path} does not parse:\n${result.stderr}`);
  const source = readText(path);
  assert.doesNotMatch(source, /\b(innerHTML|outerHTML|insertAdjacentHTML)\b/u, `${path} uses an HTML sink`);
  assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\s*\(/u, `${path} uses dynamic code`);
  assert.doesNotMatch(source, /\bimport\s*\(/u, `${path} uses a dynamic import`);
  for (const [pattern, name] of networkChecks) {
    assert.doesNotMatch(source, pattern, `${path} uses the network API ${name}`);
  }

  for (const pattern of staticImportPatterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      assert.match(specifier, /^\.\.?\//u, `${path} imports a nonlocal module: ${specifier}`);
      assert.doesNotMatch(specifier, /[?#]/u, `${path} imports a module with a query or fragment`);
      const importedPath = validateLocalResource(specifier, path);
      assert.ok(importedPath.startsWith("src/"), `${path} imports code outside src: ${importedPath}`);
      assert.equal(extname(importedPath), ".js", `${path} imports a non-JavaScript module`);
    }
  }
}

for (const path of extensionScripts) {
  assert.ok(path.startsWith("src/"), `Extension script is outside src: ${path}`);
  assert.ok(existsSync(join(root, path)), `Missing extension script: ${path}`);
}

for (const path of extensionStyles) {
  const source = readText(path);
  assert.doesNotMatch(source, /@import\b/iu, `${path} uses a CSS import`);
  for (const match of source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
    const reference = match[1].trim();
    assert.doesNotMatch(reference, /^data:/iu, `${path} embeds a data URL`);
    validateLocalResource(reference, path);
  }
}

const gitFiles = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "buffer" },
);
assert.equal(gitFiles.status, 0, `Could not list files for credential checks:\n${gitFiles.stderr}`);
const credentialChecks = [
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/u, "OpenAI API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/u, "GitHub token"],
  [/\bAIza[A-Za-z0-9_-]{35}\b/u, "Google API key"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u, "AWS access key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u, "Slack token"],
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u, "private key"],
];

for (const path of gitFiles.stdout.toString("utf8").split("\0").filter(Boolean)) {
  const data = readFileSync(join(root, path));
  if (data.includes(0)) {
    continue;
  }
  const source = data.toString("utf8");
  for (const [pattern, label] of credentialChecks) {
    assert.doesNotMatch(source, pattern, `${path} contains a possible ${label}`);
  }
}

console.log(`Extension validation passed for ${relative(root, join(root, "manifest.json"))}.`);
