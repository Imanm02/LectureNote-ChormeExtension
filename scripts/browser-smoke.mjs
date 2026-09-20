import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { readPageSelection } from "../src/capture.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const screenshotDirectory = process.env.LECTURE_NOTES_SCREENSHOTS
  ? resolve(root, process.env.LECTURE_NOTES_SCREENSHOTS)
  : null;
if (screenshotDirectory) {
  const allowedScreenshotRoot = resolve(root, "test-results");
  assert.ok(
    screenshotDirectory === allowedScreenshotRoot ||
      screenshotDirectory.startsWith(`${allowedScreenshotRoot}${sep}`),
    "Screenshots must stay under test-results",
  );
  await mkdir(screenshotDirectory, { recursive: true });
}
const temporaryRoot = resolve(tmpdir());
const profile = await mkdtemp(join(temporaryRoot, "lecture-notes-smoke-"));
const browserErrors = [];

function trackPage(page) {
  page.on("pageerror", (error) => browserErrors.push(`${page.url()}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(`${page.url()}: ${message.text()}`);
    }
  });
}

async function launch() {
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  context.on("page", trackPage);
  for (const page of context.pages()) {
    trackPage(page);
  }
  return context;
}

async function extensionId(context) {
  const page = await context.newPage();
  await page.goto("chrome://extensions/");
  const identifier = await page.waitForFunction(() => {
    const manager = globalThis.document.querySelector("extensions-manager");
    const list = manager?.shadowRoot?.querySelector("extensions-item-list");
    const items = [...(list?.shadowRoot?.querySelectorAll("extensions-item") || [])];
    const item = items.find((candidate) =>
      candidate.shadowRoot?.querySelector("#name")?.textContent?.includes("Lecture Notes"),
    );
    return item?.getAttribute("id") || item?.id || null;
  });
  const value = await identifier.jsonValue();
  await page.close();
  assert.match(value, /^[a-p]{32}$/u, "The unpacked extension ID was not found");
  return value;
}

async function createPersianNote(page) {
  await page.getByRole("button", { name: "New note" }).click();
  await page.locator("#editorTitle").fill("ماتریس");
  await page.locator("#editorCourse").fill("ریاضی");
  await page.locator("#editorBody").fill("مقادیر ویژه و بردارهای ویژه");
  await page.locator("#editorForm").getByRole("button", { name: "Save note" }).click();
  await page.locator("#libraryStatus").filter({ hasText: "Note saved." }).waitFor();
}

let context;
let shortcutCaptureVerified = false;
try {
  context = await launch();
  const identifier = await extensionId(context);
  const popupUrl = `chrome-extension://${identifier}/popup.html`;
  const notesUrl = `chrome-extension://${identifier}/notes.html`;

  const sourcePage = await context.newPage();
  await sourcePage.goto("https://example.com/");
  await sourcePage.locator("h1").selectText();
  const headingCapture = await sourcePage.evaluate(readPageSelection, 100_000);
  assert.equal(headingCapture.text, "Example Domain");
  await sourcePage.evaluate(() => {
    const input = globalThis.document.createElement("input");
    input.id = "passwordCheck";
    input.type = "password";
    input.value = "private-password";
    globalThis.document.body.append(input);
  });
  await sourcePage.locator("#passwordCheck").selectText();
  const passwordCapture = await sourcePage.evaluate(readPageSelection, 100_000);
  assert.equal(passwordCapture.text, "");
  await sourcePage.locator("h1").selectText();
  const actionPopupPromise = context.waitForEvent("page", { timeout: 3_000 }).catch(() => null);
  await sourcePage.keyboard.press("Control+Shift+Y");
  const actionPopup = await actionPopupPromise;
  if (actionPopup) {
    await actionPopup.waitForLoadState();
    assert.equal(await actionPopup.locator("#bodyInput").inputValue(), "Example Domain");
    shortcutCaptureVerified = true;
    await actionPopup.close();
  }
  await sourcePage.close();

  const draftPopup = await context.newPage();
  await draftPopup.goto(popupUrl);
  await draftPopup.locator("#noteForm[aria-busy='false']").waitFor();
  assert.equal(
    await draftPopup.evaluate(() => globalThis.document.activeElement?.id),
    "bodyInput",
  );
  await draftPopup.locator("#bodyInput").fill("Graph theory studies vertices and edges.");
  await draftPopup.close();

  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await popup.locator("#noteForm[aria-busy='false']").waitFor();
  await popup.locator("#status").filter({ hasText: "Recovered an unfinished draft." }).waitFor();
  assert.equal(await popup.evaluate(() => globalThis.document.activeElement?.id), "titleInput");
  assert.equal(
    await popup.locator("#bodyInput").inputValue(),
    "Graph theory studies vertices and edges.",
  );
  await popup.locator("#titleInput").fill("Graph basics");
  await popup.locator("#courseInput").fill("CS 101");
  if (screenshotDirectory) {
    await popup.screenshot({ path: join(screenshotDirectory, "popup.png"), fullPage: true });
  }
  await popup.getByRole("button", { name: "Save note", exact: true }).click();
  try {
    await popup.locator("#status").filter({ hasText: "Note saved." }).waitFor();
  } catch (error) {
    console.error("Popup status:", await popup.locator("#status").textContent());
    console.error("Browser errors:", browserErrors);
    throw error;
  }
  assert.equal(await popup.evaluate(() => globalThis.document.activeElement?.id), "bodyInput");
  await popup.close();
  const backgroundWorker = context
    .serviceWorkers()
    .find((worker) => worker.url().endsWith("/src/background.js"));
  assert.ok(backgroundWorker, "The draft handoff worker did not start");
  assert.equal(
    await backgroundWorker.evaluate(() => globalThis.chrome.runtime.id),
    identifier,
  );
  await context.close();

  context = await launch();
  const restartedIdentifier = await extensionId(context);
  assert.equal(restartedIdentifier, identifier, "The extension ID changed after restart");
  const library = await context.newPage();
  await library.goto(notesUrl);
  await library.getByRole("heading", { name: "Graph basics" }).waitFor();
  assert.equal(await library.locator(".note-card").count(), 1);

  await createPersianNote(library);
  await library.locator("#searchInput").fill("ویژه");
  await library.getByRole("heading", { name: "ماتریس" }).waitFor();
  await library.locator(".note-card").nth(1).waitFor({ state: "detached" });
  assert.equal(await library.locator(".note-card").count(), 1);
  await library.locator("#searchInput").fill("");
  await library.getByRole("heading", { name: "Graph basics" }).waitFor();
  await library.locator(".note-card").nth(1).waitFor();

  const graphCard = library.locator(".note-card", { hasText: "Graph basics" });
  await graphCard.getByRole("button", { name: "Edit" }).click();
  await library.locator("#editorBody").fill("Edited graph theory note.");
  await library.locator("#editorForm").getByRole("button", { name: "Save note" }).click();
  await graphCard.getByText("Edited graph theory note.").waitFor();
  if (screenshotDirectory) {
    await library.screenshot({ path: join(screenshotDirectory, "library-light.png"), fullPage: true });
  }

  const downloadPromise = library.waitForEvent("download");
  await library.getByRole("button", { name: "Export backup" }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^lecture-notes-\d{4}-\d{2}-\d{2}\.json$/u);
  const backupPath = join(profile, "backup.json");
  await download.saveAs(backupPath);

  await library.getByRole("button", { name: "Restore backup" }).click();
  await library.locator("#importFileInput").setInputFiles(backupPath);
  await library.getByRole("heading", { name: "Choose how to restore" }).waitFor();
  await library.getByRole("button", { name: "Merge notes" }).click();
  await library.locator("#libraryStatus").filter({ hasText: "Restored 0 notes. Skipped 2 duplicates." }).waitFor();

  await library.locator("#themeSelect").selectOption("dark");
  await library.locator('html[data-theme="dark"]').waitFor();
  if (screenshotDirectory) {
    await library.screenshot({ path: join(screenshotDirectory, "library-dark.png"), fullPage: true });
  }

  await graphCard.getByRole("button", { name: "Delete" }).click();
  await library.getByRole("button", { name: "Delete note" }).click();
  await library.locator("#undoBar").waitFor();
  assert.equal(await library.locator(".note-card").count(), 1);
  await library.getByRole("button", { name: "Undo" }).click();
  await library.getByRole("heading", { name: "Graph basics" }).waitFor();
  assert.equal(await library.locator(".note-card").count(), 2);

  assert.deepEqual(browserErrors, []);
  const shortcutResult = shortcutCaptureVerified
    ? " Action shortcut capture also passed."
    : " Headless Chromium did not expose the action popup.";
  console.log(`Browser smoke test passed: real selection handling, popup drafts, persistence, CRUD, search, backup, theme, and undo.${shortcutResult}`);
} finally {
  await context?.close().catch(() => undefined);
  const resolvedProfile = resolve(profile);
  const allowedPrefix = `${temporaryRoot}${sep}`;
  if (
    resolvedProfile.startsWith(allowedPrefix) &&
    basename(resolvedProfile).startsWith("lecture-notes-smoke-")
  ) {
    await rm(resolvedProfile, { recursive: true, force: true });
  }
}
