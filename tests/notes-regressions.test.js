import assert from "node:assert/strict";
import test from "node:test";

import { serializeBackup } from "../src/backup.js";
import { createEmptyState, createNote } from "../src/model.js";
import { initLibrary } from "../src/notes.js";
import {
  clearEditorDraft,
  loadEditorDraft,
  saveEditorDraft,
  STORAGE_KEYS,
} from "../src/storage.js";
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

async function setupLibrary(t, notes, storage = null, options = {}) {
  const dom = setupDocument();
  const storageValue = storage || memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes },
  });
  const chromeApi = chromeMock(storageValue);
  const controller = await initLibrary({
    documentValue: dom.window.document,
    chromeApi,
    navigatorValue: options.navigatorValue || { clipboard: { async writeText() {} } },
    timerApi: options.timerApi,
    urlApi: options.urlApi || {
      createObjectURL() {
        return "blob:test";
      },
      revokeObjectURL() {},
    },
    confirmDiscardDraft: options.confirmDiscardDraft,
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

test("keeps the library readable when a newer version owns the editor draft", async (t) => {
  const savedNote = note("future", "Readable note");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes: [savedNote] },
    [STORAGE_KEYS.editorDraft]: {
      version: 2,
      ownerSessionId: "future-editor",
      generation: 2,
      contentGeneration: 3,
      draft: { body: "Do not replace" },
    },
  });
  const setup = await setupLibrary(t, [], storage);
  const { documentValue } = setup;

  assert.equal(documentValue.querySelectorAll(".note-card").length, 1);
  assert.match(documentValue.getElementById("libraryStatus").textContent, /newer extension version/u);
  documentValue.getElementById("newNoteButton").click();
  assert.equal(documentValue.getElementById("editorDialog").open, false);
  assert.equal(storage.values[STORAGE_KEYS.editorDraft].version, 2);
});

test("reenables editing after an incompatible draft is replaced", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const setup = await setupLibrary(t, [], storage);
  const { chromeApi, documentValue } = setup;
  storage.values[STORAGE_KEYS.editorDraft] = {
    version: 2,
    ownerSessionId: "future-editor",
    generation: 2,
    contentGeneration: 3,
    draft: { body: "Future draft" },
  };
  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.editorDraft]: { oldValue: undefined, newValue: storage.values[STORAGE_KEYS.editorDraft] },
  });
  documentValue.getElementById("newNoteButton").click();
  assert.equal(documentValue.getElementById("editorDialog").open, false);

  storage.values[STORAGE_KEYS.editorDraft] = {
    version: 1,
    ownerSessionId: "current-editor",
    generation: 1,
    contentGeneration: 1,
    draft: null,
  };
  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.editorDraft]: { oldValue: undefined, newValue: storage.values[STORAGE_KEYS.editorDraft] },
  });
  documentValue.getElementById("newNoteButton").click();

  assert.equal(documentValue.getElementById("editorDialog").open, true);
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
  await waitFor(() => !documentValue.getElementById("editorConflictNotice").hidden);

  assert.equal(documentValue.getElementById("editorDialog").open, true);
  assert.equal(documentValue.getElementById("editorConflictNotice").hidden, false);
  assert.equal(body.value, "Local body");
  assert.equal(storage.values[STORAGE_KEYS.state].notes[0].body, "External body");
  assert.equal(storage.values[STORAGE_KEYS.state].notes[0].updatedAt, START);

  documentValue.getElementById("saveEditorAsNewButton").click();
  await waitFor(() => controller.getState().notes.length === 2);
  assert.deepEqual(
    new Set(controller.getState().notes.map((entry) => entry.body)),
    new Set(["External body", "Local body"]),
  );
});

test("clears an editor conflict after the original note is restored", async (t) => {
  const original = note("restored", "Original body");
  const setup = await setupLibrary(t, [original]);
  const { chromeApi, controller, documentValue, storage } = setup;
  documentValue.querySelector("[data-action='edit']").click();
  const originalState = structuredClone(controller.getState());
  storage.values[STORAGE_KEYS.state] = {
    ...originalState,
    revision: 1,
    notes: [{ ...original, body: "External body" }],
  };
  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.state]: { oldValue: originalState, newValue: storage.values[STORAGE_KEYS.state] },
  });
  assert.equal(documentValue.getElementById("editorConflictNotice").hidden, false);

  storage.values[STORAGE_KEYS.state] = {
    ...originalState,
    revision: 2,
  };
  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.state]: { oldValue: undefined, newValue: storage.values[STORAGE_KEYS.state] },
  });

  assert.equal(documentValue.getElementById("editorConflictNotice").hidden, true);
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
  await waitFor(() => !documentValue.getElementById("editorDialog").open);

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
  assert.equal(documentValue.getElementById("resultSummary").textContent, "101 notes");
  assert.equal(
    documentValue.activeElement.closest("[data-note-id]"),
    documentValue.querySelectorAll("[data-note-id]")[100],
  );
});

test("suggests saved courses and labels the active date sort", async (t) => {
  const first = note("first", "First body", { course: "Physics" });
  const second = {
    ...note("second", "Second body", { course: "CS 101" }),
    updatedAt: "2026-09-20T12:00:00.000Z",
  };
  const setup = await setupLibrary(t, [first, second]);
  const { controller, documentValue } = setup;

  assert.deepEqual(
    [...documentValue.querySelectorAll("#editorCourseSuggestions option")].map((option) => option.value),
    ["CS 101", "Physics"],
  );
  assert.match(documentValue.querySelector(".note-time").textContent, /^Updated /u);

  const sort = documentValue.getElementById("sortSelect");
  sort.value = "created-desc";
  sort.dispatchEvent(new documentValue.defaultView.Event("change", { bubbles: true }));
  await waitFor(() => controller.getState().settings.sort === "created-desc");

  assert.match(documentValue.querySelector(".note-time").textContent, /^Created /u);
  assert.match(documentValue.querySelector(".note-time").title, /^Created /u);
});

test("exports only the current filtered view as Markdown", async (t) => {
  const blobs = [];
  const urlApi = {
    createObjectURL(blob) {
      blobs.push(blob);
      return "blob:test";
    },
    revokeObjectURL() {},
  };
  const setup = await setupLibrary(
    t,
    [
      note("graph", "Graph paths", { title: "Graph lecture", course: "CS 101" }),
      note("history", "Ancient history", { title: "History lecture", course: "History" }),
    ],
    null,
    { urlApi },
  );
  const { documentValue } = setup;
  documentValue.defaultView.HTMLAnchorElement.prototype.click = function click() {};
  const search = documentValue.getElementById("searchInput");
  search.value = "graph";
  search.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  await waitFor(() => documentValue.getElementById("resultSummary").textContent === "1 matching note (2 total)");

  documentValue.getElementById("exportMarkdownButton").click();
  await waitFor(() => blobs.length === 1);
  const markdown = await blobs[0].text();

  assert.match(markdown, /Graph lecture/u);
  assert.doesNotMatch(markdown, /History lecture/u);
  assert.equal(
    documentValue.getElementById("libraryStatus").textContent,
    "Exported 1 note from the current view as Markdown.",
  );

  search.value = "not present";
  search.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  await waitFor(() => documentValue.getElementById("resultSummary").textContent === "No matching notes");
  documentValue.getElementById("exportMarkdownButton").click();

  assert.equal(blobs.length, 1);
  assert.equal(documentValue.getElementById("libraryStatus").textContent, "No notes match the current view.");
});

test("shows copy feedback on the selected note", async (t) => {
  const scheduled = [];
  const copied = [];
  const setup = await setupLibrary(
    t,
    [note("copy", "Copy body")],
    null,
    {
      navigatorValue: { clipboard: { async writeText(value) { copied.push(value); } } },
      timerApi: {
        clearTimeout() {},
        setTimeout(callback) {
          scheduled.push(callback);
          return scheduled.length;
        },
      },
    },
  );
  const { documentValue } = setup;
  const button = documentValue.querySelector("[data-action='copy']");
  button.click();
  await waitFor(() => button.textContent === "Copied");

  assert.match(copied[0], /Copy body/u);
  scheduled.shift()();
  assert.equal(button.textContent, "Copy");
});

test("recovers and saves a new editor draft after reopening", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const first = await setupLibrary(t, [], storage);
  first.documentValue.getElementById("newNoteButton").click();
  first.documentValue.getElementById("editorTitle").value = "Recovered lecture";
  const body = first.documentValue.getElementById("editorBody");
  body.value = "A long unfinished explanation";
  body.dispatchEvent(new first.dom.window.Event("input", { bubbles: true }));
  await first.controller.flushEditorDraft();

  assert.equal((await loadEditorDraft(storage)).draft.body, "A long unfinished explanation");
  first.controller.destroy();
  first.dom.window.close();

  const second = await setupLibrary(t, [], storage);
  const { controller, documentValue } = second;
  assert.equal(documentValue.getElementById("editorDraftRecovery").hidden, false);
  assert.equal(documentValue.getElementById("editorDialog").open, false);
  documentValue.getElementById("resumeEditorDraftButton").click();
  await waitFor(() => documentValue.getElementById("editorDialog").open);

  assert.equal(documentValue.getElementById("editorTitle").value, "Recovered lecture");
  assert.equal(documentValue.getElementById("editorBody").value, "A long unfinished explanation");
  submit(documentValue, "editorForm");
  await waitFor(() => controller.getState().notes.length === 1);

  assert.equal(controller.getState().notes[0].body, "A long unfinished explanation");
  assert.equal((await loadEditorDraft(storage)).draft, null);
  assert.equal(documentValue.getElementById("editorDraftRecovery").hidden, true);
});

test("resumes an unchanged note edit with its original creation time", async (t) => {
  const original = note("edit-draft", "Original body");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes: [original] },
  });
  await saveEditorDraft(
    {
      noteId: original.id,
      baseRevision: 0,
      baseNote: original,
      title: original.title,
      body: "Recovered edit",
      course: original.course,
      source: original.source,
    },
    storage,
    {
      sessionId: "older-editor",
      expectedOwnerSessionId: "",
      expectedGeneration: 0,
    },
  );
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue } = setup;

  documentValue.getElementById("resumeEditorDraftButton").click();
  await waitFor(() => documentValue.getElementById("editorHeading").textContent === "Resume edit");
  submit(documentValue, "editorForm");
  await waitFor(() => controller.getState().notes[0].body === "Recovered edit");

  assert.equal(controller.getState().notes.length, 1);
  assert.equal(controller.getState().notes[0].createdAt, original.createdAt);
  assert.equal((await loadEditorDraft(storage)).draft, null);
});

test("restores recovery focus after closing a resumed draft", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  await saveEditorDraft(
    { title: "Pending", body: "Continue this", course: "", source: {} },
    storage,
    {
      sessionId: "older-editor",
      expectedOwnerSessionId: "",
      expectedGeneration: 0,
    },
  );
  const setup = await setupLibrary(t, [], storage);
  const { documentValue } = setup;
  const resume = documentValue.getElementById("resumeEditorDraftButton");
  resume.click();
  await waitFor(() => documentValue.getElementById("editorDialog").open);

  documentValue.getElementById("closeEditorButton").click();
  await waitFor(() => !documentValue.getElementById("editorDialog").open);

  assert.equal(documentValue.getElementById("editorDraftRecovery").hidden, false);
  assert.equal(documentValue.activeElement, resume);
});

test("reveals an invalid source when a recovered draft fails validation", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  await saveEditorDraft(
    {
      title: "Pending",
      body: "Continue this",
      course: "",
      source: { title: "Lecture", url: "https://" },
    },
    storage,
    {
      sessionId: "older-editor",
      expectedOwnerSessionId: "",
      expectedGeneration: 0,
    },
  );
  const setup = await setupLibrary(t, [], storage);
  const { documentValue } = setup;
  documentValue.getElementById("resumeEditorDraftButton").click();
  await waitFor(() => documentValue.getElementById("editorDialog").open);
  assert.equal(documentValue.getElementById("editorSourceDetails").open, true);

  submit(documentValue, "editorForm");
  await waitFor(() => documentValue.getElementById("editorSourceUrl").getAttribute("aria-invalid") === "true");

  assert.equal(documentValue.getElementById("editorSourceDetails").open, true);
  assert.equal(documentValue.activeElement, documentValue.getElementById("editorSourceUrl"));
});

test("recovers a stale note edit as a new note", async (t) => {
  const original = note("stale-draft", "Original body");
  const externallyChanged = { ...original, body: "External body", updatedAt: original.updatedAt };
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), revision: 1, notes: [externallyChanged] },
  });
  await saveEditorDraft(
    {
      noteId: original.id,
      baseRevision: 0,
      baseNote: original,
      title: original.title,
      body: "Local recovered body",
      course: original.course,
      source: original.source,
    },
    storage,
    {
      sessionId: "older-editor",
      expectedOwnerSessionId: "",
      expectedGeneration: 0,
    },
  );
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue } = setup;

  assert.equal(documentValue.getElementById("resumeEditorDraftButton").textContent, "Recover as new note");
  documentValue.getElementById("resumeEditorDraftButton").click();
  await waitFor(() => documentValue.getElementById("editorHeading").textContent === "Recover draft");
  submit(documentValue, "editorForm");
  await waitFor(() => controller.getState().notes.length === 2);

  assert.deepEqual(
    new Set(controller.getState().notes.map((entry) => entry.body)),
    new Set(["External body", "Local recovered body"]),
  );
  assert.equal((await loadEditorDraft(storage)).draft, null);
});

test("blocks another editor until a recovered draft is discarded", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  await saveEditorDraft(
    { title: "Pending", body: "Keep this", course: "", source: {} },
    storage,
    {
      sessionId: "older-editor",
      expectedOwnerSessionId: "",
      expectedGeneration: 0,
    },
  );
  let allowDiscard = false;
  const setup = await setupLibrary(t, [], storage, {
    confirmDiscardDraft: () => allowDiscard,
  });
  const { documentValue } = setup;

  documentValue.getElementById("newNoteButton").click();
  assert.equal(documentValue.getElementById("editorDialog").open, false);
  assert.equal(documentValue.activeElement, documentValue.getElementById("resumeEditorDraftButton"));

  documentValue.getElementById("discardEditorDraftButton").click();
  assert.notEqual((await loadEditorDraft(storage)).draft, null);
  allowDiscard = true;
  documentValue.getElementById("discardEditorDraftButton").click();
  await waitFor(() => documentValue.getElementById("editorDraftRecovery").hidden);

  assert.equal((await loadEditorDraft(storage)).draft, null);
  assert.equal(documentValue.activeElement, documentValue.getElementById("newNoteButton"));
});

test("restores focus when a recovered draft disappears", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  await saveEditorDraft(
    { title: "Pending", body: "Keep this", course: "", source: {} },
    storage,
    {
      sessionId: "older-editor",
      expectedOwnerSessionId: "",
      expectedGeneration: 0,
    },
  );
  const setup = await setupLibrary(t, [], storage);
  const { documentValue } = setup;
  delete storage.values[STORAGE_KEYS.editorDraft];

  documentValue.getElementById("resumeEditorDraftButton").click();
  await waitFor(() => documentValue.getElementById("editorDraftRecovery").hidden);

  assert.equal(documentValue.getElementById("resumeEditorDraftButton").disabled, false);
  assert.equal(documentValue.getElementById("discardEditorDraftButton").disabled, false);
  assert.equal(documentValue.activeElement, documentValue.getElementById("newNoteButton"));
});

test("returns focus after a draft changes during resume", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  await saveEditorDraft(
    { title: "Pending", body: "Keep this", course: "", source: {} },
    storage,
    {
      sessionId: "older-editor",
      expectedOwnerSessionId: "",
      expectedGeneration: 0,
    },
  );
  const setup = await setupLibrary(t, [], storage);
  const { documentValue } = setup;
  const storedGet = storage.get.bind(storage);
  const initialRecord = structuredClone(storage.values[STORAGE_KEYS.editorDraft]);
  let draftReads = 0;
  storage.get = async (keys) => {
    const names = Array.isArray(keys) ? keys : [keys];
    if (names.includes(STORAGE_KEYS.editorDraft)) {
      draftReads += 1;
      if (draftReads === 2) {
        storage.values[STORAGE_KEYS.editorDraft] = {
          ...initialRecord,
          ownerSessionId: "newer-editor",
          generation: initialRecord.generation + 1,
          draft: { ...initialRecord.draft, title: "Newer pending draft" },
        };
      }
    }
    return storedGet(keys);
  };

  documentValue.getElementById("resumeEditorDraftButton").click();
  await waitFor(() => documentValue.getElementById("editorDraftStatus").textContent.includes("changed in another"));

  assert.equal(documentValue.getElementById("resumeEditorDraftButton").disabled, false);
  assert.equal(documentValue.getElementById("discardEditorDraftButton").disabled, false);
  assert.equal(documentValue.activeElement, documentValue.getElementById("resumeEditorDraftButton"));
});

test("returns focus after discard conflicts and storage errors", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  await saveEditorDraft(
    { title: "Pending", body: "Keep this", course: "", source: {} },
    storage,
    {
      sessionId: "older-editor",
      expectedOwnerSessionId: "",
      expectedGeneration: 0,
    },
  );
  const setup = await setupLibrary(t, [], storage, { confirmDiscardDraft: () => true });
  const { documentValue } = setup;
  const initialRecord = storage.values[STORAGE_KEYS.editorDraft];
  storage.values[STORAGE_KEYS.editorDraft] = {
    ...structuredClone(initialRecord),
    ownerSessionId: "newer-editor",
    generation: initialRecord.generation + 1,
  };

  documentValue.getElementById("discardEditorDraftButton").click();
  await waitFor(() => documentValue.getElementById("editorDraftStatus").textContent.includes("changed in another"));
  assert.equal(documentValue.getElementById("discardEditorDraftButton").disabled, false);
  assert.equal(documentValue.activeElement, documentValue.getElementById("discardEditorDraftButton"));

  const storedSet = storage.set.bind(storage);
  storage.set = async () => {
    throw new Error("Storage write blocked.");
  };
  documentValue.getElementById("discardEditorDraftButton").click();
  await waitFor(() => documentValue.getElementById("editorDraftStatus").textContent.includes("Storage write blocked"));
  assert.equal(documentValue.getElementById("discardEditorDraftButton").disabled, false);
  assert.equal(documentValue.activeElement, documentValue.getElementById("discardEditorDraftButton"));
  storage.set = storedSet;
});

test("stores source-only editor work and clears a reverted draft", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue, dom } = setup;
  documentValue.getElementById("newNoteButton").click();
  const sourceUrl = documentValue.getElementById("editorSourceUrl");
  sourceUrl.value = "https://";
  sourceUrl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await controller.flushEditorDraft();

  assert.equal((await loadEditorDraft(storage)).draft.source.url, "https://");

  sourceUrl.value = "https://student:password@example.com/lesson?chapter=2&token=secret#answers";
  sourceUrl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await controller.flushEditorDraft();

  assert.equal((await loadEditorDraft(storage)).draft.source.url, "https://example.com/lesson?chapter=2");

  sourceUrl.value = "";
  sourceUrl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await controller.flushEditorDraft();

  assert.equal((await loadEditorDraft(storage)).draft, null);
});

test("pagehide keeps input newer than an in-flight draft save", async (t) => {
  const stored = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const writeStarted = deferred();
  const releaseWrite = deferred();
  let blocked = false;
  const storage = {
    values: stored.values,
    get: stored.get.bind(stored),
    remove: stored.remove.bind(stored),
    async set(update) {
      if (!blocked && Object.hasOwn(update, STORAGE_KEYS.editorDraft)) {
        blocked = true;
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      return stored.set(update);
    },
  };
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue, dom } = setup;
  documentValue.getElementById("newNoteButton").click();
  const body = documentValue.getElementById("editorBody");
  body.value = "First version";
  body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const firstFlush = controller.flushEditorDraft();
  await writeStarted.promise;

  body.value = "Latest version";
  body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  releaseWrite.resolve();
  await firstFlush;
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));

  await waitFor(() => storage.values[STORAGE_KEYS.editorDraft]?.draft?.body === "Latest version");
});

test("pagehide keeps input newer than an in-flight draft clear", async (t) => {
  const stored = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const writeStarted = deferred();
  const releaseWrite = deferred();
  let blockNextDraftWrite = false;
  const storage = {
    values: stored.values,
    get: stored.get.bind(stored),
    remove: stored.remove.bind(stored),
    async set(update) {
      if (blockNextDraftWrite && Object.hasOwn(update, STORAGE_KEYS.editorDraft)) {
        blockNextDraftWrite = false;
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      return stored.set(update);
    },
  };
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue, dom } = setup;
  documentValue.getElementById("newNoteButton").click();
  const body = documentValue.getElementById("editorBody");
  body.value = "First version";
  body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await controller.flushEditorDraft();

  blockNextDraftWrite = true;
  body.value = "";
  body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await writeStarted.promise;
  body.value = "Latest version";
  body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  releaseWrite.resolve();
  await waitFor(() => controller.getEditorDraftRecord().draft === null);
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));

  await waitFor(() => storage.values[STORAGE_KEYS.editorDraft]?.draft?.body === "Latest version");
});

test("keeps an autosaved draft when the editor closes", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const setup = await setupLibrary(t, [], storage);
  const { documentValue, dom } = setup;
  documentValue.getElementById("newNoteButton").click();
  const body = documentValue.getElementById("editorBody");
  body.value = "Continue this later";
  body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

  documentValue.getElementById("closeEditorButton").click();
  await waitFor(() => !documentValue.getElementById("editorDialog").open);

  assert.equal((await loadEditorDraft(storage)).draft.body, "Continue this later");
  assert.equal(documentValue.getElementById("editorDraftRecovery").hidden, false);
  assert.equal(documentValue.getElementById("libraryStatus").textContent, "Draft kept. Resume it when you are ready.");
});

test("closes a clean editor after another tab takes draft ownership", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const setup = await setupLibrary(t, [], storage);
  const { chromeApi, documentValue } = setup;
  documentValue.getElementById("newNoteButton").click();
  const external = await saveEditorDraft(
    { title: "Other tab", body: "Keep the other draft", course: "", source: {} },
    storage,
    {
      sessionId: "other-editor",
      expectedOwnerSessionId: "",
      expectedGeneration: 0,
    },
  );
  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.editorDraft]: { oldValue: undefined, newValue: external.record },
  });

  documentValue.getElementById("closeEditorButton").click();
  await waitFor(() => !documentValue.getElementById("editorDialog").open);

  assert.equal((await loadEditorDraft(storage)).draft.body, "Keep the other draft");
  assert.equal(documentValue.getElementById("editorDraftRecovery").hidden, false);
});

test("adopts a foreign tombstone before the next editor save", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const setup = await setupLibrary(t, [], storage);
  const { chromeApi, controller, documentValue, dom } = setup;
  documentValue.getElementById("newNoteButton").click();
  const tombstone = await clearEditorDraft(storage, {
    sessionId: "other-editor",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    contentGeneration: 1,
  });
  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.editorDraft]: { oldValue: undefined, newValue: tombstone.record },
  });

  documentValue.getElementById("closeEditorButton").click();
  await waitFor(() => !documentValue.getElementById("editorDialog").open);
  documentValue.getElementById("newNoteButton").click();
  const body = documentValue.getElementById("editorBody");
  body.value = "Saved after another tab cleared its draft";
  body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(await controller.flushEditorDraft(), true);

  assert.equal(
    (await loadEditorDraft(storage)).draft.body,
    "Saved after another tab cleared its draft",
  );
  assert.doesNotMatch(documentValue.getElementById("editorStatus").textContent, /another library tab/u);
});

test("confirms before discarding a blocked local editor", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  let allowDiscard = false;
  const setup = await setupLibrary(t, [], storage, {
    confirmDiscardDraft: () => allowDiscard,
  });
  const { chromeApi, controller, documentValue, dom } = setup;
  documentValue.getElementById("newNoteButton").click();
  const body = documentValue.getElementById("editorBody");
  body.value = "Unsaved work in this tab";
  body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const external = await saveEditorDraft(
    { title: "Other tab", body: "Keep the other draft", course: "", source: {} },
    storage,
    {
      sessionId: "other-editor",
      expectedOwnerSessionId: "",
      expectedGeneration: 0,
    },
  );
  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.editorDraft]: { oldValue: undefined, newValue: external.record },
  });
  const blockedMessage = documentValue.getElementById("editorStatus").textContent;
  storage.values[STORAGE_KEYS.state] = {
    ...structuredClone(controller.getState()),
    revision: controller.getState().revision + 1,
  };
  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.state]: { oldValue: undefined, newValue: storage.values[STORAGE_KEYS.state] },
  });
  assert.equal(documentValue.getElementById("editorStatus").textContent, blockedMessage);

  documentValue.getElementById("closeEditorButton").click();
  await waitFor(() => documentValue.getElementById("closeEditorButton").disabled === false);
  assert.equal(documentValue.getElementById("editorDialog").open, true);

  allowDiscard = true;
  documentValue.getElementById("closeEditorButton").click();
  await waitFor(() => !documentValue.getElementById("editorDialog").open);

  assert.equal((await loadEditorDraft(storage)).draft.body, "Keep the other draft");
  assert.equal(documentValue.getElementById("libraryStatus").textContent, "Editor closed. Unsaved local changes were discarded.");
});

test("keeps the editor open when its draft cannot be saved", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const setup = await setupLibrary(t, [], storage, { confirmDiscardDraft: () => false });
  const { documentValue, dom } = setup;
  documentValue.getElementById("newNoteButton").click();
  const body = documentValue.getElementById("editorBody");
  body.value = "Do not lose this work";
  body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const storedSet = storage.set.bind(storage);
  storage.set = async () => {
    throw new Error("Storage write blocked.");
  };

  documentValue.getElementById("closeEditorButton").click();
  await waitFor(() => documentValue.getElementById("editorStatus").textContent.includes("copy your work"));

  assert.equal(documentValue.getElementById("editorDialog").open, true);
  assert.equal(documentValue.getElementById("closeEditorButton").disabled, false);
  assert.equal(documentValue.getElementById("editorForm").inert, false);
  storage.set = storedSet;
});
