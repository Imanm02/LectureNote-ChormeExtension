import assert from "node:assert/strict";
import test from "node:test";

import { LIMITS, createEmptyState, createNote } from "../src/model.js";
import { initPopup } from "../src/popup.js";
import { STORAGE_KEYS } from "../src/storage.js";
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

  assert.equal(draftWrites, 0);
  assert.equal(STORAGE_KEYS.draft in storage.values, false);
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

  assert.equal(STORAGE_KEYS.draft in blocked.storage.values, false);
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

  assert.equal(draftWrites, 0);
  assert.equal(STORAGE_KEYS.draft in storage.values, false);
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

  assert.equal(STORAGE_KEYS.draft in blocked.storage.values, false);
  controller.destroy();
  dom.window.close();
});

test("keeps the clear-draft warning after a note is saved", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  storage.remove = async (keys) => {
    if ((Array.isArray(keys) ? keys : [keys]).includes(STORAGE_KEYS.draft)) {
      throw new Error("Storage remove failed");
    }
  };
  const controller = await initPopup({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage, { text: "Save despite a cleanup error" }),
  });

  submit(dom.window, dom.window.document.getElementById("noteForm"));
  await waitFor(() => controller.getState().notes.length === 1);
  await waitFor(() => dom.window.document.getElementById("status").dataset.kind === "warning");

  assert.equal(
    dom.window.document.getElementById("status").textContent,
    "Note saved, but the draft could not be cleared: Storage remove failed",
  );
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
  await waitFor(() => dom.window.document.getElementById("status").textContent.startsWith("Note saved."));

  assert.equal(STORAGE_KEYS.draft in storage.values, false);
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

  assert.equal(STORAGE_KEYS.draft in storage.values, false);
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
