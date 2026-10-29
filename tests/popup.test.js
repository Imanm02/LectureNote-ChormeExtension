import assert from "node:assert/strict";
import test from "node:test";

import { initPopup, openLibraryBesidePage } from "../src/popup.js";
import { createEmptyState } from "../src/model.js";
import {
  loadHelpSeen,
  enqueuePendingCapture,
  loadDraft,
  loadPendingCaptures,
  removePendingCapture,
  STORAGE_KEYS,
} from "../src/storage.js";
import { chromeMock, loadPage, memoryStorage, waitFor } from "./helpers.js";

const PENDING_NOW = "2026-10-29T12:00:00.000Z";

async function queueCapture(storage, {
  id = "capture-one",
  text = "Captured selection",
  title = "Captured lecture",
  url = "https://example.com/captured",
  wasTruncated = false,
} = {}) {
  return enqueuePendingCapture(
    { id, text, title, url, wasTruncated, createdAt: PENDING_NOW },
    storage,
    { lockManager: null, now: PENDING_NOW },
  );
}

function storedDraft() {
  return {
    version: 1,
    ownerSessionId: "draft-owner",
    generation: 4,
    contentGeneration: 7,
    draft: {
      sessionId: "draft-owner",
      noteId: null,
      baseRevision: 0,
      baseUpdatedAt: "",
      title: "Unfinished lecture",
      body: "Keep this unfinished note exactly",
      course: "CS 101",
      source: { title: "Original source", url: "https://example.com/original" },
      updatedAt: PENDING_NOW,
    },
  };
}

test("prefills the popup from the current selection", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage, {
      title: "Week 1 lecture",
      text: "تعریف گراف\nG = (V, E)",
      url: "https://example.com/lecture?token=secret",
    }),
  });

  assert.equal(dom.window.document.getElementById("titleInput").value, "Week 1 lecture");
  assert.equal(dom.window.document.getElementById("bodyInput").value, "تعریف گراف\nG = (V, E)");
  assert.equal(
    dom.window.document.getElementById("sourceLink").href,
    "https://example.com/lecture",
  );
  controller.destroy();
  dom.window.close();
});

test("saves a captured note without source details", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage, {
      title: "Private lecture",
      text: "Keep the note, not its location",
      url: "https://example.com/private?token=secret",
    }),
  });
  const sourcePrivacy = dom.window.document.getElementById("sourcePrivacyButton");

  sourcePrivacy.click();
  assert.equal(sourcePrivacy.textContent.trim(), "Restore source");
  assert.equal(dom.window.document.getElementById("sourceTitle").textContent, "Manual note");
  assert.equal(dom.window.document.getElementById("sourceLink").hidden, true);

  dom.window.document.getElementById("noteForm").requestSubmit();
  await waitFor(() => controller.getState().notes.length === 1);

  assert.deepEqual(controller.getState().notes[0].source, { title: "", url: "" });
  assert.match(dom.window.document.getElementById("status").textContent, /without a source/u);
  controller.destroy();
  dom.window.close();
});

test("restores a removed source before saving", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage, {
      title: "Restorable lecture",
      text: "Restore this source",
      url: "https://example.com/week?part=2&token=secret",
    }),
  });
  const sourcePrivacy = dom.window.document.getElementById("sourcePrivacyButton");

  sourcePrivacy.click();
  sourcePrivacy.click();
  assert.equal(sourcePrivacy.textContent.trim(), "Remove source");
  assert.equal(dom.window.document.getElementById("sourceTitle").textContent, "Restorable lecture");
  assert.equal(
    dom.window.document.getElementById("sourceLink").href,
    "https://example.com/week?part=2",
  );

  dom.window.document.getElementById("noteForm").requestSubmit();
  await waitFor(() => controller.getState().notes.length === 1);
  assert.deepEqual(controller.getState().notes[0].source, {
    title: "Restorable lecture",
    url: "https://example.com/week?part=2",
  });
  controller.destroy();
  dom.window.close();
});

test("persists source removal and restores from page context", async () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  const capture = {
    title: "Draft source",
    text: "Unfinished private note",
    url: "https://example.com/draft",
  };
  const firstDom = loadPage("popup.html");
  const firstController = await initPopup({
    documentValue: firstDom.window.document,
    chromeApi: chromeMock(storage, capture),
  });

  firstDom.window.document.getElementById("sourcePrivacyButton").click();
  await firstController.flushDraft();
  assert.deepEqual((await loadDraft(storage)).source, { title: "", url: "" });
  firstController.destroy();
  firstDom.window.close();

  const secondDom = loadPage("popup.html");
  const secondController = await initPopup({
    documentValue: secondDom.window.document,
    chromeApi: chromeMock(storage, capture),
  });
  const sourcePrivacy = secondDom.window.document.getElementById("sourcePrivacyButton");

  assert.equal(sourcePrivacy.textContent.trim(), "Restore source");
  sourcePrivacy.click();
  await secondController.flushDraft();
  assert.deepEqual((await loadDraft(storage)).source, {
    title: "Draft source",
    url: "https://example.com/draft",
  });
  secondController.destroy();
  secondDom.window.close();
});

test("restores a removed queued source after reopening", async () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  await queueCapture(storage, {
    text: "Queued private note",
    title: "Queued source",
    url: "https://example.com/queued",
  });
  const queuedBeforeOpen = structuredClone(await loadPendingCaptures(storage));
  const firstDom = loadPage("popup.html");
  const firstController = await initPopup({
    documentValue: firstDom.window.document,
    chromeApi: chromeMock(storage),
  });

  assert.deepEqual(await loadPendingCaptures(storage), queuedBeforeOpen);
  assert.equal(await loadDraft(storage), null);

  firstDom.window.document.getElementById("sourcePrivacyButton").click();
  await firstController.flushDraft();

  assert.deepEqual((await loadDraft(storage)).source, { title: "", url: "" });
  assert.equal((await loadDraft(storage)).body, "Queued private note");
  assert.deepEqual(await loadPendingCaptures(storage), queuedBeforeOpen);
  firstController.destroy();
  firstDom.window.close();

  const secondDom = loadPage("popup.html");
  const secondController = await initPopup({
    documentValue: secondDom.window.document,
    chromeApi: chromeMock(storage, {
      title: "Current page",
      text: "",
      url: "https://example.com/current",
    }),
  });
  const sourcePrivacy = secondDom.window.document.getElementById("sourcePrivacyButton");

  assert.equal(sourcePrivacy.textContent.trim(), "Restore source");
  sourcePrivacy.click();
  await secondController.flushDraft();

  assert.deepEqual((await loadDraft(storage)).source, {
    title: "Queued source",
    url: "https://example.com/queued",
  });
  assert.deepEqual(await loadPendingCaptures(storage), []);
  secondController.destroy();
  secondDom.window.close();
});

test("uses a queued capture after source removal", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.draft]: storedDraft(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  await queueCapture(storage, {
    text: "Replacement note",
    title: "Replacement source",
    url: "https://example.com/replacement",
  });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage),
  });
  const sourcePrivacy = dom.window.document.getElementById("sourcePrivacyButton");

  sourcePrivacy.click();
  dom.window.document.getElementById("useSelectionButton").click();
  await waitFor(() => storage.values[STORAGE_KEYS.pendingCaptures]?.captures.length === 0);

  assert.equal(dom.window.document.getElementById("sourceTitle").textContent, "Replacement source");
  assert.equal(sourcePrivacy.textContent.trim(), "Remove source");
  assert.deepEqual((await loadDraft(storage)).source, {
    title: "Replacement source",
    url: "https://example.com/replacement",
  });
  controller.destroy();
  dom.window.close();
});

test("resets source removal to the current capture", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage, {
      title: "Reset source",
      text: "Reset note",
      url: "https://example.com/reset",
    }),
    confirmDiscard: () => true,
  });
  const sourcePrivacy = dom.window.document.getElementById("sourcePrivacyButton");

  sourcePrivacy.click();
  dom.window.document.getElementById("discardButton").click();
  await waitFor(() => dom.window.document.getElementById("status").textContent.includes("reset"));

  assert.equal(sourcePrivacy.textContent.trim(), "Remove source");
  assert.equal(dom.window.document.getElementById("sourceTitle").textContent, "Reset source");
  assert.equal(dom.window.document.getElementById("sourceLink").href, "https://example.com/reset");
  controller.destroy();
  dom.window.close();
});

test("saves hostile page text as inert note content", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage, {
      title: "Security lecture",
      text: '<img src=x onerror="alert(1)"><script>alert(2)</script>',
    }),
  });
  const form = dom.window.document.getElementById("noteForm");
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

  await waitFor(() => controller.getState().notes.length === 1);
  const note = controller.getState().notes[0];
  assert.equal(note.body, '<img src=x onerror="alert(1)"><script>alert(2)</script>');
  assert.equal(dom.window.document.querySelectorAll("script").length, 1);
  assert.equal(dom.window.document.querySelector("img[src='x']"), null);
  controller.destroy();
  dom.window.close();
});

test("renders hostile source text inert after remove and restore", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  const hostileTitle = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage, {
      title: hostileTitle,
      text: "Safe body",
      url: "javascript:alert(3)",
    }),
  });
  const sourcePrivacy = dom.window.document.getElementById("sourcePrivacyButton");

  assert.equal(dom.window.document.getElementById("sourceTitle").textContent, hostileTitle);
  assert.equal(dom.window.document.getElementById("sourceTitle").children.length, 0);
  sourcePrivacy.click();
  sourcePrivacy.click();
  assert.equal(dom.window.document.getElementById("sourceTitle").textContent, hostileTitle);
  assert.equal(dom.window.document.getElementById("sourceTitle").children.length, 0);
  assert.equal(dom.window.document.getElementById("sourceLink").hidden, true);
  controller.destroy();
  dom.window.close();
});

test("restores an unfinished draft without overwriting it", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.draft]: {
      noteId: null,
      baseRevision: 0,
      baseUpdatedAt: "",
      title: "Recovered",
      body: "Unfinished note",
      course: "CS 101",
      source: { title: "Old page", url: "https://example.com/old" },
      updatedAt: "2026-09-20T10:00:00.000Z",
    },
  });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage, { title: "New page", text: "New selection" }),
  });

  assert.equal(dom.window.document.getElementById("bodyInput").value, "Unfinished note");
  assert.equal(dom.window.document.getElementById("useSelectionButton").hidden, false);
  dom.window.document.getElementById("useSelectionButton").click();
  assert.equal(dom.window.document.getElementById("bodyInput").value, "New selection");
  await controller.flushDraft();
  assert.equal((await loadDraft(storage)).body, "New selection");
  controller.destroy();
  dom.window.close();
});

test("keeps an existing draft unchanged until a captured selection is used", async () => {
  const dom = loadPage("popup.html");
  const draftRecord = storedDraft();
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.draft]: draftRecord,
    [STORAGE_KEYS.helpSeen]: true,
  });
  await queueCapture(storage, { text: "New context-menu selection" });
  const before = structuredClone(storage.values[STORAGE_KEYS.draft]);
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage),
  });
  const useSelection = dom.window.document.getElementById("useSelectionButton");

  assert.equal(
    dom.window.document.getElementById("bodyInput").value,
    "Keep this unfinished note exactly",
  );
  assert.equal(useSelection.textContent.trim(), "Use captured selection");
  assert.equal(useSelection.hidden, false);
  assert.deepEqual(storage.values[STORAGE_KEYS.draft], before);

  useSelection.click();
  await waitFor(
    () => storage.values[STORAGE_KEYS.pendingCaptures]?.captures.length === 0,
  );

  assert.equal(dom.window.document.getElementById("bodyInput").value, "New context-menu selection");
  assert.equal((await loadDraft(storage)).body, "New context-menu selection");
  controller.destroy();
  dom.window.close();
});

test("keeps an unedited pending capture across popup close and reopen", async () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  await queueCapture(storage, { text: "Keep me across popup sessions" });

  const firstDom = loadPage("popup.html");
  const firstController = await initPopup({
    documentValue: firstDom.window.document,
    chromeApi: chromeMock(storage),
  });
  assert.equal(
    firstDom.window.document.getElementById("bodyInput").value,
    "Keep me across popup sessions",
  );
  firstController.destroy();
  firstDom.window.close();

  assert.equal(await loadDraft(storage), null);
  assert.equal((await loadPendingCaptures(storage))[0].text, "Keep me across popup sessions");

  const secondDom = loadPage("popup.html");
  const secondController = await initPopup({
    documentValue: secondDom.window.document,
    chromeApi: chromeMock(storage),
  });
  assert.equal(
    secondDom.window.document.getElementById("bodyInput").value,
    "Keep me across popup sessions",
  );
  assert.equal((await loadPendingCaptures(storage)).length, 1);
  secondController.destroy();
  secondDom.window.close();
});

test("keeps a capture queued when replacement draft persistence fails", async () => {
  const dom = loadPage("popup.html");
  const draftRecord = storedDraft();
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.draft]: draftRecord,
    [STORAGE_KEYS.helpSeen]: true,
  });
  await queueCapture(storage, { text: "Do not lose this capture" });
  const before = structuredClone(storage.values[STORAGE_KEYS.draft]);
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage),
  });
  const originalSet = storage.set.bind(storage);
  storage.set = async (update) => {
    if (STORAGE_KEYS.draft in update) {
      throw new Error("Draft storage failed");
    }
    await originalSet(update);
  };

  dom.window.document.getElementById("useSelectionButton").click();
  await waitFor(
    () => dom.window.document.getElementById("status").textContent.includes("Draft not saved"),
  );

  assert.deepEqual(storage.values[STORAGE_KEYS.draft], before);
  assert.equal((await loadPendingCaptures(storage))[0].text, "Do not lose this capture");
  assert.equal(dom.window.document.getElementById("bodyInput").value, "Do not lose this capture");
  controller.destroy();
  dom.window.close();
});

test("keeps a capture queued when removal after draft persistence fails", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.draft]: storedDraft(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  await queueCapture(storage, { text: "Retry queue cleanup" });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage),
  });
  const originalSet = storage.set.bind(storage);
  storage.set = async (update) => {
    if (STORAGE_KEYS.pendingCaptures in update) {
      throw new Error("Queue storage failed");
    }
    await originalSet(update);
  };

  dom.window.document.getElementById("useSelectionButton").click();
  await waitFor(
    () => dom.window.document.getElementById("status").textContent.includes("remains queued"),
  );

  assert.equal((await loadDraft(storage)).body, "Retry queue cleanup");
  assert.equal((await loadPendingCaptures(storage))[0].text, "Retry queue cleanup");
  controller.destroy();
  dom.window.close();
});

test("shows truncation details for a pending capture", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  await queueCapture(storage, { text: "Limited selection", wasTruncated: true });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage),
  });

  assert.equal(dom.window.document.getElementById("status").dataset.kind, "warning");
  assert.match(dom.window.document.getElementById("status").textContent, /limited to 100,000/u);
  assert.equal((await loadPendingCaptures(storage))[0].wasTruncated, true);
  controller.destroy();
  dom.window.close();
});

test("discards pending captures one at a time in FIFO order", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  await queueCapture(storage, { id: "capture-first", text: "First pending selection" });
  await queueCapture(storage, { id: "capture-second", text: "Second pending selection" });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage),
    confirmDiscard: () => true,
  });
  const discardSelection = dom.window.document.getElementById("discardSelectionButton");

  assert.equal(dom.window.document.getElementById("bodyInput").value, "First pending selection");
  discardSelection.click();
  await waitFor(
    () => storage.values[STORAGE_KEYS.pendingCaptures]?.captures[0]?.id === "capture-second",
  );

  assert.equal(dom.window.document.getElementById("bodyInput").value, "Second pending selection");
  assert.deepEqual(
    (await loadPendingCaptures(storage)).map((capture) => capture.id),
    ["capture-second"],
  );
  controller.destroy();
  dom.window.close();
});

test("does not erase the form when a pending capture is removed elsewhere", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  await queueCapture(storage, { text: "Visible pending selection" });
  const chromeApi = chromeMock(storage);
  const controller = await initPopup({ documentValue: dom.window.document, chromeApi });
  const visibleBody = dom.window.document.getElementById("bodyInput").value;

  await removePendingCapture("capture-one", storage, { lockManager: null });
  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.pendingCaptures]: {
      oldValue: { version: 1, captures: [{ id: "capture-one" }] },
      newValue: { version: 1, captures: [] },
    },
  });

  assert.equal(dom.window.document.getElementById("bodyInput").value, visibleBody);
  assert.equal(visibleBody, "Visible pending selection");
  controller.destroy();
  dom.window.close();
});

test("removes a pending capture after its note is saved", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  await queueCapture(storage, { text: "Save this pending selection" });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage),
  });

  dom.window.document.getElementById("noteForm").requestSubmit();
  await waitFor(() => controller.getState().notes.length === 1);
  await waitFor(
    () => storage.values[STORAGE_KEYS.pendingCaptures]?.captures.length === 0,
  );

  assert.equal(controller.getState().notes[0].body, "Save this pending selection");
  assert.deepEqual(await loadPendingCaptures(storage), []);
  controller.destroy();
  dom.window.close();
});

test("shows first-use help once and keeps Help available", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage),
  });
  const panel = dom.window.document.getElementById("helpPanel");
  const helpButton = dom.window.document.getElementById("helpButton");

  assert.equal(panel.hidden, false);
  assert.equal(helpButton.getAttribute("aria-expanded"), "true");
  assert.equal(await loadHelpSeen(storage), true);

  dom.window.document.getElementById("closeHelpButton").click();
  assert.equal(panel.hidden, true);
  helpButton.click();
  assert.equal(panel.hidden, false);

  controller.destroy();
  dom.window.close();
});

test("keeps first-use help closed after it has been seen", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage),
  });

  assert.equal(dom.window.document.getElementById("helpPanel").hidden, true);
  assert.equal(dom.window.document.getElementById("helpButton").getAttribute("aria-expanded"), "false");

  controller.destroy();
  dom.window.close();
});

test("opens the library in Chrome's side panel from a user action", async () => {
  const calls = [];
  const result = await openLibraryBesidePage({
    runtime: { getURL: (path) => `chrome-extension://test/${path}` },
    windows: { WINDOW_ID_CURRENT: -2 },
    sidePanel: {
      async open(options) {
        calls.push(options);
      },
    },
  });

  assert.deepEqual(result, { opened: "side-panel" });
  assert.deepEqual(calls, [{ windowId: -2 }]);
});

test("falls back to a library tab when side-panel opening fails", async () => {
  const createdTabs = [];
  const panelError = new Error("Side panel blocked");
  const result = await openLibraryBesidePage({
    runtime: { getURL: (path) => `chrome-extension://test/${path}` },
    sidePanel: {
      async open() {
        throw panelError;
      },
    },
    tabs: {
      async create(options) {
        createdTabs.push(options);
      },
    },
  });

  assert.equal(result.opened, "tab");
  assert.equal(result.panelError, panelError);
  assert.deepEqual(createdTabs, [{ url: "chrome-extension://test/notes.html" }]);
});

test("opens a library tab when the side-panel API is missing", async () => {
  const createdTabs = [];
  const result = await openLibraryBesidePage({
    tabs: {
      async create(options) {
        createdTabs.push(options);
      },
    },
  });

  assert.deepEqual(result, { opened: "tab", panelError: null });
  assert.deepEqual(createdTabs, [{ url: "notes.html" }]);
});

test("reports library surface failures", async () => {
  await assert.rejects(
    () =>
      openLibraryBesidePage({
        sidePanel: {
          async open() {
            throw new Error("Panel failed");
          },
        },
        tabs: {
          async create() {
            throw new Error("Tab failed");
          },
        },
      }),
    /Panel failed Tab failed/u,
  );

  await assert.rejects(
    () => openLibraryBesidePage({}),
    /library could not be opened/u,
  );
});

test("explains when the side-panel button uses its tab fallback", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  const chromeApi = chromeMock(storage);
  const createdTabs = [];
  chromeApi.runtime = { getURL: (path) => `chrome-extension://test/${path}` };
  chromeApi.sidePanel = {
    async open() {
      throw new Error("The panel was blocked");
    },
  };
  chromeApi.tabs.create = async (options) => createdTabs.push(options);
  const controller = await initPopup({ documentValue: dom.window.document, chromeApi });

  dom.window.document.getElementById("openSidePanelButton").click();
  await waitFor(() => dom.window.document.getElementById("status").dataset.kind === "warning");

  assert.match(dom.window.document.getElementById("status").textContent, /Opened the library in a tab/u);
  assert.deepEqual(createdTabs, [{ url: "chrome-extension://test/notes.html" }]);

  controller.destroy();
  dom.window.close();
});

test("shows an error when the side-panel button cannot open the library", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  const chromeApi = chromeMock(storage);
  chromeApi.runtime = { getURL: (path) => `chrome-extension://test/${path}` };
  chromeApi.sidePanel = {
    async open() {
      throw new Error("Panel failed");
    },
  };
  chromeApi.tabs.create = async () => {
    throw new Error("Tab failed");
  };
  const controller = await initPopup({ documentValue: dom.window.document, chromeApi });

  dom.window.document.getElementById("openSidePanelButton").click();
  await waitFor(() => dom.window.document.getElementById("status").dataset.kind === "error");

  assert.match(dom.window.document.getElementById("status").textContent, /Panel failed Tab failed/u);
  assert.equal(dom.window.document.getElementById("openSidePanelButton").disabled, false);

  controller.destroy();
  dom.window.close();
});
