import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";

import { withExtractedStoredZip } from "./package-browser-smoke.mjs";
import {
  buildExtensionPackage,
  checksumFileContents,
  projectRoot,
} from "./release-package.mjs";
import {
  assertStoreScreenshotDimensions,
  STORE_SCREENSHOT_HEIGHT,
  STORE_SCREENSHOT_WIDTH,
} from "./store-screenshot-utils.mjs";

const storeAssetsDirectory = join(projectRoot, "store-assets");
const screenshotDirectory = join(storeAssetsDirectory, "screenshots");
const screenshotStagePrefix = ".screenshots-stage-";
const screenshotBackupPrefix = ".screenshots-backup-";
const profilePrefix = "lecture-notes-store-screenshots-";
const fixedClockStart = Date.parse("2025-01-15T12:00:00.000Z");
const screenshotNames = Object.freeze([
  "01-library-overview.png",
  "02-library-notes.png",
  "03-note-editor.png",
  "04-trash.png",
]);

const sampleNotes = Object.freeze([
  {
    title: "Graph Traversal Checklist",
    course: "Algorithms",
    body: "Breadth-first search uses a queue and finds shortest paths in an unweighted graph. Depth-first search uses a stack or recursion to explore one branch at a time.",
  },
  {
    title: "Cellular Respiration",
    course: "Biology 201",
    body: "Glycolysis begins in the cytosol. The citric acid cycle and oxidative phosphorylation continue the energy conversion process in mitochondria.",
  },
  {
    title: "Chain Rule Worked Example",
    course: "Calculus I",
    body: "For y = (3x² + 1)⁵, differentiate the outer function first, then multiply by the derivative of 3x² + 1.",
  },
  {
    title: "Primary Source Questions",
    course: "Modern History",
    body: "Identify who created the source and its intended audience. Compare the claim with evidence from the same period.",
  },
  {
    title: "Supply and Demand Shifts",
    course: "Economics",
    body: "A change in price moves along a curve. A change in income or production cost can shift a curve and produce a new equilibrium.",
  },
  {
    title: "Newton's Second Law",
    course: "Physics 101",
    body: "Net force equals mass multiplied by acceleration. Draw a free-body diagram before resolving force components.",
  },
  {
    title: "Research Interview Themes",
    course: "Social Research",
    body: "Code each transcript with a consistent scheme. Revisit the source passage when a theme changes during analysis.",
  },
  {
    title: "مرور جبر خطی",
    course: "ریاضی",
    body: "برای یافتن مقادیر ویژه، دترمینان ماتریس را بررسی کنید. سپس بردارهای ویژه را برای هر مقدار به دست آورید.",
  },
]);

function isWithin(directory, path) {
  const resolvedDirectory = resolve(directory);
  const resolvedPath = resolve(path);
  return resolvedPath.startsWith(`${resolvedDirectory}${sep}`);
}

function assertTemporaryProfile(path) {
  const temporaryDirectory = resolve(tmpdir());
  const resolvedPath = resolve(path);
  assert.ok(isWithin(temporaryDirectory, resolvedPath), "Screenshot profile left the temp directory");
  assert.ok(
    basename(resolvedPath).startsWith(profilePrefix),
    "Screenshot profile has an unexpected name",
  );
  return resolvedPath;
}

function serviceWorkerSource(worker) {
  return `service worker ${worker.url() || "at an unknown URL"}`;
}

async function writeVerifiedPackage(release) {
  const outputDirectory = join(projectRoot, "dist");
  const archivePath = join(outputDirectory, release.archiveName);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(archivePath, release.archive);
  await writeFile(
    join(outputDirectory, release.checksumName),
    checksumFileContents(release.checksum, release.archiveName),
    "utf8",
  );
  const archive = await readFile(archivePath);
  assert.deepEqual(archive, release.archive, "Stored release ZIP differs from the package just built");
  return archive;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function assertStoreAssetPath(path, expectedPrefix) {
  const resolvedPath = resolve(path);
  assert.ok(isWithin(storeAssetsDirectory, resolvedPath), "Screenshot work path left store-assets");
  assert.ok(basename(resolvedPath).startsWith(expectedPrefix), "Screenshot work path has an unexpected name");
  return resolvedPath;
}

async function createScreenshotStage() {
  await mkdir(storeAssetsDirectory, { recursive: true });
  const directory = await mkdtemp(join(storeAssetsDirectory, screenshotStagePrefix));
  return assertStoreAssetPath(directory, screenshotStagePrefix);
}

async function validateScreenshotSet(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  assert.ok(entries.every((entry) => entry.isFile()), "Screenshot staging contains a non-file entry");
  const names = entries.map((entry) => entry.name).sort();
  assert.deepEqual(names, [...screenshotNames].sort(), "Screenshot staging has an unexpected file set");

  for (const name of screenshotNames) {
    assertStoreScreenshotDimensions(await readFile(join(directory, name)), name);
  }
}

async function publishScreenshotSet(stagingDirectory) {
  const safeStagingDirectory = assertStoreAssetPath(stagingDirectory, screenshotStagePrefix);
  const backupDirectory = assertStoreAssetPath(
    join(
      storeAssetsDirectory,
      `${screenshotBackupPrefix}${process.pid}-${globalThis.crypto.randomUUID()}`,
    ),
    screenshotBackupPrefix,
  );
  const hadPublishedSet = await pathExists(screenshotDirectory);
  let movedPublishedSet = false;
  let movedStagingSet = false;

  if (hadPublishedSet) {
    await rename(screenshotDirectory, backupDirectory);
    movedPublishedSet = true;
  }

  try {
    await rename(safeStagingDirectory, screenshotDirectory);
    movedStagingSet = true;
    await validateScreenshotSet(screenshotDirectory);
  } catch (error) {
    if (movedStagingSet) {
      await rm(screenshotDirectory, { recursive: true, force: true });
    }
    if (movedPublishedSet) {
      await rename(backupDirectory, screenshotDirectory);
    }
    throw error;
  }

  if (movedPublishedSet) {
    await rm(backupDirectory, { recursive: true, force: true }).catch((error) => {
      console.warn(`Could not remove the previous screenshot backup: ${error.message}`);
    });
  }
}

function createErrorTracker(context, serviceWorkerScript) {
  const errors = [];
  const recorded = new Set();
  const trackedWorkers = new WeakSet();
  const workerTrackers = new Set();
  let observedWorkerStartups = 0;

  const record = (source, message) => {
    const entry = `${source}: ${message}`;
    if (!recorded.has(entry)) {
      recorded.add(entry);
      errors.push(entry);
    }
  };

  const isExtensionWorker = (worker) => {
    try {
      const url = new URL(worker.url());
      return url.protocol === "chrome-extension:" && url.pathname === `/${serviceWorkerScript}`;
    } catch {
      return false;
    }
  };

  const installWorkerHooks = async (worker) => {
    if (!isExtensionWorker(worker)) {
      return;
    }
    try {
      await worker.evaluate(() => {
        const marker = Symbol.for("lectureNotes.storeScreenshotErrorHooks");
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
          console.error("Store screenshot service worker error:", describe(event.error || event.message));
        });
        globalThis.addEventListener("unhandledrejection", (event) => {
          console.error("Store screenshot service worker rejection:", describe(event.reason));
        });
      });
    } catch (error) {
      record(
        serviceWorkerSource(worker),
        `Could not install error listeners: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const trackWorker = (worker) => {
    if (trackedWorkers.has(worker)) {
      return;
    }
    trackedWorkers.add(worker);
    const tracker = installWorkerHooks(worker).finally(() => workerTrackers.delete(tracker));
    workerTrackers.add(tracker);
  };

  context.on("console", (message) => {
    if (message.type() !== "error") {
      return;
    }
    const worker = message.worker();
    const source = worker
      ? serviceWorkerSource(worker)
      : message.page()?.url() || message.location().url || "browser console";
    record(source, message.text());
  });
  context.on("weberror", (webError) => {
    const location = webError.location();
    record(
      location.url || webError.page()?.url() || "browser page",
      webError.error().message,
    );
  });
  const observeWorkerStartup = (worker) => {
    if (isExtensionWorker(worker)) {
      observedWorkerStartups += 1;
    }
    trackWorker(worker);
  };
  context.on("serviceworker", observeWorkerStartup);
  for (const worker of context.serviceWorkers()) {
    trackWorker(worker);
  }

  return {
    errors,
    isExtensionWorker,
    trackWorker,
    observedWorkerStartups: () => observedWorkerStartups,
    finish: () => Promise.all([...workerTrackers]),
  };
}

async function sendWorkerHealthRequest(context, extensionId) {
  const healthPage = await context.newPage();
  try {
    await healthPage.goto(`chrome-extension://${extensionId}/manifest.json`);
    return await healthPage.evaluate(async () => {
      const epochKey = "lectureNoteDataEpoch";
      const stored = await globalThis.chrome.storage.local.get(epochKey);
      const hadEpoch = Object.hasOwn(stored, epochKey);
      const previousEpoch = stored[epochKey];
      const validEpoch = typeof previousEpoch === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(previousEpoch);
      const expectedEpoch = validEpoch ? previousEpoch : globalThis.crypto.randomUUID();
      if (!validEpoch) {
        await globalThis.chrome.storage.local.set({ [epochKey]: expectedEpoch });
      }
      try {
        return await new Promise((resolveResponse, rejectResponse) => {
          const timeout = globalThis.setTimeout(
            () => rejectResponse(new Error("The packaged worker health request timed out.")),
            5_000,
          );
          globalThis.chrome.runtime.sendMessage(
            {
              type: "save-draft",
              draft: null,
              sessionId: `store-screenshot-health-${globalThis.crypto.randomUUID()}`,
              expectedOwnerSessionId:
                `store-screenshot-mismatch-${globalThis.crypto.randomUUID()}`,
              expectedGeneration: Number.MAX_SAFE_INTEGER,
              contentGeneration: 1,
              expectedEpoch,
            },
            (messageResponse) => {
              globalThis.clearTimeout(timeout);
              const lastError = globalThis.chrome.runtime.lastError;
              if (lastError) {
                rejectResponse(new Error(lastError.message));
              } else {
                resolveResponse(messageResponse);
              }
            },
          );
        });
      } finally {
        if (hadEpoch) {
          await globalThis.chrome.storage.local.set({ [epochKey]: previousEpoch });
        } else {
          await globalThis.chrome.storage.local.remove(epochKey);
        }
      }
    });
  } finally {
    await healthPage.close().catch(() => undefined);
  }
}

async function loadExtensionAfterTracking(
  context,
  tracker,
  extensionRoot,
  serviceWorkerScript,
) {
  assert.equal(
    context.serviceWorkers().filter((worker) => {
      try {
        return new URL(worker.url()).protocol === "chrome-extension:";
      } catch {
        return false;
      }
    }).length,
    0,
    "An extension worker started before screenshot error tracking",
  );
  assert.equal(
    tracker.observedWorkerStartups(),
    0,
    "An extension worker event occurred before the listener barrier",
  );
  const observedStartup = context.waitForEvent("serviceworker", {
    predicate: tracker.isExtensionWorker,
    timeout: 10_000,
  });
  const cdpSession = await context.browser().newBrowserCDPSession();
  try {
    const loadResult = await cdpSession.send("Extensions.loadUnpacked", { path: extensionRoot });
    const worker = await observedStartup;
    tracker.trackWorker(worker);
    await tracker.finish();
    assert.equal(
      tracker.observedWorkerStartups(),
      1,
      "The extension worker startup was not observed after the listener barrier",
    );
    assert.match(loadResult.id, /^[a-p]{32}$/u, "Chromium returned an invalid extension ID");
    assert.equal(
      worker.url(),
      `chrome-extension://${loadResult.id}/${serviceWorkerScript}`,
      "The observed worker does not match the manifest background script",
    );
    assert.equal(
      new URL(worker.url()).hostname,
      loadResult.id,
      "The observed worker does not belong to the loaded package",
    );
    const healthResponse = await sendWorkerHealthRequest(context, loadResult.id);
    assert.equal(healthResponse?.ok, true, "The packaged worker did not handle its health request");
    assert.equal(
      healthResponse?.saved,
      false,
      "The worker health request changed the popup draft",
    );
    return { extensionId: loadResult.id, worker };
  } catch (error) {
    await observedStartup.catch(() => undefined);
    throw error;
  } finally {
    await cdpSession.detach().catch(() => undefined);
  }
}

async function assertServiceWorkerHealth(
  context,
  tracker,
  serviceWorkerScript,
  worker,
  expectedExtensionId,
) {
  const health = await worker.evaluate(() => {
    const manifest = globalThis.chrome.runtime.getManifest();
    return {
      runtimeId: globalThis.chrome.runtime.id,
      manifestVersion: manifest.manifest_version,
      serviceWorker: manifest.background?.service_worker,
      errorHooksInstalled: Boolean(
        globalThis[Symbol.for("lectureNotes.storeScreenshotErrorHooks")],
      ),
    };
  });
  assert.match(health.runtimeId, /^[a-p]{32}$/u, "The packaged extension ID is invalid");
  assert.equal(health.runtimeId, expectedExtensionId, "Worker ID does not match the loaded package");
  assert.equal(health.runtimeId, new URL(worker.url()).hostname, "Worker ID does not match its URL");
  assert.equal(health.manifestVersion, 3, "The packaged extension is not MV3");
  assert.equal(health.serviceWorker, serviceWorkerScript, "The packaged worker path is wrong");
  assert.equal(health.errorHooksInstalled, true, "Worker error listeners are missing");

  return health.runtimeId;
}

async function installDeterministicClock(context) {
  await context.addInitScript(({ initialTime }) => {
    const NativeDate = globalThis.Date;
    const clockKey = "__lectureNotesStoreScreenshotTime";
    globalThis[clockKey] = initialTime;

    function FixedDate(...args) {
      if (!new.target) {
        return new NativeDate(globalThis[clockKey]).toString();
      }
      return args.length === 0
        ? Reflect.construct(NativeDate, [globalThis[clockKey]], new.target)
        : Reflect.construct(NativeDate, args, new.target);
    }

    Object.setPrototypeOf(FixedDate, NativeDate);
    FixedDate.prototype = NativeDate.prototype;
    Object.defineProperty(FixedDate, "now", {
      configurable: true,
      value: () => globalThis[clockKey],
    });
    globalThis.Date = FixedDate;
  }, { initialTime: fixedClockStart });
}

async function setDeterministicTime(page, minutesAfterStart) {
  const timestamp = fixedClockStart + minutesAfterStart * 60_000;
  const observed = await page.evaluate((value) => {
    globalThis.__lectureNotesStoreScreenshotTime = value;
    return {
      dateNow: globalThis.Date.now(),
      iso: new globalThis.Date().toISOString(),
    };
  }, timestamp);
  assert.deepEqual(observed, {
    dateNow: timestamp,
    iso: new Date(timestamp).toISOString(),
  }, "The screenshot clock did not advance deterministically");
}

async function waitForStableCaptureState(page) {
  const deadline = Date.now() + 8_000;
  let previousSnapshot = null;
  let stableSamples = 0;

  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(() => {
      const main = globalThis.document.querySelector("#libraryMain");
      const storageText = globalThis.document.querySelector("#storageUsageText")?.textContent || "";
      const storageMeter = globalThis.document.querySelector("#storageUsageMeter");
      const status = globalThis.document.querySelector("#libraryStatus");
      return {
        ready: main?.getAttribute("aria-busy") === "false" &&
          storageText !== "" &&
          !storageText.includes("Calculating library size") &&
          !storageText.startsWith("At least "),
        storageText,
        storageValue: storageMeter?.getAttribute("value") || "",
        statusText: status?.textContent || "",
        statusKind: status?.dataset.kind || "",
        summary: globalThis.document.querySelector("#resultSummary")?.textContent || "",
      };
    });
    const serialized = JSON.stringify(snapshot);

    if (snapshot.ready && serialized === previousSnapshot) {
      stableSamples += 1;
      if (stableSamples >= 3) {
        return snapshot;
      }
    } else {
      stableSamples = 0;
      previousSnapshot = serialized;
    }
    await page.waitForTimeout(100);
  }

  assert.fail("The library storage measurement and status did not become stable");
}

async function createNote(page, note) {
  const previousCount = await page.locator(".note-card").count();
  await page.getByRole("button", { name: /New note/u }).click();
  await page.locator("#editorTitle").fill(note.title);
  await page.locator("#editorCourse").fill(note.course);
  await page.locator("#editorBody").fill(note.body);
  await page.locator("#editorForm").getByRole("button", { name: "Save note" }).click();
  await page.locator("#editorDialog").waitFor({ state: "hidden" });
  const card = page.locator(".note-card", { hasText: note.title });
  await card.waitFor();
  assert.equal(await page.locator(".note-card").count(), previousCount + 1);
}

async function captureScreenshot(page, directory, name) {
  assert.ok(screenshotNames.includes(name), `Unexpected screenshot name: ${name}`);
  assert.deepEqual(page.viewportSize(), {
    width: STORE_SCREENSHOT_WIDTH,
    height: STORE_SCREENSHOT_HEIGHT,
  });
  await waitForStableCaptureState(page);
  await page.evaluate(() => globalThis.document.fonts.ready);
  const path = join(directory, name);
  await page.screenshot({
    path,
    animations: "disabled",
    caret: "hide",
    type: "png",
  });
  const image = await readFile(path);
  assertStoreScreenshotDimensions(image, name);
  return path;
}

async function moveToTrash(page, title) {
  await page.getByRole("button", { name: `Move to Trash ${title}` }).click();
  await page.locator("#deleteForm").getByRole("button", { name: "Move to Trash" }).click();
  await page.locator("#deleteDialog").waitFor({ state: "hidden" });
  await page.locator("#undoBar").waitFor();
  await page.getByRole("button", { name: "Dismiss" }).click();
}

async function capturePackagedExtension(extensionRoot, outputDirectory) {
  const manifest = JSON.parse(await readFile(join(extensionRoot, "manifest.json"), "utf8"));
  const serviceWorkerScript = manifest.background?.service_worker;
  assert.equal(typeof serviceWorkerScript, "string", "The package has no service worker");

  const profile = assertTemporaryProfile(await mkdtemp(join(tmpdir(), profilePrefix)));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      ignoreDefaultArgs: ["--disable-extensions"],
      viewport: {
        width: STORE_SCREENSHOT_WIDTH,
        height: STORE_SCREENSHOT_HEIGHT,
      },
      deviceScaleFactor: 1,
      colorScheme: "light",
      locale: "en-US",
      reducedMotion: "reduce",
      timezoneId: "UTC",
      args: [
        "--disable-component-extensions-with-background-pages",
        "--enable-unsafe-extension-debugging",
      ],
    });
    await installDeterministicClock(context);
    const tracker = createErrorTracker(context, serviceWorkerScript);
    const observedStartup = await loadExtensionAfterTracking(
      context,
      tracker,
      extensionRoot,
      serviceWorkerScript,
    );
    const extensionId = await assertServiceWorkerHealth(
      context,
      tracker,
      serviceWorkerScript,
      observedStartup.worker,
      observedStartup.extensionId,
    );

    const library = await context.newPage();
    await library.goto(`chrome-extension://${extensionId}/notes.html`);
    await library.locator("#libraryMain[aria-busy='false']").waitFor();
    await library.locator("#themeSelect").selectOption("light");
    await library.locator('html[data-theme="light"]').waitFor();

    for (const [index, note] of sampleNotes.entries()) {
      await setDeterministicTime(library, index);
      await createNote(library, note);
    }
    assert.equal(await library.locator(".note-card").count(), sampleNotes.length);
    await library.evaluate(() => globalThis.scrollTo(0, 0));
    const screenshots = [
      await captureScreenshot(library, outputDirectory, "01-library-overview.png"),
    ];

    await library.locator("#notesList").evaluate((element) => {
      element.scrollIntoView({ block: "start" });
    });
    screenshots.push(
      await captureScreenshot(library, outputDirectory, "02-library-notes.png"),
    );

    const persianNote = sampleNotes.at(-1);
    await library.getByRole("button", { name: `Edit ${persianNote.title}` }).click();
    await library.locator("#editorDialog[open]").waitFor();
    assert.equal(await library.locator("#editorBody").inputValue(), persianNote.body);
    screenshots.push(
      await captureScreenshot(library, outputDirectory, "03-note-editor.png"),
    );
    await library.locator("#cancelEditorButton").click();
    await library.locator("#editorDialog").waitFor({ state: "hidden" });

    await setDeterministicTime(library, 60);
    await moveToTrash(library, "Primary Source Questions");
    await setDeterministicTime(library, 61);
    await moveToTrash(library, "Cellular Respiration");
    await library.getByRole("button", { name: "Trash, 2" }).click();
    await library.getByRole("heading", { name: "Primary Source Questions" }).waitFor();
    await library.locator(".library-view-switch").scrollIntoViewIfNeeded();
    screenshots.push(await captureScreenshot(library, outputDirectory, "04-trash.png"));

    await tracker.finish();
    assert.deepEqual(tracker.errors, [], "Browser or service worker errors occurred while capturing");
    await library.close();
    return screenshots;
  } finally {
    await context?.close().catch(() => undefined);
    assertTemporaryProfile(profile);
    await rm(profile, { recursive: true, force: true });
  }
}

export async function generateStoreScreenshots() {
  const release = buildExtensionPackage();
  const initialArchive = release.archive;
  const stagingDirectory = await createScreenshotStage();
  let published = false;

  try {
    const stagedScreenshots = await withExtractedStoredZip(
      initialArchive,
      (extensionRoot) => capturePackagedExtension(extensionRoot, stagingDirectory),
    );
    assert.deepEqual(
      stagedScreenshots.map((path) => basename(path)),
      screenshotNames,
      "The expected Store screenshots were not generated",
    );
    await validateScreenshotSet(stagingDirectory);

    const finalRelease = buildExtensionPackage();
    assert.deepEqual(
      finalRelease.archive,
      initialArchive,
      "Extension source changed while Store screenshots were being captured",
    );
    assert.equal(finalRelease.archiveName, release.archiveName);
    assert.equal(finalRelease.checksum, release.checksum);
    await writeVerifiedPackage(finalRelease);
    await publishScreenshotSet(stagingDirectory);
    published = true;

    const screenshots = screenshotNames.map((name) => join(screenshotDirectory, name));
    console.log(`Built ${release.archiveName} and captured ${screenshots.length} Store screenshots.`);
    for (const path of screenshots) {
      console.log(`${basename(path)}: ${STORE_SCREENSHOT_WIDTH}x${STORE_SCREENSHOT_HEIGHT}`);
    }
    return { release, screenshots };
  } finally {
    if (!published) {
      assertStoreAssetPath(stagingDirectory, screenshotStagePrefix);
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  await generateStoreScreenshots();
}
