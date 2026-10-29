import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTURE_CONTEXT_MENU_ID,
  captureContextSelection,
  ensureCaptureContextMenu,
  handleContextMenuClick,
  handleDraftMessage,
  isAuthorizedDraftMessage,
  normalizeContextSelection,
  openCaptureSurface,
  syncCaptureContextMenu,
} from "../src/background.js";
import { MESSAGE_TYPES } from "../src/messages.js";
import { LIMITS } from "../src/model.js";
import {
  loadDraft,
  loadDataEpoch,
  loadEditorDraft,
  loadPendingCaptures,
  resetAllData,
  STORAGE_KEYS,
} from "../src/storage.js";
import { memoryStorage as createMemoryStorage } from "./helpers.js";

const RUNTIME_ID = "abcdefghijklmnopabcdefghijklmnop";
const DATA_EPOCH = "background-test-epoch";

function memoryStorage(initial = {}) {
  const epoch = initial[STORAGE_KEYS.dataEpoch] || DATA_EPOCH;
  return createMemoryStorage({
    ...initial,
    [STORAGE_KEYS.dataEpoch]: epoch,
    [STORAGE_KEYS.dataConsent]: {
      version: 1,
      epoch,
      accepted: true,
    },
  });
}

test("stores a draft handed off by an extension page", async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.dataEpoch]: DATA_EPOCH });
  const message = {
    type: MESSAGE_TYPES.saveDraft,
    sessionId: "popup-session",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    contentGeneration: 1,
    expectedEpoch: DATA_EPOCH,
    draft: { body: "Keep this popup draft", sessionId: "popup-session" },
  };

  assert.equal(isAuthorizedDraftMessage(message, { id: RUNTIME_ID }, RUNTIME_ID), true);
  assert.deepEqual(
    await handleDraftMessage(message, { id: RUNTIME_ID }, storage, RUNTIME_ID),
    {
      handled: true,
      saved: true,
      cursor: {
        ownerSessionId: "popup-session",
        generation: 1,
        contentGeneration: 1,
        hasDraft: true,
      },
    },
  );
  assert.equal((await loadDraft(storage)).body, "Keep this popup draft");
});

test("ignores messages from outside the extension", async () => {
  const storage = memoryStorage();
  const result = await handleDraftMessage(
    { type: MESSAGE_TYPES.saveDraft, draft: { body: "Do not save" } },
    { id: "another-extension" },
    storage,
    RUNTIME_ID,
  );

  assert.deepEqual(result, { handled: false });
  assert.equal(await loadDraft(storage), null);
});

test("rejects internal draft messages without a valid data epoch", async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.dataEpoch]: DATA_EPOCH });
  const baseMessage = {
    type: MESSAGE_TYPES.saveDraft,
    sessionId: "popup-session",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    contentGeneration: 1,
    draft: { body: "Do not save", sessionId: "popup-session" },
  };

  assert.equal(
    isAuthorizedDraftMessage(baseMessage, { id: RUNTIME_ID }, RUNTIME_ID),
    false,
  );
  assert.equal(
    isAuthorizedDraftMessage(
      { ...baseMessage, expectedEpoch: "invalid epoch" },
      { id: RUNTIME_ID },
      RUNTIME_ID,
    ),
    false,
  );
  assert.deepEqual(
    await handleDraftMessage(baseMessage, { id: RUNTIME_ID }, storage, RUNTIME_ID),
    { handled: false },
  );
  assert.equal(await loadDraft(storage), null);
});

test("rejects an oversized handed-off draft", async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.dataEpoch]: DATA_EPOCH });

  await assert.rejects(
    () =>
      handleDraftMessage(
        {
          type: MESSAGE_TYPES.saveDraft,
          sessionId: "popup-session",
          expectedOwnerSessionId: "",
          expectedGeneration: 0,
          contentGeneration: 1,
          expectedEpoch: DATA_EPOCH,
          draft: { body: "x".repeat(LIMITS.body + 1), sessionId: "popup-session" },
        },
        { id: RUNTIME_ID },
        storage,
        RUNTIME_ID,
      ),
    { code: "note-text-length" },
  );
  assert.equal(await loadDraft(storage), null);
});

test("does not let a stale popup handoff replace another popup's draft", async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.dataEpoch]: DATA_EPOCH });
  const first = await handleDraftMessage(
    {
      type: MESSAGE_TYPES.saveDraft,
      sessionId: "popup-one",
      expectedOwnerSessionId: "",
      expectedGeneration: 0,
      contentGeneration: 1,
      expectedEpoch: DATA_EPOCH,
      draft: { body: "Keep this draft", sessionId: "popup-one" },
    },
    { id: RUNTIME_ID },
    storage,
    RUNTIME_ID,
  );
  const stale = await handleDraftMessage(
    {
      type: MESSAGE_TYPES.saveDraft,
      sessionId: "popup-two",
      expectedOwnerSessionId: "",
      expectedGeneration: 0,
      contentGeneration: 1,
      expectedEpoch: DATA_EPOCH,
      draft: { body: "Do not overwrite", sessionId: "popup-two" },
    },
    { id: RUNTIME_ID },
    storage,
    RUNTIME_ID,
  );

  assert.equal(first.saved, true);
  assert.equal(stale.saved, false);
  assert.deepEqual(stale.cursor, {
    ownerSessionId: "popup-one",
    generation: 1,
    contentGeneration: 1,
    hasDraft: true,
  });
  assert.equal((await loadDraft(storage)).body, "Keep this draft");
});

test("stores editor drafts without replacing popup drafts", async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.dataEpoch]: DATA_EPOCH });
  await handleDraftMessage(
    {
      type: MESSAGE_TYPES.saveDraft,
      sessionId: "popup-session",
      expectedOwnerSessionId: "",
      expectedGeneration: 0,
      contentGeneration: 1,
      expectedEpoch: DATA_EPOCH,
      draft: { body: "Popup draft", sessionId: "popup-session" },
    },
    { id: RUNTIME_ID },
    storage,
    RUNTIME_ID,
  );
  const message = {
    type: MESSAGE_TYPES.saveEditorDraft,
    sessionId: "editor-session",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    contentGeneration: 1,
    expectedEpoch: DATA_EPOCH,
    draft: { title: "Editor", body: "Editor draft", source: { url: "https://" } },
  };

  assert.deepEqual(
    await handleDraftMessage(message, { id: RUNTIME_ID }, storage, RUNTIME_ID),
    {
      handled: true,
      saved: true,
      cursor: {
        ownerSessionId: "editor-session",
        generation: 1,
        contentGeneration: 1,
        hasDraft: true,
      },
    },
  );
  assert.equal((await loadDraft(storage)).body, "Popup draft");
  assert.equal((await loadEditorDraft(storage)).draft.body, "Editor draft");

  const stale = await handleDraftMessage(
    { ...message, sessionId: "other-editor", draft: { body: "Do not replace" } },
    { id: RUNTIME_ID },
    storage,
    RUNTIME_ID,
  );
  assert.deepEqual(stale, {
    handled: true,
    saved: false,
    cursor: {
      ownerSessionId: "editor-session",
      generation: 1,
      contentGeneration: 1,
      hasDraft: true,
    },
  });
  assert.equal((await loadEditorDraft(storage)).draft.body, "Editor draft");
});

test("rejects a draft handoff from before a data reset", async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.dataEpoch]: DATA_EPOCH });
  const expectedEpoch = await loadDataEpoch(storage, { lockManager: null });
  await resetAllData(storage, {
    lockManager: null,
    epochFactory: () => "background-new-epoch",
  });
  const message = {
    type: MESSAGE_TYPES.saveDraft,
    sessionId: "stale-popup",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    contentGeneration: 1,
    expectedEpoch,
    draft: { body: "Do not restore this draft", sessionId: "stale-popup" },
  };

  assert.equal(isAuthorizedDraftMessage(message, { id: RUNTIME_ID }, RUNTIME_ID), true);
  await assert.rejects(
    () => handleDraftMessage(message, { id: RUNTIME_ID }, storage, RUNTIME_ID),
    { code: "data-reset" },
  );
  assert.equal(await loadDraft(storage), null);
});

test("rejects draft handoff before consent without creating storage", async () => {
  const storage = createMemoryStorage({ [STORAGE_KEYS.dataEpoch]: DATA_EPOCH });
  const before = structuredClone(storage.values);

  await assert.rejects(
    () => handleDraftMessage(
      {
        type: MESSAGE_TYPES.saveDraft,
        sessionId: "unaccepted-popup",
        expectedOwnerSessionId: "",
        expectedGeneration: 0,
        contentGeneration: 1,
        expectedEpoch: DATA_EPOCH,
        draft: { body: "Do not handle this draft", sessionId: "unaccepted-popup" },
      },
      { id: RUNTIME_ID },
      storage,
      RUNTIME_ID,
    ),
    { code: "consent-required" },
  );

  assert.deepEqual(storage.values, before);
});

test("rejects unknown internal message types", async () => {
  const storage = memoryStorage();
  const message = { type: "save-anywhere", draft: { body: "Do not save" } };

  assert.equal(isAuthorizedDraftMessage(message, { id: RUNTIME_ID }, RUNTIME_ID), false);
  assert.deepEqual(
    await handleDraftMessage(message, { id: RUNTIME_ID }, storage, RUNTIME_ID),
    { handled: false },
  );
});

test("recreates only the selection menu and serializes registrations", async () => {
  const calls = [];
  let activeOperations = 0;
  let maximumActiveOperations = 0;
  const contextMenus = {
    async remove(identifier) {
      activeOperations += 1;
      maximumActiveOperations = Math.max(maximumActiveOperations, activeOperations);
      calls.push(["remove", identifier]);
      await Promise.resolve();
      activeOperations -= 1;
    },
    async create(options) {
      activeOperations += 1;
      maximumActiveOperations = Math.max(maximumActiveOperations, activeOperations);
      calls.push(["create", options]);
      await Promise.resolve();
      activeOperations -= 1;
    },
  };

  await Promise.all([
    ensureCaptureContextMenu(contextMenus, {}),
    ensureCaptureContextMenu(contextMenus, {}),
  ]);

  assert.deepEqual(calls, [
    ["remove", CAPTURE_CONTEXT_MENU_ID],
    [
      "create",
      {
        id: CAPTURE_CONTEXT_MENU_ID,
        title: "Capture selection in Lecture Notes",
        contexts: ["selection"],
      },
    ],
    ["remove", CAPTURE_CONTEXT_MENU_ID],
    [
      "create",
      {
        id: CAPTURE_CONTEXT_MENU_ID,
        title: "Capture selection in Lecture Notes",
        contexts: ["selection"],
      },
    ],
  ]);
  assert.equal(maximumActiveOperations, 1);
});

test("reports context-menu registration failures", async () => {
  const runtime = {};
  let createdAfterMissingRemoval = false;
  await ensureCaptureContextMenu(
    {
      remove(_identifier, callback) {
        runtime.lastError = { message: "Cannot find menu item with this ID" };
        callback();
        delete runtime.lastError;
      },
      create(_options, callback) {
        createdAfterMissingRemoval = true;
        callback();
      },
    },
    runtime,
  );
  assert.equal(createdAfterMissingRemoval, true);

  await assert.rejects(
    () =>
      ensureCaptureContextMenu(
        {
          remove(_identifier, callback) {
            runtime.lastError = { message: "Menu removal failed" };
            callback();
            delete runtime.lastError;
          },
        },
        runtime,
      ),
    /Menu removal failed/u,
  );

  await assert.rejects(
    () =>
      ensureCaptureContextMenu(
        {
          remove() {
            return Promise.resolve();
          },
          create() {
            return Promise.reject(new Error("Menu creation failed"));
          },
        },
        {},
      ),
    /Menu creation failed/u,
  );

  await assert.rejects(
    () =>
      ensureCaptureContextMenu(
        {
          remove() {
            throw new Error("Menu API unavailable");
          },
        },
        {},
      ),
    /Menu API unavailable/u,
  );
});

test("normalizes selected text without splitting Unicode", () => {
  assert.deepEqual(normalizeContextSelection("\u202e line one\r\nline two\u{10348} ", 18), {
    text: "line one\nline two",
    wasTruncated: true,
  });
  assert.deepEqual(normalizeContextSelection("a\u{10348}", 2), {
    text: "a",
    wasTruncated: true,
  });
  assert.deepEqual(normalizeContextSelection(null), {
    text: "",
    wasTruncated: false,
  });
});

test("queues a normalized context-menu capture", async () => {
  const storage = memoryStorage();
  const result = await captureContextSelection(
    {
      selectionText: "  تعریف گراف\r\nG = (V, E)  ",
      pageUrl: "https://example.com/lecture?token=secret&week=2#section",
    },
    { title: "T".repeat(LIMITS.sourceTitle + 20) },
    storage,
    () => "context-menu-test",
  );

  assert.equal(result.saved, true);
  assert.equal(result.reason, "queued");
  assert.equal(result.queueLength, 1);
  assert.equal(result.capture.id, "context-menu-test");
  assert.equal(result.capture.text, "تعریف گراف\nG = (V, E)");
  assert.equal(result.capture.title.length, LIMITS.title);
  assert.equal(result.capture.url, "https://example.com/lecture?week=2");
  assert.deepEqual(await loadPendingCaptures(storage), [result.capture]);
});

test("does not inspect context-menu data before consent", async () => {
  const storage = createMemoryStorage({
    [STORAGE_KEYS.state]: { private: "existing notes" },
  });
  const before = structuredClone(storage.values);
  let selectionRead = false;
  let titleRead = false;
  const info = {};
  Object.defineProperty(info, "selectionText", {
    get() {
      selectionRead = true;
      return "Private selection";
    },
  });
  const tab = {};
  Object.defineProperty(tab, "title", {
    get() {
      titleRead = true;
      return "Private page title";
    },
  });

  await assert.rejects(
    () => captureContextSelection(info, tab, storage, () => "not-created"),
    { code: "consent-required" },
  );

  assert.equal(selectionRead, false);
  assert.equal(titleRead, false);
  assert.deepEqual(storage.values, before);
});

test("context-menu sync removes the menu before checking consent", async () => {
  const storage = createMemoryStorage();
  const calls = [];
  const contextMenus = {
    async remove(identifier) {
      calls.push(["remove", identifier]);
    },
    async create(options) {
      calls.push(["create", options.id]);
    },
  };

  assert.equal(await syncCaptureContextMenu(storage, contextMenus, {}), false);
  assert.deepEqual(calls, [["remove", CAPTURE_CONTEXT_MENU_ID]]);

  storage.values[STORAGE_KEYS.dataEpoch] = DATA_EPOCH;
  storage.values[STORAGE_KEYS.dataConsent] = {
    version: 1,
    epoch: DATA_EPOCH,
    accepted: true,
  };
  assert.equal(await syncCaptureContextMenu(storage, contextMenus, {}), true);
  assert.deepEqual(calls.slice(-2), [
    ["remove", CAPTURE_CONTEXT_MENU_ID],
    ["create", CAPTURE_CONTEXT_MENU_ID],
  ]);

  storage.values[STORAGE_KEYS.dataConsent] = {
    version: 1,
    epoch: DATA_EPOCH,
    accepted: false,
  };
  assert.equal(await syncCaptureContextMenu(storage, contextMenus, {}), false);
  assert.deepEqual(calls.at(-1), ["remove", CAPTURE_CONTEXT_MENU_ID]);
});

test("does not queue a context capture across a data reset", async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.dataEpoch]: DATA_EPOCH });
  const originalGet = storage.get.bind(storage);
  let changedEpoch = false;
  storage.get = async (keys) => {
    const result = await originalGet(keys);
    if (
      !changedEpoch &&
      Array.isArray(keys) &&
      keys.includes(STORAGE_KEYS.dataEpoch)
    ) {
      changedEpoch = true;
      storage.values[STORAGE_KEYS.dataEpoch] = "context-menu-new-epoch";
    }
    return result;
  };

  await assert.rejects(
    () =>
      captureContextSelection(
        { selectionText: "Do not restore after reset" },
        { title: "Old lecture" },
        storage,
        () => "context-menu-stale",
      ),
    { code: "data-reset" },
  );
  assert.deepEqual(await loadPendingCaptures(storage), []);
});

test("ignores an empty context-menu selection", async () => {
  const storage = memoryStorage();
  const result = await captureContextSelection(
    { selectionText: "\u202e\u0000  " },
    {},
    storage,
    () => "unused-session",
  );

  assert.deepEqual(result, {
    saved: false,
    reason: "empty-selection",
    wasTruncated: false,
  });
  assert.equal(await loadDraft(storage), null);
  assert.deepEqual(await loadPendingCaptures(storage), []);
});

test("keeps an existing popup draft byte-for-byte while queuing a capture", async () => {
  const existingDraft = {
    version: 1,
    ownerSessionId: "newer-popup",
    generation: 4,
    contentGeneration: 7,
    draft: {
      sessionId: "newer-popup",
      noteId: null,
      baseRevision: 3,
      baseUpdatedAt: "",
      title: "Unfinished lecture",
      body: "Keep the newer draft",
      course: "CS 101",
      source: { title: "Original source", url: "https://example.com/original" },
      updatedAt: "2026-10-29T12:00:00.000Z",
    },
  };
  const storage = memoryStorage({ [STORAGE_KEYS.draft]: existingDraft });
  const before = structuredClone(storage.values[STORAGE_KEYS.draft]);

  const result = await captureContextSelection(
    { selectionText: "New selected text", pageUrl: "https://example.com" },
    { title: "Lecture" },
    storage,
    () => "context-menu-new",
  );

  assert.equal(result.saved, true);
  assert.deepEqual(storage.values[STORAGE_KEYS.draft], before);
  assert.equal((await loadDraft(storage)).body, "Keep the newer draft");
  assert.equal((await loadPendingCaptures(storage))[0].text, "New selected text");
});

test("keeps context-menu truncation metadata in the queue", async () => {
  const storage = memoryStorage();
  const result = await captureContextSelection(
    { selectionText: "x".repeat(LIMITS.body + 10), pageUrl: "https://example.com" },
    { title: "Large lecture" },
    storage,
    () => "context-menu-large",
  );

  assert.equal(result.wasTruncated, true);
  const [capture] = await loadPendingCaptures(storage);
  assert.equal(capture.text.length, LIMITS.body);
  assert.equal(capture.wasTruncated, true);
});

test("opens a captured draft in a tab when a popup window fails", async () => {
  const createdTabs = [];
  const opened = await openCaptureSurface({
    runtime: { getURL: (path) => `chrome-extension://test/${path}` },
    windows: {
      async create() {
        throw new Error("Popups blocked");
      },
    },
    tabs: {
      async create(options) {
        createdTabs.push(options);
      },
    },
  });

  assert.equal(opened, "tab");
  assert.deepEqual(createdTabs, [{ url: "chrome-extension://test/popup.html" }]);
});

test("opens a captured draft in a popup window when allowed", async () => {
  const createdWindows = [];
  const opened = await openCaptureSurface({
    runtime: { getURL: (path) => `chrome-extension://test/${path}` },
    windows: {
      async create(options) {
        createdWindows.push(options);
      },
    },
  });

  assert.equal(opened, "popup-window");
  assert.deepEqual(createdWindows, [
    {
      url: "chrome-extension://test/popup.html",
      type: "popup",
      width: 430,
      height: 650,
      focused: true,
    },
  ]);
});

test("reports when neither capture editor surface can open", async () => {
  await assert.rejects(
    () =>
      openCaptureSurface({
        runtime: { getURL: () => "chrome-extension://test/popup.html" },
        windows: {
          async create() {
            throw new Error("Window failed");
          },
        },
        tabs: {
          async create() {
            throw new Error("Tab failed");
          },
        },
      }),
    /Window failed\. Tab failed/u,
  );

  await assert.rejects(
    () =>
      openCaptureSurface({
        runtime: { getURL: () => "chrome-extension://test/popup.html" },
      }),
    /editor could not open/u,
  );
});

test("handles only the Lecture Notes capture menu item", async () => {
  assert.deepEqual(
    await handleContextMenuClick({ menuItemId: "another-item" }, {}, {}),
    { handled: false },
  );

  const storage = memoryStorage();
  const createdWindows = [];
  const result = await handleContextMenuClick(
    {
      menuItemId: CAPTURE_CONTEXT_MENU_ID,
      selectionText: "Selected theorem",
      pageUrl: "https://example.com/week-3",
    },
    { title: "Week 3" },
    {
      storage: { local: storage },
      runtime: { getURL: (path) => `chrome-extension://test/${path}` },
      windows: {
        async create(options) {
          createdWindows.push(options);
        },
      },
    },
  );

  assert.equal(result.handled, true);
  assert.equal(result.capture.saved, true);
  assert.equal(result.surface, "popup-window");
  assert.equal(createdWindows[0].url, "chrome-extension://test/popup.html");
  assert.equal(await loadDraft(storage), null);
  assert.equal((await loadPendingCaptures(storage))[0].text, "Selected theorem");
});

test("a stale context-menu click opens the consent gate without reading selection", async () => {
  const storage = createMemoryStorage();
  let selectionRead = false;
  let opened = false;
  const info = { menuItemId: CAPTURE_CONTEXT_MENU_ID };
  Object.defineProperty(info, "selectionText", {
    get() {
      selectionRead = true;
      return "Do not read this selection";
    },
  });

  const result = await handleContextMenuClick(info, {}, {
    storage: { local: storage },
    runtime: { getURL: (path) => `chrome-extension://test/${path}` },
    windows: {
      async create() {
        opened = true;
      },
    },
  });

  assert.equal(result.capture.reason, "consent-required");
  assert.equal(opened, true);
  assert.equal(selectionRead, false);
  assert.deepEqual(storage.values, {});
});

test("does not open an editor for an empty context-menu selection", async () => {
  let opened = false;
  const result = await handleContextMenuClick(
    {
      menuItemId: CAPTURE_CONTEXT_MENU_ID,
      selectionText: "   ",
    },
    {},
    {
      storage: { local: memoryStorage() },
      runtime: { getURL: () => "chrome-extension://test/popup.html" },
      windows: {
        async create() {
          opened = true;
        },
      },
    },
  );

  assert.equal(result.handled, true);
  assert.equal(result.capture.saved, false);
  assert.equal(result.surface, null);
  assert.equal(opened, false);
});

test("does not open an editor when a context capture cannot be queued", async () => {
  const storage = memoryStorage();
  storage.set = async () => {
    throw new Error("Storage unavailable");
  };
  let opened = false;

  await assert.rejects(
    () =>
      handleContextMenuClick(
        {
          menuItemId: CAPTURE_CONTEXT_MENU_ID,
          selectionText: "Keep this selection",
        },
        {},
        {
          storage: { local: storage },
          runtime: { getURL: () => "chrome-extension://test/popup.html" },
          windows: {
            async create() {
              opened = true;
            },
          },
        },
      ),
    /Storage unavailable/u,
  );
  assert.equal(opened, false);
});

test("removes a queued capture only after its handed-off draft is saved", async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.dataEpoch]: DATA_EPOCH });
  await captureContextSelection(
    { selectionText: "Queued selection" },
    {},
    storage,
    () => "capture-handoff",
  );
  const message = {
    type: MESSAGE_TYPES.saveDraft,
    sessionId: "popup-session",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    contentGeneration: 1,
    expectedEpoch: DATA_EPOCH,
    pendingCaptureId: "capture-handoff",
    draft: { body: "Queued selection", sessionId: "popup-session" },
  };

  const result = await handleDraftMessage(
    message,
    { id: RUNTIME_ID },
    storage,
    RUNTIME_ID,
  );

  assert.equal(result.saved, true);
  assert.equal((await loadDraft(storage)).body, "Queued selection");
  assert.deepEqual(await loadPendingCaptures(storage), []);
});

test("keeps a queued capture when its handed-off draft loses a conflict", async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.dataEpoch]: DATA_EPOCH });
  await captureContextSelection(
    { selectionText: "Queued selection" },
    {},
    storage,
    () => "capture-conflict",
  );
  await handleDraftMessage(
    {
      type: MESSAGE_TYPES.saveDraft,
      sessionId: "other-popup",
      expectedOwnerSessionId: "",
      expectedGeneration: 0,
      contentGeneration: 2,
      expectedEpoch: DATA_EPOCH,
      draft: { body: "Newer draft", sessionId: "other-popup" },
    },
    { id: RUNTIME_ID },
    storage,
    RUNTIME_ID,
  );

  const result = await handleDraftMessage(
    {
      type: MESSAGE_TYPES.saveDraft,
      sessionId: "stale-popup",
      expectedOwnerSessionId: "",
      expectedGeneration: 0,
      contentGeneration: 1,
      expectedEpoch: DATA_EPOCH,
      pendingCaptureId: "capture-conflict",
      draft: { body: "Queued selection", sessionId: "stale-popup" },
    },
    { id: RUNTIME_ID },
    storage,
    RUNTIME_ID,
  );

  assert.equal(result.saved, false);
  assert.equal((await loadPendingCaptures(storage))[0].id, "capture-conflict");
});
