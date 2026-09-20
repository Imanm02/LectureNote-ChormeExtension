import assert from "node:assert/strict";
import test from "node:test";

import { serializeBackup } from "../src/backup.js";
import { createEmptyState, createNote } from "../src/model.js";
import { initLibrary } from "../src/notes.js";
import { STORAGE_KEYS } from "../src/storage.js";
import {
  chromeMock,
  enableDialogs,
  loadPage,
  memoryStorage,
  waitFor,
} from "./helpers.js";

const START = "2026-09-20T10:00:00.000Z";

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function note(identifier, body, overrides = {}) {
  return createNote(
    {
      title: overrides.title || `Note ${identifier}`,
      body,
      course: overrides.course || "CS 101",
      source: overrides.source || {
        title: "Lecture",
        url: "https://example.com/lecture",
      },
    },
    { idFactory: () => identifier, now: START },
  );
}

function setupDocument() {
  const dom = loadPage("notes.html");
  enableDialogs(dom.window.document);
  return dom;
}

async function setupLibrary(t, notes, storage = null) {
  const dom = setupDocument();
  const storageValue = storage || memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes },
  });
  const chromeApi = chromeMock(storageValue);
  const controller = await initLibrary({
    documentValue: dom.window.document,
    chromeApi,
    navigatorValue: { clipboard: { async writeText() {} } },
    urlApi: {
      createObjectURL() {
        return "blob:test";
      },
      revokeObjectURL() {},
    },
  });
  t.after(() => {
    controller.destroy();
    dom.window.close();
  });
  return { chromeApi, controller, documentValue: dom.window.document, dom, storage: storageValue };
}

function submit(documentValue, formId) {
  documentValue.getElementById(formId).dispatchEvent(
    new documentValue.defaultView.Event("submit", { bubbles: true, cancelable: true }),
  );
}

test("keeps state actions disabled after load failure and supports retry", async (t) => {
  const stored = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes: [note("first", "Saved body")] },
  });
  let failReads = true;
  const storage = {
    values: stored.values,
    async get(keys) {
      if (failReads) {
        throw new Error("Storage read blocked.");
      }
      return stored.get(keys);
    },
    async set(update) {
      return stored.set(update);
    },
    async remove(keys) {
      return stored.remove(keys);
    },
  };
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue } = setup;

  assert.equal(controller.getState(), undefined);
  assert.equal(documentValue.getElementById("resultSummary").textContent, "Library unavailable");
  assert.match(documentValue.getElementById("libraryStatus").textContent, /Storage read blocked/u);
  assert.equal(documentValue.getElementById("retryLoadButton").hidden, false);
  assert.equal(documentValue.getElementById("notesList").inert, true);
  for (const identifier of [
    "newNoteButton",
    "emptyNewNoteButton",
    "searchInput",
    "courseFilter",
    "sortSelect",
    "themeSelect",
    "exportJsonButton",
    "exportMarkdownButton",
    "importButton",
    "showMoreButton",
  ]) {
    assert.equal(documentValue.getElementById(identifier).disabled, true, identifier);
  }

  failReads = false;
  documentValue.getElementById("retryLoadButton").click();
  await waitFor(() => controller.getState()?.notes.length === 1);

  assert.equal(documentValue.getElementById("retryLoadButton").hidden, true);
  assert.equal(documentValue.getElementById("notesList").inert, false);
  assert.equal(documentValue.getElementById("newNoteButton").disabled, false);
  assert.equal(documentValue.querySelectorAll(".note-card").length, 1);
});

test("detects an external edit when its timestamp is unchanged", async (t) => {
  const original = note("first", "Original body");
  const setup = await setupLibrary(t, [original]);
  const { controller, documentValue, storage } = setup;

  documentValue.querySelector("[data-action='edit']").click();
  const body = documentValue.getElementById("editorBody");
  body.value = "Local body";
  body.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));

  storage.values[STORAGE_KEYS.state] = {
    ...structuredClone(controller.getState()),
    revision: 1,
    notes: [{ ...structuredClone(original), body: "External body", updatedAt: START }],
  };
  submit(documentValue, "editorForm");
  await waitFor(() => documentValue.getElementById("editorStatus").textContent.includes("another window"));

  assert.equal(documentValue.getElementById("editorDialog").open, true);
  assert.equal(body.value, "Local body");
  assert.equal(storage.values[STORAGE_KEYS.state].notes[0].body, "External body");
  assert.equal(storage.values[STORAGE_KEYS.state].notes[0].updatedAt, START);
});

test("does not run library shortcuts while a dialog is open", async (t) => {
  const setup = await setupLibrary(t, [note("first", "Original body")]);
  const { documentValue } = setup;

  documentValue.querySelector("[data-action='edit']").click();
  const body = documentValue.getElementById("editorBody");
  body.value = "Unsaved body";
  body.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  documentValue.getElementById("closeEditorButton").dispatchEvent(
    new documentValue.defaultView.KeyboardEvent("keydown", { bubbles: true, key: "n" }),
  );

  assert.equal(documentValue.getElementById("editorHeading").textContent, "Edit note");
  assert.equal(body.value, "Unsaved body");
});

test("saves the editor values captured at submit time", async (t) => {
  const stored = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const readStarted = deferred();
  const releaseRead = deferred();
  let blockReads = false;
  const storage = {
    values: stored.values,
    async get(keys) {
      if (blockReads) {
        readStarted.resolve();
        await releaseRead.promise;
      }
      return stored.get(keys);
    },
    async set(update) {
      return stored.set(update);
    },
    async remove(keys) {
      return stored.remove(keys);
    },
  };
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue } = setup;

  documentValue.getElementById("newNoteButton").click();
  documentValue.getElementById("editorTitle").value = "Captured title";
  const body = documentValue.getElementById("editorBody");
  body.value = "Captured body";
  blockReads = true;
  submit(documentValue, "editorForm");
  await readStarted.promise;
  body.value = "Changed after submit";
  releaseRead.resolve();
  await waitFor(() => controller.getState().notes.length === 1);

  assert.equal(controller.getState().notes[0].body, "Captured body");
});

test("refreshes dialog return focus after an external render", async (t) => {
  const setup = await setupLibrary(t, [note("first", "Original body")]);
  const { chromeApi, controller, documentValue, storage } = setup;
  const oldEdit = documentValue.querySelector("[data-action='edit']");
  oldEdit.click();
  const external = { ...structuredClone(controller.getState()), revision: 1 };
  storage.values[STORAGE_KEYS.state] = external;

  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.state]: { newValue: external, oldValue: controller.getState() },
  });
  assert.equal(oldEdit.isConnected, false);
  documentValue.getElementById("closeEditorButton").click();

  assert.equal(documentValue.activeElement.dataset.action, "edit");
  assert.equal(documentValue.activeElement.isConnected, true);
});

test("keeps an invalid source URL visible with an editor error", async (t) => {
  const setup = await setupLibrary(t, []);
  const { controller, documentValue } = setup;

  documentValue.getElementById("newNoteButton").click();
  documentValue.getElementById("editorTitle").value = "Unsafe source";
  documentValue.getElementById("editorBody").value = "Body";
  const sourceUrl = documentValue.getElementById("editorSourceUrl");
  sourceUrl.value = "javascript:alert(1)";
  sourceUrl.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  submit(documentValue, "editorForm");
  await waitFor(() => sourceUrl.getAttribute("aria-invalid") === "true");

  assert.equal(documentValue.getElementById("editorDialog").open, true);
  assert.equal(sourceUrl.value, "javascript:alert(1)");
  assert.match(documentValue.getElementById("editorStatus").textContent, /valid HTTP or HTTPS/u);
  assert.equal(controller.getState().notes.length, 0);
});

test("keeps undo available until it is dismissed", async (t) => {
  const setup = await setupLibrary(t, [note("first", "Saved body")]);
  const { controller, documentValue } = setup;

  documentValue.querySelector("[data-action='delete']").click();
  submit(documentValue, "deleteForm");
  await waitFor(() => controller.getState().notes.length === 0);

  const undoBar = documentValue.getElementById("undoBar");
  assert.equal(undoBar.hidden, false);
  controller.render();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.equal(undoBar.hidden, false);

  documentValue.getElementById("dismissUndoButton").click();
  assert.equal(undoBar.hidden, true);
  documentValue.getElementById("undoButton").click();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.equal(controller.getState().notes.length, 0);
});

test("clears a prior undo record after replacing the library", async (t) => {
  const setup = await setupLibrary(t, [note("first", "Saved body")]);
  const { controller, documentValue } = setup;

  documentValue.querySelector("[data-action='delete']").click();
  submit(documentValue, "deleteForm");
  await waitFor(() => controller.getState().notes.length === 0);
  assert.equal(documentValue.getElementById("undoBar").hidden, false);

  const imported = note("imported", "Imported body", { course: "History" });
  const backupText = serializeBackup({ ...createEmptyState(), notes: [imported] });
  const importInput = documentValue.getElementById("importFileInput");
  Object.defineProperty(importInput, "files", {
    configurable: true,
    value: [{
      size: new TextEncoder().encode(backupText).byteLength,
      async text() {
        return backupText;
      },
    }],
  });
  importInput.dispatchEvent(new documentValue.defaultView.Event("change", { bubbles: true }));
  await waitFor(() => documentValue.getElementById("importDialog").open);
  documentValue.getElementById("replaceImportButton").click();
  assert.equal(documentValue.getElementById("replaceDialog").open, true);
  submit(documentValue, "replaceForm");
  await waitFor(() => controller.getState().notes[0]?.id === "imported");

  assert.equal(documentValue.getElementById("undoBar").hidden, true);
  documentValue.getElementById("undoButton").click();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.deepEqual(controller.getState().notes.map((entry) => entry.id), ["imported"]);
});

test("clears undo after an external library replacement", async (t) => {
  const setup = await setupLibrary(t, [note("first", "Saved body")]);
  const { chromeApi, controller, documentValue, storage } = setup;

  documentValue.querySelector("[data-action='delete']").click();
  submit(documentValue, "deleteForm");
  await waitFor(() => controller.getState().notes.length === 0);
  const replacement = {
    ...createEmptyState(),
    revision: controller.getState().revision + 1,
    notes: [note("replacement", "Replacement body")],
  };
  storage.values[STORAGE_KEYS.state] = replacement;
  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.state]: { newValue: replacement, oldValue: controller.getState() },
  });

  assert.equal(documentValue.getElementById("undoBar").hidden, true);
  documentValue.getElementById("undoButton").click();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.deepEqual(controller.getState().notes.map((entry) => entry.id), ["replacement"]);
});

test("shows a failed delete inside the open confirmation dialog", async (t) => {
  const stored = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes: [note("first", "Saved body")] },
  });
  let failWrites = false;
  const storage = {
    values: stored.values,
    async get(keys) {
      return stored.get(keys);
    },
    async set(update) {
      if (failWrites) {
        throw new Error("Storage write blocked.");
      }
      return stored.set(update);
    },
    async remove(keys) {
      return stored.remove(keys);
    },
  };
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue } = setup;

  documentValue.querySelector("[data-action='delete']").click();
  failWrites = true;
  submit(documentValue, "deleteForm");
  const deleteStatus = documentValue.getElementById("deleteStatus");
  await waitFor(() => deleteStatus.textContent.includes("Storage write blocked"));

  assert.equal(documentValue.getElementById("deleteDialog").open, true);
  assert.equal(documentValue.getElementById("confirmDeleteButton").disabled, false);
  assert.equal(documentValue.getElementById("libraryStatus").textContent, "");
  assert.equal(controller.getState().notes.length, 1);
});

test("does not delete a note changed after confirmation opened", async (t) => {
  const original = note("conflict-delete", "Original body");
  const setup = await setupLibrary(t, [original]);
  const { chromeApi, controller, documentValue, storage } = setup;
  documentValue.querySelector("[data-action='delete']").click();

  const changed = { ...original, body: "Newer body from another window" };
  storage.values[STORAGE_KEYS.state] = {
    ...controller.getState(),
    revision: controller.getState().revision + 1,
    notes: [changed],
  };
  await chromeApi.emitStorageChange({ [STORAGE_KEYS.state]: { newValue: storage.values[STORAGE_KEYS.state] } });
  submit(documentValue, "deleteForm");
  await waitFor(() => documentValue.getElementById("deleteStatus").textContent.includes("changed in another window"));

  assert.equal(controller.getState().notes[0].body, "Newer body from another window");
  assert.equal(documentValue.getElementById("deleteDialog").open, true);
});

test("renders 101 notes in two batches", async (t) => {
  const notes = Array.from({ length: 101 }, (_, index) =>
    note(`note-${index}`, `Body ${index}`),
  );
  const setup = await setupLibrary(t, notes);
  const { documentValue } = setup;

  assert.equal(documentValue.querySelectorAll(".note-card").length, 100);
  assert.equal(documentValue.getElementById("showMoreButton").hidden, false);
  assert.match(documentValue.getElementById("resultSummary").textContent, /Showing 100 of 101/u);

  documentValue.getElementById("showMoreButton").click();
  assert.equal(documentValue.querySelectorAll(".note-card").length, 101);
  assert.equal(documentValue.getElementById("showMoreButton").hidden, true);
  assert.equal(documentValue.getElementById("resultSummary").textContent, "Showing 101 of 101 notes");
  assert.equal(
    documentValue.activeElement.closest("[data-note-id]"),
    documentValue.querySelectorAll("[data-note-id]")[100],
  );
});
