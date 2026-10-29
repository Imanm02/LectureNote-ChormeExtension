import assert from "node:assert/strict";
import test from "node:test";

import { LIMITS, createEmptyState, createNote } from "../src/model.js";
import { initPopup } from "../src/popup.js";
import { loadDraft, resetAllData, STORAGE_KEYS } from "../src/storage.js";
import { chromeMock, loadPage, memoryStorage, waitFor } from "./helpers.js";

function input(windowValue, element) {
  element.dispatchEvent(new windowValue.Event("input", { bubbles: true }));
}

function submit(windowValue, form) {
  form.dispatchEvent(new windowValue.Event("submit", { bubbles: true, cancelable: true }));
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function blockingDraftStorage(initial = {}) {
  const storage = memoryStorage(initial);
  const baseSet = storage.set.bind(storage);
  const draftStarted = deferred();
  const releaseDraft = deferred();
  let shouldBlock = true;

  storage.set = async (update) => {
    if (shouldBlock && Object.hasOwn(update, STORAGE_KEYS.draft)) {
      shouldBlock = false;
      draftStarted.resolve();
      await releaseDraft.promise;
    }
    await baseSet(update);
  };

  return { storage, draftStarted: draftStarted.promise, releaseDraft: releaseDraft.resolve };
}

test("a first-use popup does not inspect the page or saved notes before consent", async () => {
  const dom = loadPage("popup.html");
  const storedState = { private: "saved-notes-not-read" };
  const storage = memoryStorage({ [STORAGE_KEYS.state]: storedState });
  const reads = [];
  const baseGet = storage.get.bind(storage);
  storage.get = async (keys) => {
    reads.push(Array.isArray(keys) ? [...keys] : [keys]);
    return baseGet(keys);
  };
  const chromeApi = chromeMock(
    storage,
    { title: "Private page", text: "Private selection" },
    { dataConsent: false },
  );
  let tabQueries = 0;
  let scriptExecutions = 0;
  const baseQuery = chromeApi.tabs.query;
  const baseExecute = chromeApi.scripting.executeScript;
  chromeApi.tabs.query = async (...args) => {
    tabQueries += 1;
    return baseQuery(...args);
  };
  chromeApi.scripting.executeScript = async (...args) => {
    scriptExecutions += 1;
    return baseExecute(...args);
  };

  const controllerPromise = initPopup({
    documentValue: dom.window.document,
    chromeApi,
  });
  await waitFor(() =>
    dom.window.document.getElementById("dataConsentDialog").open &&
    !dom.window.document.getElementById("dataConsentAcceptButton").disabled,
  );

  assert.equal(tabQueries, 0);
  assert.equal(scriptExecutions, 0);
  assert.deepEqual(reads, [[STORAGE_KEYS.dataConsent, STORAGE_KEYS.dataEpoch]]);
  assert.deepEqual(storage.values[STORAGE_KEYS.state], storedState);
  assert.equal(dom.window.document.getElementById("titleInput").value, "");
  assert.equal(dom.window.document.getElementById("bodyInput").value, "");

  dom.window.document.getElementById("dataConsentAcceptButton").click();
  const controller = await controllerPromise;
  assert.equal(tabQueries, 1);
  assert.equal(scriptExecutions, 1);
  controller.destroy();
  dom.window.close();
});

test("explains a failed context-menu capture in the popup", async () => {
  const dom = loadPage("popup.html");
  dom.reconfigure({
    url: "https://extension.test/popup.html?captureError=pending-capture-limit",
  });
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage),
  });

  const status = dom.window.document.getElementById("status");
  assert.equal(
    status.textContent,
    "The capture queue is full. Use or discard a waiting capture before trying again.",
  );
  assert.equal(status.dataset.kind, "error");
  assert.equal(status.getAttribute("role"), "alert");
  controller.destroy();
  dom.window.close();
});

test("bounds long page metadata before saving a captured note", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const trackingUrl = `https://example.com/lecture?utm_source=${"x".repeat(80_000)}&token=private`;
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage, {
      title: "T".repeat(5_000),
      text: "Captured note",
      url: trackingUrl,
    }),
  });

  assert.equal(dom.window.document.getElementById("titleInput").value.length, LIMITS.title);
  assert.equal(dom.window.document.getElementById("sourceTitle").textContent.length, LIMITS.sourceTitle);
  assert.equal(
    dom.window.document.getElementById("sourceLink").href,
    "https://example.com/lecture",
  );

  submit(dom.window, dom.window.document.getElementById("noteForm"));
  await waitFor(() => controller.getState().notes.length === 1);
  await waitFor(() => dom.window.document.getElementById("status").textContent.startsWith("Note saved."));

  const [note] = controller.getState().notes;
  assert.equal(note.title.length, LIMITS.title);
  assert.equal(note.source.title.length, LIMITS.sourceTitle);
  assert.equal(note.source.url, "https://example.com/lecture");
  controller.destroy();
  dom.window.close();
});

test("keeps captured page titles well formed at field limits", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const titlePrefix = "T".repeat(LIMITS.title - 1);
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage, {
      title: `${titlePrefix}🎓${"U".repeat(80)}`,
      text: "Captured note",
      url: "https://example.com/lecture",
    }),
  });

  const title = dom.window.document.getElementById("titleInput").value;
  const sourceTitle = dom.window.document.getElementById("sourceTitle").textContent;
  assert.equal(title, titlePrefix);
  assert.equal(title.isWellFormed(), true);
  assert.equal(sourceTitle.length, LIMITS.sourceTitle);
  assert.equal(sourceTitle.isWellFormed(), true);

  submit(dom.window, dom.window.document.getElementById("noteForm"));
  await waitFor(() => controller.getState().notes.length === 1);
  const [note] = controller.getState().notes;
  assert.equal(note.title, titlePrefix);
  assert.equal(note.source.title, sourceTitle);
  assert.equal(note.title.isWellFormed(), true);
  assert.equal(note.source.title.isWellFormed(), true);
  controller.destroy();
  dom.window.close();
});

test("cancels a pending draft write after save", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const baseSet = storage.set.bind(storage);
  let draftWrites = 0;
  storage.set = async (update) => {
    if (Object.hasOwn(update, STORAGE_KEYS.draft)) {
      draftWrites += 1;
    }
    await baseSet(update);
  };
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage),
  });
  const body = dom.window.document.getElementById("bodyInput");
  body.value = "Save this note";
  input(dom.window, body);

  submit(dom.window, dom.window.document.getElementById("noteForm"));
  await waitFor(() => dom.window.document.getElementById("status").textContent.startsWith("Note saved."));
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  await controller.flushDraft();

  assert.equal(draftWrites, 1);
  assert.equal(await loadDraft(storage), null);
  controller.destroy();
  dom.window.close();
});

test("clears an in-flight draft write after save", async () => {
  const dom = loadPage("popup.html");
  const blocked = blockingDraftStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(blocked.storage),
  });
  const body = dom.window.document.getElementById("bodyInput");
  body.value = "Save while the draft is writing";
  input(dom.window, body);
  await blocked.draftStarted;

  submit(dom.window, dom.window.document.getElementById("noteForm"));
  blocked.releaseDraft();
  await waitFor(() => controller.getState().notes.length === 1);
  await waitFor(() => dom.window.document.getElementById("status").textContent.startsWith("Note saved."));
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  await controller.flushDraft();

  assert.equal(await loadDraft(blocked.storage), null);
  controller.destroy();
  dom.window.close();
});

test("cancels a pending draft write after discard", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const baseSet = storage.set.bind(storage);
  let draftWrites = 0;
  storage.set = async (update) => {
    if (Object.hasOwn(update, STORAGE_KEYS.draft)) {
      draftWrites += 1;
    }
    await baseSet(update);
  };
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage),
    confirmDiscard: () => true,
  });
  const body = dom.window.document.getElementById("bodyInput");
  body.value = "Discard this draft";
  input(dom.window, body);

  dom.window.document.getElementById("discardButton").click();
  await waitFor(() => dom.window.document.getElementById("status").textContent.startsWith("The draft was reset"));
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  await controller.flushDraft();

  assert.equal(draftWrites, 1);
  assert.equal(await loadDraft(storage), null);
  controller.destroy();
  dom.window.close();
});

test("clears an in-flight draft write after discard", async () => {
  const dom = loadPage("popup.html");
  const blocked = blockingDraftStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(blocked.storage),
    confirmDiscard: () => true,
  });
  const body = dom.window.document.getElementById("bodyInput");
  body.value = "Discard while the draft is writing";
  input(dom.window, body);
  await blocked.draftStarted;

  dom.window.document.getElementById("discardButton").click();
  blocked.releaseDraft();
  await waitFor(() => dom.window.document.getElementById("status").textContent.startsWith("The draft was reset"));
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  await controller.flushDraft();

  assert.equal(await loadDraft(blocked.storage), null);
  controller.destroy();
  dom.window.close();
});

test("falls back to direct storage when background handoff reports an error", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const chromeApi = chromeMock(storage);
  let sentMessage;
  chromeApi.runtime = {
    async sendMessage(message) {
      sentMessage = message;
      return { ok: false, error: "Background storage failed" };
    },
  };
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi,
  });
  const body = dom.window.document.getElementById("bodyInput");
  body.value = "Keep this closing popup draft";
  input(dom.window, body);

  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  await controller.flushDraft();

  assert.equal((await loadDraft(storage)).body, "Keep this closing popup draft");
  assert.equal(sentMessage.expectedEpoch, storage.values[STORAGE_KEYS.dataEpoch]);
  controller.destroy();
  dom.window.close();
});

test("clears the form and gates a background data reset conflict", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  const chromeApi = chromeMock(storage);
  chromeApi.runtime = {
    async sendMessage() {
      storage.values[STORAGE_KEYS.dataEpoch] = "background-reset-epoch";
      storage.values[STORAGE_KEYS.dataConsent] = {
        version: 1,
        epoch: "background-reset-epoch",
        accepted: false,
      };
      return {
        ok: false,
        error: "The note data was reset in another window.",
        code: "data-reset",
      };
    },
  };
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi,
  });
  const body = dom.window.document.getElementById("bodyInput");
  body.value = "Keep the rejected handoff visible";
  input(dom.window, body);

  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  await controller.flushDraft();

  assert.equal(await loadDraft(storage), null);
  assert.equal(body.value, "");
  assert.equal(dom.window.document.getElementById("dataConsentDialog").open, true);
  assert.match(
    dom.window.document.getElementById("status").textContent,
    /Allow local note capture/iu,
  );
  controller.destroy();
  dom.window.close();
});

test("hands off a dirty draft when the popup becomes hidden", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage),
  });
  const body = dom.window.document.getElementById("bodyInput");
  body.value = "Save before the popup closes";
  input(dom.window, body);
  Object.defineProperty(dom.window.document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });

  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await controller.flushDraft();

  assert.equal((await loadDraft(storage)).body, "Save before the popup closes");
  controller.destroy();
  dom.window.close();
});

test("clears captured data and stops writes after observing a reset", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  const chromeApi = chromeMock(storage);
  const sentMessages = [];
  chromeApi.runtime = {
    async sendMessage(message) {
      sentMessages.push(message);
      return { ok: true, saved: true };
    },
  };
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi,
  });
  const body = dom.window.document.getElementById("bodyInput");
  body.value = "Keep this visible for manual copy";
  input(dom.window, body);
  const oldEpoch = storage.values[STORAGE_KEYS.dataEpoch];
  const oldState = structuredClone(storage.values[STORAGE_KEYS.state]);
  const reset = await resetAllData(storage, {
    lockManager: null,
    epochFactory: () => "popup-observed-reset",
  });
  const resetDraft = structuredClone(storage.values[STORAGE_KEYS.draft]);

  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.state]: { oldValue: oldState, newValue: reset.state },
    [STORAGE_KEYS.dataEpoch]: { oldValue: oldEpoch, newValue: reset.epoch },
  });
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  await controller.flushDraft();

  assert.equal(body.value, "");
  assert.equal(dom.window.document.getElementById("dataConsentDialog").open, true);
  assert.match(
    dom.window.document.getElementById("status").textContent,
    /Allow local note capture/iu,
  );
  assert.equal(dom.window.document.getElementById("saveButton").disabled, true);
  assert.equal(sentMessages.length, 0);
  assert.deepEqual(storage.values[STORAGE_KEYS.draft], resetDraft);
  assert.equal(storage.values[STORAGE_KEYS.state].notes.length, 0);
  controller.destroy();
  dom.window.close();
});

test("gates a stale popup save and lets a new popup save after consent", async () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.helpSeen]: true,
  });
  const staleDom = loadPage("popup.html");
  const staleController = await initPopup({
    documentValue: staleDom.window.document,
    chromeApi: chromeMock(storage),
  });
  const staleBody = staleDom.window.document.getElementById("bodyInput");
  staleBody.value = "Copy this stale text before reopening";
  input(staleDom.window, staleBody);
  await resetAllData(storage, {
    lockManager: null,
    epochFactory: () => "popup-silent-reset",
  });

  submit(staleDom.window, staleDom.window.document.getElementById("noteForm"));
  await waitFor(() =>
    staleDom.window.document.getElementById("status").textContent.includes("Allow local note capture"),
  );

  assert.equal(staleBody.value, "");
  assert.equal(staleDom.window.document.getElementById("dataConsentDialog").open, true);
  assert.equal(storage.values[STORAGE_KEYS.state].notes.length, 0);
  assert.equal(await loadDraft(storage), null);
  staleController.destroy();
  staleDom.window.close();

  const freshDom = loadPage("popup.html");
  const freshController = await initPopup({
    documentValue: freshDom.window.document,
    chromeApi: chromeMock(storage),
  });
  const freshBody = freshDom.window.document.getElementById("bodyInput");
  freshBody.value = "Fresh note after reset";
  input(freshDom.window, freshBody);
  submit(freshDom.window, freshDom.window.document.getElementById("noteForm"));
  await waitFor(() => storage.values[STORAGE_KEYS.state].notes.length === 1);

  assert.equal(storage.values[STORAGE_KEYS.state].notes[0].body, "Fresh note after reset");
  freshController.destroy();
  freshDom.window.close();
});

test("blocks a first-use popup when reset races with its help preference", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const originalSet = storage.set.bind(storage);
  let resetDuringHelp = false;
  storage.set = async (update) => {
    await originalSet(update);
    if (!resetDuringHelp && update[STORAGE_KEYS.helpSeen]) {
      resetDuringHelp = true;
      storage.values[STORAGE_KEYS.dataEpoch] = "help-race-reset-epoch";
    }
  };

  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage),
  });

  assert.equal(resetDuringHelp, true);
  assert.equal(dom.window.document.getElementById("saveButton").disabled, true);
  assert.match(
    dom.window.document.getElementById("status").textContent,
    /Allow local note capture/iu,
  );
  controller.destroy();
  dom.window.close();
});

test("keeps a newer draft when two popups edit at the same time", async () => {
  const firstDom = loadPage("popup.html");
  const secondDom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const first = await initPopup({
    documentValue: firstDom.window.document,
    chromeApi: chromeMock(storage),
  });
  const second = await initPopup({
    documentValue: secondDom.window.document,
    chromeApi: chromeMock(storage),
  });
  const firstBody = firstDom.window.document.getElementById("bodyInput");
  const secondBody = secondDom.window.document.getElementById("bodyInput");

  firstBody.value = "Draft from the first popup";
  input(firstDom.window, firstBody);
  await first.flushDraft();
  secondBody.value = "Draft from the stale popup";
  input(secondDom.window, secondBody);
  await second.flushDraft();

  assert.equal((await loadDraft(storage)).body, "Draft from the first popup");
  assert.match(
    secondDom.window.document.getElementById("status").textContent,
    /another popup saved a newer draft/iu,
  );

  submit(secondDom.window, secondDom.window.document.getElementById("noteForm"));
  await waitFor(() => second.getState().notes.length === 1);
  assert.equal((await loadDraft(storage)).body, "Draft from the first popup");
  assert.equal(
    secondDom.window.document.getElementById("status").textContent,
    "Note saved. A newer draft from another popup was kept.",
  );

  first.destroy();
  second.destroy();
  firstDom.window.close();
  secondDom.window.close();
});

test("does not save a note when its atomic draft cleanup fails", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const baseSet = storage.set.bind(storage);
  storage.set = async (update) => {
    if (
      Object.hasOwn(update, STORAGE_KEYS.state) &&
      Object.hasOwn(update, STORAGE_KEYS.draft)
    ) {
      throw new Error("Storage write failed");
    }
    await baseSet(update);
  };
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage, { text: "Save despite a cleanup error" }),
  });

  submit(dom.window, dom.window.document.getElementById("noteForm"));
  await waitFor(() => dom.window.document.getElementById("status").dataset.kind === "error");

  assert.equal(controller.getState().notes.length, 0);
  assert.equal(storage.values[STORAGE_KEYS.state].notes.length, 0);
  assert.equal(dom.window.document.getElementById("status").textContent, "Storage write failed");
  controller.destroy();
  dom.window.close();
});

test("clears a recovered owned draft when it is saved immediately", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.draft]: {
      sessionId: "older-popup",
      title: "Recovered",
      body: "Save without another input event",
      course: "CS 101",
      source: {},
    },
  });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage),
  });

  submit(dom.window, dom.window.document.getElementById("noteForm"));
  await waitFor(() => controller.getState().notes.length === 1);
  await waitFor(
    () =>
      dom.window.document.getElementById("status").textContent ===
      "Note saved without a source. Page source restored for the next note.",
  );

  assert.equal(await loadDraft(storage), null);
  controller.destroy();
  dom.window.close();
});

test("clears a recovered owned draft when it is discarded immediately", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.draft]: {
      sessionId: "older-popup",
      title: "Recovered",
      body: "Discard without another input event",
      course: "",
      source: {},
    },
  });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage),
    confirmDiscard: () => true,
  });

  dom.window.document.getElementById("discardButton").click();
  await waitFor(() => dom.window.document.getElementById("status").textContent.startsWith("The draft was reset"));

  assert.equal(await loadDraft(storage), null);
  controller.destroy();
  dom.window.close();
});

test("confirms before resetting a changed capture", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  let prompt = "";
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage, { title: "Lecture page", text: "Original selection" }),
    confirmDiscard(message) {
      prompt = message;
      return false;
    },
  });
  const body = dom.window.document.getElementById("bodyInput");
  const discard = dom.window.document.getElementById("discardButton");

  assert.equal(discard.disabled, true);
  assert.equal(discard.textContent, "Reset draft");
  body.value = "Changed draft";
  input(dom.window, body);
  assert.equal(discard.disabled, false);
  discard.click();

  assert.equal(prompt, "Reset this draft to the current page selection?");
  assert.equal(body.value, "Changed draft");
  controller.destroy();
  dom.window.close();
});

test("keeps page context and course ready after saving", async () => {
  const dom = loadPage("popup.html");
  const savedCourseNote = createNote(
    { title: "Earlier note", body: "Earlier body", course: "CS 101", source: {} },
    { idFactory: () => "earlier", now: "2026-09-20T10:00:00.000Z" },
  );
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes: [savedCourseNote] },
  });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage, {
      title: "Lecture page",
      text: "Selected text",
      url: "https://example.com/week-2",
    }),
  });
  const course = dom.window.document.getElementById("courseInput");
  course.value = "CS 101";
  input(dom.window, course);

  assert.deepEqual(
    [...dom.window.document.querySelectorAll("#courseSuggestions option")].map((option) => option.value),
    ["CS 101"],
  );
  submit(dom.window, dom.window.document.getElementById("noteForm"));
  await waitFor(() => controller.getState().notes.length === 2);
  await waitFor(() => dom.window.document.getElementById("status").textContent.includes("Source kept"));

  assert.equal(dom.window.document.getElementById("titleInput").value, "Lecture page");
  assert.equal(dom.window.document.getElementById("bodyInput").value, "");
  assert.equal(course.value, "CS 101");
  assert.equal(dom.window.document.getElementById("sourceLink").href, "https://example.com/week-2");
  assert.equal(dom.window.document.getElementById("useSelectionButton").hidden, false);
  assert.equal(dom.window.document.getElementById("discardButton").disabled, true);
  controller.destroy();
  dom.window.close();
});

test("warns when a recovered draft uses a truncated page selection", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.draft]: {
      sessionId: "older-popup",
      title: "Recovered",
      body: "Recovered body",
      course: "",
      source: {},
    },
  });
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage, { text: "Limited selection", wasTruncated: true }),
  });

  dom.window.document.getElementById("useSelectionButton").click();

  assert.equal(dom.window.document.getElementById("status").dataset.kind, "warning");
  assert.match(dom.window.document.getElementById("status").textContent, /limited to 100,000 characters/u);
  controller.destroy();
  dom.window.close();
});
