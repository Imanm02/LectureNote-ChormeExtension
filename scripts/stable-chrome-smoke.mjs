import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
assert.ok(process.argv.length <= 3, "Stable Chrome smoke accepts at most one extension root");
const extensionRoot = process.argv[2] ? resolve(process.argv[2]) : projectRoot;
const manifest = JSON.parse(await readFile(join(extensionRoot, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3, "The extension root must contain an MV3 manifest");
assert.equal(
  typeof manifest.background?.service_worker,
  "string",
  "The extension must declare an MV3 service worker",
);

const profilePrefix = "lecture-notes-stable-chrome-";
const temporaryRoot = resolve(tmpdir());
const fixtureTitle = "Stable Chrome fixture";
const fixtureSelection = "Stable Chrome toolbar capture text.";
const savedTitle = "Stable Chrome action test";
const browserErrors = [];
const recordedBrowserErrors = new Set();
const trackedServiceWorkers = new WeakSet();
const serviceWorkerTrackers = new Set();
const profile = assertTemporaryProfile(await mkdtemp(join(temporaryRoot, profilePrefix)));

let browserCdp;
let context;
let extensionId = "";
let fixtureServer;
let popupConnection;
let primaryError;
const cleanupErrors = [];

function assertTemporaryProfile(path) {
  const resolvedPath = resolve(path);
  assert.ok(
    resolvedPath.startsWith(`${temporaryRoot}${sep}`) &&
      basename(resolvedPath).startsWith(profilePrefix),
    "The Chrome profile must be a test-owned temporary directory",
  );
  return resolvedPath;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function recordBrowserError(source, message) {
  const entry = `${source}: ${message}`;
  if (recordedBrowserErrors.has(entry)) {
    return;
  }
  recordedBrowserErrors.add(entry);
  browserErrors.push(entry);
}

function isExtensionServiceWorker(worker) {
  try {
    const url = new URL(worker.url());
    return (
      url.protocol === "chrome-extension:" &&
      url.pathname === `/${manifest.background.service_worker}`
    );
  } catch {
    return false;
  }
}

async function installServiceWorkerErrorHooks(worker) {
  if (!isExtensionServiceWorker(worker)) {
    return;
  }

  try {
    await worker.evaluate(() => {
      const marker = Symbol.for("lectureNotes.stableChromeSmokeErrorHooks");
      if (globalThis[marker]) {
        return;
      }
      globalThis[marker] = true;

      const describe = (value) => {
        if (value instanceof Error) {
          return value.stack || value.message;
        }
        if (typeof value === "string") {
          return value;
        }
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      };

      globalThis.addEventListener("error", (event) => {
        console.error("Stable Chrome worker error:", describe(event.error || event.message));
      });
      globalThis.addEventListener("unhandledrejection", (event) => {
        console.error("Stable Chrome worker rejection:", describe(event.reason));
      });
    });
  } catch (error) {
    recordBrowserError(
      `service worker ${worker.url() || "at an unknown URL"}`,
      `Could not install error listeners: ${errorText(error)}`,
    );
  }
}

function trackServiceWorker(worker) {
  if (trackedServiceWorkers.has(worker)) {
    return;
  }
  trackedServiceWorkers.add(worker);
  const tracker = installServiceWorkerErrorHooks(worker).finally(() => {
    serviceWorkerTrackers.delete(tracker);
  });
  serviceWorkerTrackers.add(tracker);
}

async function finishServiceWorkerTracking() {
  await Promise.all([...serviceWorkerTrackers]);
}

function installContextErrorTracking(browserContext) {
  browserContext.on("console", (message) => {
    if (message.type() !== "error") {
      return;
    }
    const worker = message.worker();
    const source = worker
      ? `service worker ${worker.url() || "at an unknown URL"}`
      : message.page()?.url() || message.location().url || "browser console";
    recordBrowserError(source, message.text());
  });
  browserContext.on("weberror", (webError) => {
    const location = webError.location();
    recordBrowserError(
      location.url || webError.page()?.url() || "browser page",
      webError.error().message,
    );
  });
  browserContext.on("serviceworker", trackServiceWorker);
  for (const worker of browserContext.serviceWorkers()) {
    trackServiceWorker(worker);
  }
}

async function startFixtureServer() {
  const server = createServer((request, response) => {
    if (request.url === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url !== "/lecture") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    });
    response.end(
      `<!doctype html><html><head><title>${fixtureTitle}</title><link rel="icon" href="data:,"></head><body><main><h1>Lecture fixture</h1><iframe id="lectureFrame" title="Lecture frame" srcdoc="<p id='selection'>${fixtureSelection}</p>"></iframe></main></body></html>`,
    );
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  assert.ok(address && typeof address === "object", "The fixture server did not start");
  return {
    server,
    url: `http://127.0.0.1:${address.port}/lecture`,
  };
}

async function closeFixtureServer(server) {
  if (!server?.listening) {
    return;
  }
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function waitForValue(readValue, isReady, message, attempts = 160) {
  let value;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    value = await readValue();
    if (isReady(value)) {
      return value;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.fail(message);
}

function popupErrorMessage(message) {
  if (message.method === "Runtime.exceptionThrown") {
    const details = message.params?.exceptionDetails;
    return details?.exception?.description || details?.text || "Popup exception";
  }
  if (message.method === "Runtime.consoleAPICalled") {
    if (!["error", "assert"].includes(message.params?.type)) {
      return "";
    }
    return (message.params?.args || [])
      .map((argument) => argument.value ?? argument.description ?? argument.type)
      .join(" ");
  }
  if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
    return message.params.entry.text || "Popup log error";
  }
  return "";
}

async function connectToPopup(cdpSession, targetId, popupUrl) {
  const { sessionId } = await cdpSession.send("Target.attachToTarget", {
    targetId,
    flatten: false,
  });
  let commandId = 0;
  const pending = new Map();

  const receive = (event) => {
    if (event.sessionId !== sessionId) {
      return;
    }
    const message = JSON.parse(event.message);
    const popupError = popupErrorMessage(message);
    if (popupError) {
      recordBrowserError(popupUrl, popupError);
    }
    const request = pending.get(message.id);
    if (!request) {
      return;
    }
    globalThis.clearTimeout(request.timeout);
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(`${message.error.code}: ${message.error.message}`));
    } else {
      request.resolve(message.result);
    }
  };

  cdpSession.on("Target.receivedMessageFromTarget", receive);

  const send = async (method, params = {}) => {
    const id = ++commandId;
    let timeout;
    const result = new Promise((resolveResult, rejectResult) => {
      timeout = globalThis.setTimeout(() => {
        pending.delete(id);
        rejectResult(new Error(`Popup CDP command timed out: ${method}`));
      }, 5_000);
      pending.set(id, { resolve: resolveResult, reject: rejectResult, timeout });
    });
    try {
      await cdpSession.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id, method, params }),
      });
    } catch (error) {
      globalThis.clearTimeout(timeout);
      pending.delete(id);
      throw error;
    }
    return result;
  };

  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    assert.equal(
      response.exceptionDetails,
      undefined,
      response.exceptionDetails?.exception?.description || response.exceptionDetails?.text,
    );
    return response.result.value;
  };

  const detach = async () => {
    cdpSession.off("Target.receivedMessageFromTarget", receive);
    for (const request of pending.values()) {
      globalThis.clearTimeout(request.timeout);
      request.reject(new Error("The popup CDP session closed"));
    }
    pending.clear();
    await cdpSession.send("Target.detachFromTarget", { sessionId });
  };

  await send("Runtime.enable");
  await send("Log.enable");
  await evaluate(`(() => {
    const marker = Symbol.for("lectureNotes.stableChromePopupErrorHooks");
    if (globalThis[marker]) return true;
    globalThis[marker] = true;
    const describe = (value) => value instanceof Error
      ? value.stack || value.message
      : typeof value === "string"
        ? value
        : String(value);
    globalThis.addEventListener("error", (event) => {
      console.error("Stable Chrome popup error:", describe(event.error || event.message));
    });
    globalThis.addEventListener("unhandledrejection", (event) => {
      console.error("Stable Chrome popup rejection:", describe(event.reason));
    });
    return true;
  })()`);

  return { detach, evaluate };
}

async function runSmoke() {
  const fixture = await startFixtureServer();
  fixtureServer = fixture.server;
  context = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { width: 1280, height: 900 },
    args: [
      "--disable-component-extensions-with-background-pages",
      "--enable-unsafe-extension-debugging",
    ],
  });
  installContextErrorTracking(context);

  const runningVersion = context.browser().version();
  const runningMajor = Number.parseInt(runningVersion, 10);
  const minimumMajor = Number.parseInt(manifest.minimum_chrome_version || "0", 10);
  assert.ok(Number.isInteger(runningMajor), "Stable Chrome did not report a valid version");
  assert.ok(
    runningMajor >= minimumMajor,
    `Stable Chrome ${runningVersion} is older than the required version ${minimumMajor}`,
  );

  browserCdp = await context.browser().newBrowserCDPSession();
  const workerPromise = context.waitForEvent("serviceworker", {
    predicate: isExtensionServiceWorker,
    timeout: 10_000,
  });
  const loadResult = await browserCdp.send("Extensions.loadUnpacked", {
    path: extensionRoot,
  });
  extensionId = loadResult.id;
  assert.match(extensionId, /^[a-p]{32}$/u, "Stable Chrome returned an invalid extension ID");

  const serviceWorker = await workerPromise;
  trackServiceWorker(serviceWorker);
  await finishServiceWorkerTracking();
  assert.equal(
    serviceWorker.url(),
    `chrome-extension://${extensionId}/${manifest.background.service_worker}`,
    "The loaded service worker does not match the manifest",
  );
  const workerHealth = await serviceWorker.evaluate(() => ({
    id: globalThis.chrome.runtime.id,
    manifestVersion: globalThis.chrome.runtime.getManifest().manifest_version,
    errorHooksInstalled: Boolean(
      globalThis[Symbol.for("lectureNotes.stableChromeSmokeErrorHooks")],
    ),
  }));
  assert.deepEqual(workerHealth, {
    id: extensionId,
    manifestVersion: 3,
    errorHooksInstalled: true,
  });

  const extensionList = await browserCdp.send("Extensions.getExtensions");
  const loadedExtension = extensionList.extensions.find((entry) => entry.id === extensionId);
  assert.ok(loadedExtension, "Stable Chrome did not list the loaded extension");
  assert.equal(loadedExtension.name, manifest.name);
  assert.equal(loadedExtension.version, manifest.version);
  assert.equal(loadedExtension.enabled, true);
  assert.equal(resolve(loadedExtension.path), extensionRoot);

  const fixturePage = await context.newPage();
  await fixturePage.goto(fixture.url);
  const frameSelection = fixturePage.frameLocator("#lectureFrame").locator("#selection");
  await frameSelection.click();
  await frameSelection.evaluate((element) => {
    const range = globalThis.document.createRange();
    range.selectNodeContents(element);
    const selection = globalThis.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  assert.equal(
    await fixturePage.evaluate(() => globalThis.document.activeElement?.id),
    "lectureFrame",
    "The embedded lecture frame did not receive focus",
  );
  await fixturePage.bringToFront();

  const tabTargets = await browserCdp.send("Target.getTargets", {
    filter: [{ type: "tab", exclude: false }, { exclude: true }],
  });
  const activeTab = tabTargets.targetInfos.find((target) => target.url === fixture.url);
  assert.ok(activeTab, "The fixture tab target was not found");
  await browserCdp.send("Extensions.triggerAction", {
    id: extensionId,
    targetId: activeTab.targetId,
  });

  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  const popupTarget = await waitForValue(
    async () => {
      const targets = await browserCdp.send("Target.getTargets", { filter: [{}] });
      return targets.targetInfos.find(
        (target) => target.type === "page" && target.url === popupUrl,
      );
    },
    Boolean,
    "The action popup target did not appear",
  );
  popupConnection = await connectToPopup(browserCdp, popupTarget.targetId, popupUrl);

  await waitForValue(
    () => popupConnection.evaluate(
      `Boolean(document.querySelector("#dataConsentDialog[open]") && document.querySelector("#dataConsentAcceptButton:not([disabled])"))`,
    ),
    Boolean,
    "The popup consent gate did not become ready",
  );
  assert.deepEqual(
    await popupConnection.evaluate("chrome.storage.local.get(null)"),
    {},
    "The extension wrote local data before consent",
  );
  await popupConnection.evaluate(
    `document.querySelector("#dataConsentAcceptButton").click(); true`,
  );

  const capture = await waitForValue(
    () => popupConnection.evaluate(`(() => ({
      consentOpen: document.querySelector("#dataConsentDialog")?.hasAttribute("open"),
      body: document.querySelector("#bodyInput")?.value,
      sourceTitle: document.querySelector("#sourceTitle")?.textContent?.trim(),
      sourceUrl: document.querySelector("#sourceLink")?.getAttribute("href"),
      status: document.querySelector("#status")?.textContent?.trim(),
    }))()`),
    (value) => value.consentOpen === false && value.body === fixtureSelection,
    "The action popup did not capture the selected text",
  );
  assert.deepEqual(capture, {
    consentOpen: false,
    body: fixtureSelection,
    sourceTitle: fixtureTitle,
    sourceUrl: fixture.url,
    status: "Selection captured. Edit it before saving.",
  });

  await popupConnection.evaluate(`(() => {
    const title = document.querySelector("#titleInput");
    title.value = ${JSON.stringify(savedTitle)};
    title.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#noteForm").requestSubmit();
    return true;
  })()`);
  const saved = await waitForValue(
    () => popupConnection.evaluate(`(async () => {
      const stored = await chrome.storage.local.get("lectureNoteState");
      return {
        status: document.querySelector("#status")?.textContent?.trim(),
        notes: stored.lectureNoteState?.notes?.map(({ title, body, course, source }) => ({
          title,
          body,
          course,
          source,
        })),
      };
    })()`),
    (value) => value.notes?.length === 1,
    "The popup did not save the captured note",
  );
  assert.equal(saved.status, "Note saved. Source kept for the next note.");
  assert.deepEqual(saved.notes, [{
    title: savedTitle,
    body: fixtureSelection,
    course: "",
    source: {
      title: fixtureTitle,
      url: fixture.url,
    },
  }]);

  await finishServiceWorkerTracking();
  assert.deepEqual(browserErrors, [], `Browser errors: ${browserErrors.join(" | ")}`);
  console.log(
    `Stable Chrome smoke passed in ${runningVersion}: focused-frame action capture, consent, source context, save, and local storage.`,
  );
}

try {
  await runSmoke();
} catch (error) {
  primaryError = error;
} finally {
  if (popupConnection) {
    await popupConnection.detach().catch((error) => cleanupErrors.push(error));
  }
  if (extensionId && browserCdp) {
    await browserCdp
      .send("Extensions.uninstall", { id: extensionId })
      .catch((error) => cleanupErrors.push(error));
  }
  await browserCdp?.detach().catch((error) => cleanupErrors.push(error));
  await context?.close().catch((error) => cleanupErrors.push(error));
  await closeFixtureServer(fixtureServer).catch((error) => cleanupErrors.push(error));
  await rm(assertTemporaryProfile(profile), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  }).catch((error) => cleanupErrors.push(error));
}

if (primaryError) {
  if (cleanupErrors.length > 0) {
    console.error("Stable Chrome smoke cleanup errors:", cleanupErrors.map(errorText));
  }
  throw primaryError;
}
if (cleanupErrors.length > 0) {
  throw new AggregateError(cleanupErrors, "Stable Chrome smoke cleanup failed");
}
