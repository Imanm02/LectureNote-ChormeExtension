import assert from "node:assert/strict";
import test from "node:test";

import { serializeBackup } from "../src/backup.js";
import { addNote, createEmptyState, createNote, LIMITS, moveNoteToTrash } from "../src/model.js";
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
  if (options.runtime) {
    chromeApi.runtime = options.runtime;
  }
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
    "includeSourceOnShare",
    "clearLocalDataButton",
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

test("rejects a library read when data resets without a storage event", async (t) => {
  const stored = memoryStorage({
    [STORAGE_KEYS.dataEpoch]: "epoch-before-reset",
    [STORAGE_KEYS.state]: {
      ...createEmptyState(),
      notes: [note("stale", "This old note must not load")],
    },
  });
  let resetDuringStateRead = false;
  const storage = {
    values: stored.values,
    async get(keys) {
      const result = await stored.get(keys);
      const names = Array.isArray(keys) ? keys : [keys];
      if (!resetDuringStateRead && names.includes(STORAGE_KEYS.state)) {
        resetDuringStateRead = true;
        stored.values[STORAGE_KEYS.dataEpoch] = "epoch-after-reset";
        stored.values[STORAGE_KEYS.state] = createEmptyState();
      }
      return result;
    },
    set: stored.set.bind(stored),
    remove: stored.remove.bind(stored),
  };
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue } = setup;

  assert.equal(controller.getState(), undefined);
  assert.equal(documentValue.querySelectorAll(".note-card").length, 0);
  assert.equal(documentValue.getElementById("resultSummary").textContent, "Reload required");
  assert.equal(documentValue.getElementById("retryLoadButton").textContent, "Reload page");
  assert.match(documentValue.getElementById("libraryStatus").textContent, /reset in another window/u);
  assert.deepEqual(storage.values[STORAGE_KEYS.state], createEmptyState());
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
  assert.equal(controller.getState().trash.length, 1);

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
  assert.equal(controller.getState().trash.length, 1);
});

test("restores and permanently deletes notes from the persistent Trash view", async (t) => {
  const setup = await setupLibrary(t, [note("first", "Saved body")]);
  const { controller, documentValue } = setup;

  documentValue.querySelector("[data-action='delete']").click();
  submit(documentValue, "deleteForm");
  await waitFor(() => controller.getState().trash.length === 1);

  assert.equal(documentValue.getElementById("trashNoteCount").textContent, "1");
  documentValue.getElementById("trashViewButton").click();
  assert.match(documentValue.querySelector(".note-time").textContent, /^Deleted /u);
  documentValue.querySelector("[data-action='restore']").click();
  await waitFor(() => controller.getState().notes.length === 1);
  assert.equal(controller.getState().trash.length, 0);

  documentValue.getElementById("notesViewButton").click();
  documentValue.querySelector("[data-action='delete']").click();
  submit(documentValue, "deleteForm");
  await waitFor(() => controller.getState().trash.length === 1);
  documentValue.getElementById("trashViewButton").click();
  documentValue.querySelector("[data-action='permanent-delete']").click();
  assert.equal(documentValue.getElementById("permanentDeleteDialog").open, true);
  submit(documentValue, "permanentDeleteForm");
  await waitFor(() => controller.getState().trash.length === 0);

  assert.equal(documentValue.getElementById("resultSummary").textContent, "Trash is empty");
  assert.equal(documentValue.querySelector("[data-action='restore']"), null);
});

test("empties Trash only after confirmation", async (t) => {
  let state = { ...createEmptyState(), notes: [note("first", "First"), note("second", "Second")] };
  state = moveNoteToTrash(state, "first", { now: START }).state;
  state = moveNoteToTrash(state, "second", { now: START }).state;
  const storage = memoryStorage({ [STORAGE_KEYS.state]: state });
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue } = setup;

  documentValue.getElementById("trashViewButton").click();
  documentValue.getElementById("emptyTrashButton").click();
  assert.equal(documentValue.getElementById("emptyTrashDialog").open, true);
  assert.match(documentValue.getElementById("emptyTrashMessage").textContent, /2 notes/u);
  submit(documentValue, "emptyTrashForm");
  await waitFor(() => controller.getState().trash.length === 0);

  assert.equal(documentValue.getElementById("emptyTrashButton").disabled, true);
  assert.match(documentValue.getElementById("libraryStatus").textContent, /2 notes permanently deleted/u);
});

test("does not permanently delete a Trash entry restored in another window", async (t) => {
  const original = note("first", "First");
  const trashed = moveNoteToTrash({ ...createEmptyState(), notes: [original] }, "first", {
    now: START,
  }).state;
  const storage = memoryStorage({ [STORAGE_KEYS.state]: trashed });
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue } = setup;

  documentValue.getElementById("trashViewButton").click();
  documentValue.querySelector("[data-action='permanent-delete']").click();
  storage.values[STORAGE_KEYS.state] = {
    ...trashed,
    revision: trashed.revision + 1,
    notes: [original],
    trash: [],
  };
  submit(documentValue, "permanentDeleteForm");
  await waitFor(() => documentValue.getElementById("permanentDeleteStatus").textContent.length > 0);

  assert.match(documentValue.getElementById("permanentDeleteStatus").textContent, /another window/u);
  assert.equal(documentValue.getElementById("permanentDeleteDialog").open, true);
  assert.equal(storage.values[STORAGE_KEYS.state].notes[0].id, "first");
  assert.equal(controller.getState().trash.length, 1);
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

test("previews restore effects before merging a colliding note", async (t) => {
  const current = {
    ...createEmptyState(),
    notes: [note("same-id", "Current body")],
    settings: { theme: "light", sort: "created-desc", includeSourceOnShare: true },
  };
  const storage = memoryStorage({ [STORAGE_KEYS.state]: current });
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue } = setup;
  const imported = {
    ...createEmptyState(),
    notes: [note("same-id", "Imported body")],
    settings: { theme: "dark", sort: "title-asc", includeSourceOnShare: false },
  };
  const backupText = serializeBackup(imported, { now: START });
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

  assert.equal(documentValue.getElementById("importSchemaVersion").textContent, "2");
  assert.equal(documentValue.getElementById("importExportedAt").title, START);
  assert.match(documentValue.getElementById("importMessage").textContent, /1 active note and 0 Trash entries/u);
  assert.match(documentValue.getElementById("mergePreviewMessage").textContent, /1 colliding note ID will be changed/u);
  assert.match(documentValue.getElementById("mergePreviewMessage").textContent, /result will have 2 active notes/u);
  assert.match(documentValue.getElementById("replacePreviewMessage").textContent, /remove 1 current active note/u);
  assert.match(
    documentValue.getElementById("replaceSettingsMessage").textContent,
    /change the theme from Light to Dark and sorting from Newest created to Title/u,
  );
  assert.match(
    documentValue.getElementById("replaceSettingsMessage").textContent,
    /change to exclude source details/u,
  );
  assert.equal(documentValue.getElementById("mergeImportButton").disabled, false);

  documentValue.getElementById("mergeImportButton").click();
  await waitFor(() => controller.getState().notes.length === 2);

  assert.deepEqual(
    controller.getState().notes.map((entry) => entry.id),
    ["same-id_import_1", "same-id"],
  );
  assert.deepEqual(controller.getState().settings, current.settings);
  assert.match(documentValue.getElementById("libraryStatus").textContent, /Restored 1 active note/u);
});

test("does not replace notes saved after the confirmation opened", async (t) => {
  const current = { ...createEmptyState(), notes: [note("current", "Current body")] };
  const storage = memoryStorage({ [STORAGE_KEYS.state]: current });
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue } = setup;
  const imported = {
    ...createEmptyState(),
    notes: [note("imported", "Imported body")],
  };
  const backupText = serializeBackup(imported, { now: START });
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

  storage.values[STORAGE_KEYS.state] = addNote(
    storage.values[STORAGE_KEYS.state],
    {
      title: "New in another window",
      body: "This note must survive the stale confirmation.",
      course: "CS 101",
      source: {},
    },
    { idFactory: () => "external", now: START },
  ).state;
  submit(documentValue, "replaceForm");
  await waitFor(() => documentValue.getElementById("importDialog").open);

  assert.equal(documentValue.getElementById("replaceDialog").open, false);
  assert.deepEqual(
    controller.getState().notes.map((entry) => entry.id),
    ["external", "current"],
  );
  assert.deepEqual(
    storage.values[STORAGE_KEYS.state].notes.map((entry) => entry.id),
    ["external", "current"],
  );
  assert.match(documentValue.getElementById("importStatus").textContent, /changed in another window/u);
  assert.match(documentValue.getElementById("replacePreviewMessage").textContent, /remove 2 current active notes/u);

  documentValue.getElementById("replaceImportButton").click();
  submit(documentValue, "replaceForm");
  await waitFor(() => controller.getState().notes[0]?.id === "imported");
  assert.deepEqual(controller.getState().notes.map((entry) => entry.id), ["imported"]);
});

test("shows exact recovery counts and clears them after acknowledgment", async (t) => {
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.recovery]: {
      createdAt: START,
      rejectedNotes: 2,
      rejectedDrafts: 3,
    },
  });
  const setup = await setupLibrary(t, [], storage);
  const { documentValue } = setup;

  assert.equal(documentValue.getElementById("recoveryNotice").hidden, false);
  assert.match(
    documentValue.getElementById("recoveryMessage").textContent,
    /discarded 2 invalid notes and 3 invalid drafts/u,
  );

  documentValue.getElementById("acknowledgeRecoveryButton").click();
  await waitFor(() => storage.values[STORAGE_KEYS.recovery] === undefined);

  assert.equal(documentValue.getElementById("recoveryNotice").hidden, true);
  assert.equal(documentValue.getElementById("libraryStatus").textContent, "Recovery notice acknowledged.");
});

test("keeps newer recovery counts when an old notice is acknowledged", async (t) => {
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.recovery]: {
      createdAt: START,
      rejectedNotes: 1,
      rejectedDrafts: 0,
    },
  });
  const setup = await setupLibrary(t, [], storage);
  const { documentValue } = setup;
  storage.values[STORAGE_KEYS.recovery] = {
    createdAt: "2026-09-20T11:00:00.000Z",
    rejectedNotes: 2,
    rejectedDrafts: 1,
  };

  documentValue.getElementById("acknowledgeRecoveryButton").click();
  await waitFor(() => /More recovery information/u.test(
    documentValue.getElementById("recoveryStatus").textContent,
  ));

  assert.deepEqual(storage.values[STORAGE_KEYS.recovery], {
    createdAt: "2026-09-20T11:00:00.000Z",
    rejectedNotes: 2,
    rejectedDrafts: 1,
  });
  assert.match(documentValue.getElementById("recoveryMessage").textContent, /2 invalid notes and 1 invalid draft/u);
  assert.equal(documentValue.getElementById("recoveryNotice").hidden, false);
  assert.equal(documentValue.activeElement.id, "acknowledgeRecoveryButton");
});

test("shows storage use and warns near a configured count limit", async (t) => {
  const notes = Array.from({ length: 1_600 }, (_, index) =>
    note(`usage-${index}`, `Body ${index}`),
  );
  const setup = await setupLibrary(t, notes);
  const { documentValue } = setup;

  assert.equal(documentValue.getElementById("storageUsage").dataset.level, "warning");
  assert.match(
    documentValue.getElementById("storageUsageText").textContent,
    /1,600 of 2,000 active notes/u,
  );
  assert.equal(documentValue.getElementById("storageUsageWarning").hidden, false);
  assert.match(documentValue.getElementById("storageUsageWarning").textContent, /nearing/u);
  assert.equal(Number(documentValue.getElementById("storageUsageMeter").max), LIMITS.localStorageBytes);
});

test("reports small library sizes without rounding them to zero", async (t) => {
  const setup = await setupLibrary(t, []);
  const text = setup.documentValue.getElementById("storageUsageText").textContent;

  assert.match(text, /^At least \d+ B of 10 MB used\./u);
  assert.doesNotMatch(text, /^0 MB/u);
});

test("reports total local storage use against the Chrome quota", async (t) => {
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes: [note("measured", "Saved body")] },
  });
  const requestedKeys = [];
  storage.getBytesInUse = async (keys) => {
    requestedKeys.push(keys);
    return 2_621_440;
  };
  const setup = await setupLibrary(t, [], storage);
  const { documentValue } = setup;
  await waitFor(() => /^2\.5 MB of 10 MB used\./u.test(
    documentValue.getElementById("storageUsageText").textContent,
  ));

  assert.deepEqual(requestedKeys, [null]);
  assert.equal(Number(documentValue.getElementById("storageUsageMeter").value), 2_621_440);
  assert.equal(Number(documentValue.getElementById("storageUsageMeter").max), 10_485_760);
  assert.match(documentValue.getElementById("storageUsageText").textContent, /note library record uses \d+ B of 6\.68 MB/u);
  assert.match(documentValue.getElementById("storageUsageText").textContent, /1 of 2,000 active notes/u);
});

test("falls back to state bytes when total storage cannot be measured", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  storage.getBytesInUse = async () => {
    throw new Error("Usage unavailable");
  };
  const setup = await setupLibrary(t, [], storage);
  const { documentValue } = setup;
  await waitFor(() => /^At least \d+ B of 10 MB used\./u.test(
    documentValue.getElementById("storageUsageText").textContent,
  ));

  assert.equal(Number(documentValue.getElementById("storageUsageMeter").max), LIMITS.localStorageBytes);
  assert.equal(documentValue.getElementById("storageUsageWarning").hidden, true);
});

test("keeps the newest storage measurement after draft and capture changes", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const requests = [];
  storage.getBytesInUse = () => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  };
  const setup = await setupLibrary(t, [], storage);
  const { chromeApi, documentValue } = setup;
  const initialRequestCount = requests.length;

  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.draft]: { oldValue: undefined, newValue: { draft: { body: "Saved" } } },
  });
  await waitFor(() => requests.length === initialRequestCount + 1);
  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.pendingCaptures]: { oldValue: undefined, newValue: { captures: [] } },
  });
  await waitFor(() => requests.length === initialRequestCount + 2);

  const latestRequest = requests.at(-1);
  latestRequest.resolve(3_145_728);
  await waitFor(() => /^3 MB of 10 MB used\./u.test(
    documentValue.getElementById("storageUsageText").textContent,
  ));
  for (const request of requests.slice(0, -1).reverse()) {
    request.resolve(9_437_184);
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

  assert.match(documentValue.getElementById("storageUsageText").textContent, /^3 MB of 10 MB used\./u);
  assert.equal(Number(documentValue.getElementById("storageUsageMeter").value), 3_145_728);
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

test("selects every filtered note without rendering every card", async (t) => {
  const notes = Array.from({ length: 102 }, (_, index) =>
    note(`note-${index}`, `Body ${index}`, {
      course: index === 101 ? "History" : "Physics",
    }),
  );
  const setup = await setupLibrary(t, notes);
  const { documentValue } = setup;
  const course = documentValue.getElementById("courseFilter");
  course.value = "Physics";
  course.dispatchEvent(new documentValue.defaultView.Event("change", { bubbles: true }));

  documentValue.getElementById("selectionModeButton").click();
  assert.equal(documentValue.getElementById("selectionToolbar").hidden, false);
  assert.equal(documentValue.querySelectorAll(".note-select-checkbox").length, 100);
  assert.match(
    documentValue.querySelector(".note-select-checkbox").getAttribute("aria-label"),
    /^Select Note /u,
  );
  assert.equal(documentValue.activeElement.classList.contains("note-select-checkbox"), true);

  documentValue.getElementById("selectAllFilteredButton").click();

  assert.equal(documentValue.getElementById("selectionCount").textContent, "101 notes selected");
  assert.equal(documentValue.querySelectorAll(".note-select-checkbox:checked").length, 100);
  assert.equal(documentValue.activeElement, documentValue.getElementById("clearSelectionButton"));

  documentValue.getElementById("showMoreButton").click();
  assert.equal(documentValue.querySelectorAll(".note-select-checkbox").length, 101);
  assert.equal(documentValue.activeElement.classList.contains("note-select-checkbox"), true);
  assert.equal(
    documentValue.activeElement.closest("[data-note-id]"),
    documentValue.querySelectorAll("[data-note-id]")[100],
  );

  documentValue.getElementById("cancelSelectionButton").click();
  assert.equal(documentValue.getElementById("selectionToolbar").hidden, true);
  assert.equal(documentValue.activeElement, documentValue.getElementById("selectionModeButton"));
  assert.equal(documentValue.querySelector(".note-selection").hidden, true);
});

test("sets and clears one course for selected notes in one revision", async (t) => {
  const setup = await setupLibrary(t, [
    note("first", "First body", { course: "Physics" }),
    note("second", "Second body", { course: "Math" }),
    note("third", "Third body", { course: "History" }),
  ]);
  const { controller, documentValue } = setup;
  documentValue.getElementById("selectionModeButton").click();
  for (const identifier of ["first", "second"]) {
    const checkbox = documentValue.querySelector(`[data-note-id='${identifier}'] .note-select-checkbox`);
    checkbox.checked = true;
    checkbox.dispatchEvent(new documentValue.defaultView.Event("change", { bubbles: true }));
  }

  const initialRevision = controller.getState().revision;
  documentValue.getElementById("bulkCourseButton").click();
  assert.equal(documentValue.getElementById("bulkCourseDialog").open, true);
  documentValue.getElementById("bulkCourseInput").value = "Data Science";
  submit(documentValue, "bulkCourseForm");
  await waitFor(() => controller.getState().revision === initialRevision + 1);

  assert.deepEqual(
    controller.getState().notes.map((entry) => [entry.id, entry.course]),
    [
      ["first", "Data Science"],
      ["second", "Data Science"],
      ["third", "History"],
    ],
  );
  assert.equal(documentValue.getElementById("selectionCount").textContent, "2 notes selected");

  documentValue.getElementById("bulkCourseButton").click();
  documentValue.getElementById("clearBulkCourseButton").click();
  await waitFor(() => controller.getState().revision === initialRevision + 2);

  assert.deepEqual(
    controller.getState().notes.map((entry) => [entry.id, entry.course]),
    [
      ["first", ""],
      ["second", ""],
      ["third", "History"],
    ],
  );
});

test("keeps selection focus stable when a bulk course change prunes results", async (t) => {
  const setup = await setupLibrary(t, [
    note("physics", "First body", { title: "First", course: "Quantum Mechanics" }),
    note("math", "Second body", { title: "Second", course: "Math" }),
  ]);
  const { controller, documentValue } = setup;
  const search = documentValue.getElementById("searchInput");
  search.value = "Quantum";
  search.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  await waitFor(() => documentValue.querySelectorAll(".note-card").length === 1);

  documentValue.getElementById("selectionModeButton").click();
  const checkbox = documentValue.querySelector(".note-select-checkbox");
  checkbox.checked = true;
  checkbox.dispatchEvent(new documentValue.defaultView.Event("change", { bubbles: true }));
  const initialRevision = controller.getState().revision;
  documentValue.getElementById("bulkCourseButton").click();
  documentValue.getElementById("bulkCourseInput").value = "Math";
  submit(documentValue, "bulkCourseForm");
  await waitFor(() => controller.getState().revision === initialRevision + 1);

  assert.equal(documentValue.getElementById("selectionCount").textContent, "0 notes selected");
  assert.equal(documentValue.getElementById("bulkCourseButton").disabled, true);
  assert.equal(documentValue.activeElement, documentValue.getElementById("cancelSelectionButton"));
});

test("moves focus when a pending search clears a bulk selection", async (t) => {
  const setup = await setupLibrary(t, [
    note("first", "First body"),
    note("second", "Second body"),
  ]);
  const { documentValue } = setup;
  documentValue.getElementById("selectionModeButton").click();
  const checkbox = documentValue.querySelector("[data-note-id='first'] .note-select-checkbox");
  checkbox.checked = true;
  checkbox.dispatchEvent(new documentValue.defaultView.Event("change", { bubbles: true }));

  const search = documentValue.getElementById("searchInput");
  search.value = "No matching lecture";
  search.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  const bulkCourse = documentValue.getElementById("bulkCourseButton");
  bulkCourse.focus();
  bulkCourse.click();

  assert.equal(documentValue.getElementById("selectionCount").textContent, "0 notes selected");
  assert.equal(bulkCourse.disabled, true);
  assert.equal(documentValue.activeElement, documentValue.getElementById("cancelSelectionButton"));
  await waitFor(() => documentValue.getElementById("noResultsState").hidden === false);
  assert.equal(documentValue.activeElement, documentValue.getElementById("cancelSelectionButton"));
});

test("moves selected notes to Trash with one confirmed mutation", async (t) => {
  const setup = await setupLibrary(t, [
    note("first", "First body"),
    note("second", "Second body"),
    note("third", "Third body"),
  ]);
  const { controller, documentValue } = setup;
  documentValue.getElementById("selectionModeButton").click();
  for (const identifier of ["first", "second"]) {
    const checkbox = documentValue.querySelector(`[data-note-id='${identifier}'] .note-select-checkbox`);
    checkbox.checked = true;
    checkbox.dispatchEvent(new documentValue.defaultView.Event("change", { bubbles: true }));
  }
  const initialRevision = controller.getState().revision;

  documentValue.getElementById("bulkTrashButton").click();
  assert.equal(documentValue.getElementById("bulkConfirmDialog").open, true);
  submit(documentValue, "bulkConfirmForm");
  await waitFor(() => controller.getState().trash.length === 2);

  assert.equal(controller.getState().revision, initialRevision + 1);
  assert.deepEqual(controller.getState().notes.map((entry) => entry.id), ["third"]);
  assert.deepEqual(controller.getState().trash.map((entry) => entry.note.id), ["first", "second"]);
  assert.equal(documentValue.getElementById("selectionToolbar").hidden, true);
  assert.equal(documentValue.activeElement, documentValue.getElementById("selectionModeButton"));
});

test("stops a bulk Trash action when a selected note changed", async (t) => {
  const original = note("first", "Original body");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes: [original, note("second", "Second body")] },
  });
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue } = setup;
  documentValue.getElementById("selectionModeButton").click();
  const checkbox = documentValue.querySelector("[data-note-id='first'] .note-select-checkbox");
  checkbox.checked = true;
  checkbox.dispatchEvent(new documentValue.defaultView.Event("change", { bubbles: true }));
  documentValue.getElementById("bulkTrashButton").click();

  storage.values[STORAGE_KEYS.state] = {
    ...structuredClone(controller.getState()),
    revision: controller.getState().revision + 1,
    notes: [
      { ...structuredClone(original), body: "Changed elsewhere" },
      structuredClone(controller.getState().notes.find((entry) => entry.id === "second")),
    ],
  };
  submit(documentValue, "bulkConfirmForm");
  await waitFor(() => documentValue.getElementById("bulkConfirmStatus").textContent.includes("changed in another window"));

  assert.equal(documentValue.getElementById("bulkConfirmDialog").open, true);
  assert.equal(storage.values[STORAGE_KEYS.state].trash.length, 0);
  assert.equal(storage.values[STORAGE_KEYS.state].notes[0].body, "Changed elsewhere");
});

test("restores and permanently deletes selected Trash entries", async (t) => {
  let state = {
    ...createEmptyState(),
    notes: [
      note("first", "First body"),
      note("second", "Second body"),
      note("third", "Third body"),
    ],
  };
  state = moveNoteToTrash(state, "first", { now: START }).state;
  state = moveNoteToTrash(state, "second", { now: START }).state;
  state = moveNoteToTrash(state, "third", { now: START }).state;
  const setup = await setupLibrary(
    t,
    [],
    memoryStorage({ [STORAGE_KEYS.state]: state }),
  );
  const { controller, documentValue } = setup;
  documentValue.getElementById("trashViewButton").click();
  documentValue.getElementById("selectionModeButton").click();
  for (const identifier of ["first", "second"]) {
    const checkbox = documentValue.querySelector(`[data-note-id='${identifier}'] .note-select-checkbox`);
    checkbox.checked = true;
    checkbox.dispatchEvent(new documentValue.defaultView.Event("change", { bubbles: true }));
  }
  const initialRevision = controller.getState().revision;
  documentValue.getElementById("bulkRestoreButton").click();
  await waitFor(() => controller.getState().notes.length === 2);

  assert.equal(controller.getState().revision, initialRevision + 1);
  assert.deepEqual(controller.getState().notes.map((entry) => entry.id), ["first", "second"]);
  assert.deepEqual(controller.getState().trash.map((entry) => entry.note.id), ["third"]);

  documentValue.getElementById("selectionModeButton").click();
  const remaining = documentValue.querySelector("[data-note-id='third'] .note-select-checkbox");
  remaining.checked = true;
  remaining.dispatchEvent(new documentValue.defaultView.Event("change", { bubbles: true }));
  documentValue.getElementById("bulkPermanentDeleteButton").click();
  assert.match(documentValue.getElementById("bulkConfirmWarning").textContent, /cannot be undone/u);
  submit(documentValue, "bulkConfirmForm");
  await waitFor(() => controller.getState().trash.length === 0);

  assert.equal(controller.getState().revision, initialRevision + 2);
  assert.equal(documentValue.getElementById("resultSummary").textContent, "Trash is empty");
});

test("exports only notes chosen in selection mode", async (t) => {
  const blobs = [];
  const setup = await setupLibrary(
    t,
    [
      note("first", "First body", { title: "First lecture" }),
      note("second", "Second body", { title: "Second lecture" }),
    ],
    null,
    {
      urlApi: {
        createObjectURL(blob) {
          blobs.push(blob);
          return "blob:test";
        },
        revokeObjectURL() {},
      },
    },
  );
  const { documentValue } = setup;
  documentValue.defaultView.HTMLAnchorElement.prototype.click = function click() {};
  documentValue.getElementById("selectionModeButton").click();
  const checkbox = documentValue.querySelector("[data-note-id='second'] .note-select-checkbox");
  checkbox.checked = true;
  checkbox.dispatchEvent(new documentValue.defaultView.Event("change", { bubbles: true }));
  documentValue.getElementById("bulkExportButton").click();
  await waitFor(() => blobs.length === 1);

  const markdown = await blobs[0].text();
  assert.match(markdown, /Second lecture/u);
  assert.doesNotMatch(markdown, /First lecture/u);
  assert.equal(
    documentValue.getElementById("libraryStatus").textContent,
    "Exported 1 selected note as Markdown.",
  );
});

test("blocks selected export when a saved note changed elsewhere", async (t) => {
  const blobs = [];
  const original = note("selected", "Original body", { title: "Selected lecture" });
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes: [original] },
  });
  const setup = await setupLibrary(t, [], storage, {
    urlApi: {
      createObjectURL(blob) {
        blobs.push(blob);
        return "blob:selected-conflict";
      },
      revokeObjectURL() {},
    },
  });
  const { controller, documentValue } = setup;
  documentValue.defaultView.HTMLAnchorElement.prototype.click = function click() {};
  documentValue.getElementById("selectionModeButton").click();
  const checkbox = documentValue.querySelector("[data-note-id='selected'] .note-select-checkbox");
  checkbox.checked = true;
  checkbox.dispatchEvent(new documentValue.defaultView.Event("change", { bubbles: true }));

  storage.values[STORAGE_KEYS.state] = {
    ...storage.values[STORAGE_KEYS.state],
    revision: storage.values[STORAGE_KEYS.state].revision + 1,
    notes: [{
      ...original,
      body: "Body saved in another tab",
      updatedAt: "2026-09-20T11:00:00.000Z",
    }],
  };
  documentValue.getElementById("bulkExportButton").click();
  await waitFor(() => documentValue.getElementById("libraryStatus").textContent.includes("changed in another window"));

  assert.equal(blobs.length, 0);
  assert.equal(controller.getState().notes[0].body, "Body saved in another tab");
  assert.equal(
    documentValue.querySelector("[data-note-id='selected'] .note-select-checkbox").checked,
    true,
  );
});

test("reviews exact reset counts and offers a backup before canceling", async (t) => {
  const active = note("active", "Active body", { title: "Active lecture" });
  const deleted = note("deleted", "Deleted body", { title: "Deleted lecture" });
  const initialState = moveNoteToTrash(
    { ...createEmptyState(), notes: [active, deleted] },
    deleted.id,
    { now: START },
  ).state;
  const storage = memoryStorage({ [STORAGE_KEYS.state]: initialState });
  const blobs = [];
  const setup = await setupLibrary(t, [], storage, {
    urlApi: {
      createObjectURL(blob) {
        blobs.push(blob);
        return "blob:reset-backup";
      },
      revokeObjectURL() {},
    },
  });
  const { controller, documentValue } = setup;
  documentValue.defaultView.HTMLAnchorElement.prototype.click = function click() {};

  documentValue.getElementById("clearLocalDataButton").click();
  const dialog = documentValue.getElementById("resetDialog");
  const confirmation = documentValue.getElementById("resetConfirmationInput");
  const confirm = documentValue.getElementById("confirmResetButton");
  assert.equal(dialog.open, true);
  assert.equal(dialog.getAttribute("aria-labelledby"), "resetHeading");
  assert.match(dialog.getAttribute("aria-describedby"), /resetConfirmationHint/u);
  assert.equal(documentValue.activeElement, documentValue.getElementById("cancelResetButton"));
  assert.equal(
    documentValue.getElementById("resetMessage").textContent,
    "This will clear 1 active note and 1 Trash entry from this Chrome profile.",
  );
  assert.match(documentValue.getElementById("resetWarning").textContent, /pending captures/u);
  assert.equal(confirm.disabled, true);

  confirmation.value = "delete";
  confirmation.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  assert.equal(confirm.disabled, true);
  confirmation.value = "DELETE";
  confirmation.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  assert.equal(confirm.disabled, false);

  documentValue.getElementById("resetExportButton").click();
  await waitFor(() => blobs.length === 1);
  const backup = JSON.parse(await blobs[0].text());
  assert.equal(backup.notes.length, 1);
  assert.equal(backup.trash.length, 1);
  assert.match(documentValue.getElementById("resetStatus").textContent, /remains available/u);

  documentValue.getElementById("cancelResetButton").click();
  assert.equal(dialog.open, false);
  assert.equal(controller.getState().notes.length, 1);
  assert.equal(controller.getState().trash.length, 1);
  assert.equal(storage.values[STORAGE_KEYS.state].revision, initialState.revision);
});

test("exports the latest saved data from the reset review", async (t) => {
  const original = note("original", "Original body");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes: [original] },
  });
  const blobs = [];
  const setup = await setupLibrary(t, [], storage, {
    urlApi: {
      createObjectURL(blob) {
        blobs.push(blob);
        return "blob:fresh-reset-backup";
      },
      revokeObjectURL() {},
    },
  });
  const { controller, documentValue } = setup;
  documentValue.defaultView.HTMLAnchorElement.prototype.click = function click() {};
  documentValue.getElementById("clearLocalDataButton").click();
  const confirmation = documentValue.getElementById("resetConfirmationInput");
  confirmation.value = "DELETE";
  confirmation.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));

  storage.values[STORAGE_KEYS.state] = addNote(
    storage.values[STORAGE_KEYS.state],
    { title: "Latest lecture", body: "Saved elsewhere" },
    { idFactory: () => "latest", now: "2026-09-20T11:00:00.000Z" },
  ).state;
  documentValue.getElementById("resetExportButton").click();
  await waitFor(() => blobs.length === 1);

  const backup = JSON.parse(await blobs[0].text());
  assert.deepEqual(backup.notes.map((entry) => entry.id), ["latest", "original"]);
  assert.equal(controller.getState().notes.length, 2);
  assert.equal(confirmation.value, "");
  assert.equal(documentValue.getElementById("confirmResetButton").disabled, true);
  assert.equal(
    documentValue.getElementById("resetMessage").textContent,
    "This will clear 2 active notes and 0 Trash entries from this Chrome profile.",
  );
  assert.match(documentValue.getElementById("resetStatus").textContent, /latest saved data/u);
});

test("does not clear data while a requested reset backup is pending", async (t) => {
  const original = note("backup-before-reset", "Keep this in the backup");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes: [original] },
  });
  const blobs = [];
  const setup = await setupLibrary(t, [], storage, {
    urlApi: {
      createObjectURL(blob) {
        blobs.push(blob);
        return "blob:pending-reset-backup";
      },
      revokeObjectURL() {},
    },
  });
  const { documentValue } = setup;
  documentValue.defaultView.HTMLAnchorElement.prototype.click = function click() {};
  const originalGet = storage.get.bind(storage);
  const stateRead = deferred();
  let holdStateRead = false;
  let stateReadStarted = false;
  storage.get = async (keys) => {
    const names = Array.isArray(keys) ? keys : [keys];
    if (holdStateRead && names.includes(STORAGE_KEYS.state)) {
      holdStateRead = false;
      stateReadStarted = true;
      await stateRead.promise;
    }
    return originalGet(keys);
  };
  t.after(() => stateRead.resolve());

  documentValue.getElementById("clearLocalDataButton").click();
  const confirmation = documentValue.getElementById("resetConfirmationInput");
  confirmation.value = "DELETE";
  confirmation.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  holdStateRead = true;
  documentValue.getElementById("resetExportButton").click();
  await waitFor(() => stateReadStarted);

  assert.equal(documentValue.getElementById("resetExportButton").disabled, true);
  assert.equal(documentValue.getElementById("cancelResetButton").disabled, true);
  assert.equal(documentValue.getElementById("confirmResetButton").disabled, true);
  assert.equal(confirmation.disabled, true);
  submit(documentValue, "resetForm");
  assert.equal(storage.values[STORAGE_KEYS.state].notes.length, 1);

  stateRead.resolve();
  await waitFor(() => blobs.length === 1);
  await waitFor(() => documentValue.getElementById("confirmResetButton").disabled === false);
  const backup = JSON.parse(await blobs[0].text());
  assert.deepEqual(backup.notes.map((entry) => entry.id), [original.id]);

  submit(documentValue, "resetForm");
  await waitFor(() => storage.values[STORAGE_KEYS.state].notes.length === 0);
});

test("stops reset backup when the saved data epoch changed", async (t) => {
  const storage = memoryStorage({
    [STORAGE_KEYS.dataEpoch]: "reset-export-before",
    [STORAGE_KEYS.state]: {
      ...createEmptyState(),
      notes: [note("before-reset", "Old saved body")],
    },
  });
  const blobs = [];
  const setup = await setupLibrary(t, [], storage, {
    urlApi: {
      createObjectURL(blob) {
        blobs.push(blob);
        return "blob:must-not-export";
      },
      revokeObjectURL() {},
    },
  });
  const { documentValue } = setup;
  documentValue.defaultView.HTMLAnchorElement.prototype.click = function click() {};
  documentValue.getElementById("clearLocalDataButton").click();

  storage.values[STORAGE_KEYS.dataEpoch] = "reset-export-after";
  storage.values[STORAGE_KEYS.state] = createEmptyState();
  documentValue.getElementById("resetExportButton").click();
  await waitFor(() => documentValue.getElementById("resetDialog").open === false);

  assert.equal(blobs.length, 0);
  assert.equal(documentValue.getElementById("resultSummary").textContent, "Reload required");
  assert.match(documentValue.getElementById("libraryStatus").textContent, /reset in another window/u);
  assert.equal(documentValue.activeElement, documentValue.getElementById("retryLoadButton"));
});

test("clears local data and keeps the current library ready", async (t) => {
  const initialState = {
    ...createEmptyState(),
    revision: 4,
    notes: [note("saved", "Saved body")],
    settings: {
      ...createEmptyState().settings,
      theme: "dark",
      sort: "title-asc",
    },
  };
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: initialState,
    [STORAGE_KEYS.dataEpoch]: "reset-ui-before",
    [STORAGE_KEYS.pendingCaptures]: { version: 1, captures: [] },
    [STORAGE_KEYS.recovery]: { createdAt: START, rejectedNotes: 1, rejectedDrafts: 0 },
    [STORAGE_KEYS.helpSeen]: true,
  });
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue } = setup;

  documentValue.getElementById("clearLocalDataButton").click();
  const confirmation = documentValue.getElementById("resetConfirmationInput");
  confirmation.value = "DELETE";
  confirmation.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  submit(documentValue, "resetForm");
  await waitFor(() => controller.getState().notes.length === 0);

  assert.equal(documentValue.getElementById("resetDialog").open, false);
  assert.equal(controller.getState().revision, 5);
  assert.equal(controller.getState().trash.length, 0);
  assert.equal(controller.getState().settings.theme, "system");
  assert.equal(documentValue.documentElement.dataset.theme, "system");
  assert.equal(documentValue.getElementById("libraryMain").getAttribute("aria-busy"), "false");
  assert.equal(documentValue.getElementById("newNoteButton").disabled, false);
  assert.equal(documentValue.activeElement, documentValue.getElementById("newNoteButton"));
  assert.notEqual(storage.values[STORAGE_KEYS.dataEpoch], "reset-ui-before");
  assert.equal(storage.values[STORAGE_KEYS.editorDraft].draft, null);
  for (const key of [
    STORAGE_KEYS.pendingCaptures,
    STORAGE_KEYS.recovery,
    STORAGE_KEYS.helpSeen,
    STORAGE_KEYS.resetCleanup,
  ]) {
    assert.equal(key in storage.values, false, key);
  }

  documentValue.getElementById("newNoteButton").click();
  documentValue.getElementById("editorTitle").value = "After reset";
  documentValue.getElementById("editorBody").value = "The current page can save with the new data token.";
  submit(documentValue, "editorForm");
  await waitFor(() => controller.getState().notes.length === 1);
  assert.equal(controller.getState().notes[0].title, "After reset");
});

test("requires a fresh reset confirmation after a hidden library change", async (t) => {
  const original = note("first", "First body");
  const storage = memoryStorage({
    [STORAGE_KEYS.dataEpoch]: "reset-race-epoch",
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes: [original] },
  });
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue } = setup;
  documentValue.getElementById("clearLocalDataButton").click();
  const confirmation = documentValue.getElementById("resetConfirmationInput");
  confirmation.value = "DELETE";
  confirmation.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));

  storage.values[STORAGE_KEYS.state] = addNote(
    controller.getState(),
    { title: "New elsewhere", body: "Saved in another window" },
    { idFactory: () => "second", now: START },
  ).state;
  submit(documentValue, "resetForm");
  await waitFor(() => documentValue.getElementById("resetStatus").textContent.includes("changed in another window"));

  assert.equal(documentValue.getElementById("resetDialog").open, true);
  assert.equal(controller.getState().notes.length, 2);
  assert.equal(confirmation.value, "");
  assert.equal(documentValue.getElementById("confirmResetButton").disabled, true);
  assert.equal(documentValue.getElementById("resetConfirmationInput").disabled, false);
  assert.equal(documentValue.activeElement, documentValue.getElementById("resetConfirmationInput"));
  assert.equal(
    documentValue.getElementById("resetMessage").textContent,
    "This will clear 2 active notes and 0 Trash entries from this Chrome profile.",
  );
  assert.equal(storage.values[STORAGE_KEYS.dataEpoch], "reset-race-epoch");
});

test("reports a completed reset when supporting-data cleanup fails", async (t) => {
  const stored = memoryStorage({
    [STORAGE_KEYS.dataEpoch]: "cleanup-before",
    [STORAGE_KEYS.state]: {
      ...createEmptyState(),
      revision: 2,
      notes: [note("saved", "Saved body")],
    },
    [STORAGE_KEYS.pendingCaptures]: { version: 1, captures: [] },
    [STORAGE_KEYS.helpSeen]: true,
  });
  const remove = stored.remove.bind(stored);
  let failCleanup = true;
  const storage = {
    values: stored.values,
    get: stored.get.bind(stored),
    set: stored.set.bind(stored),
    async remove(keys) {
      if (
        failCleanup &&
        Array.isArray(keys) &&
        keys.includes(STORAGE_KEYS.pendingCaptures)
      ) {
        throw new Error("Cleanup blocked");
      }
      await remove(keys);
    },
  };
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue } = setup;

  documentValue.getElementById("clearLocalDataButton").click();
  const confirmation = documentValue.getElementById("resetConfirmationInput");
  confirmation.value = "DELETE";
  confirmation.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  submit(documentValue, "resetForm");
  await waitFor(() => documentValue.getElementById("retryLoadButton").textContent === "Retry cleanup");

  assert.equal(controller.getState().notes.length, 0);
  assert.equal(storage.values[STORAGE_KEYS.state].revision, 3);
  assert.equal(storage.values[STORAGE_KEYS.resetCleanup], storage.values[STORAGE_KEYS.dataEpoch]);
  assert.equal(documentValue.getElementById("newNoteButton").disabled, true);
  assert.match(documentValue.getElementById("libraryStatus").textContent, /Local data was cleared/u);
  assert.match(documentValue.getElementById("libraryStatus").textContent, /retry cleanup/u);
  assert.equal(documentValue.activeElement, documentValue.getElementById("retryLoadButton"));

  failCleanup = false;
  documentValue.getElementById("retryLoadButton").click();
  await waitFor(() =>
    !(STORAGE_KEYS.resetCleanup in storage.values) &&
    !documentValue.getElementById("newNoteButton").disabled,
  );
  assert.equal(STORAGE_KEYS.resetCleanup in storage.values, false);
  assert.equal(STORAGE_KEYS.pendingCaptures in storage.values, false);
  assert.equal(documentValue.getElementById("newNoteButton").disabled, false);
});

test("requires a reload when a reset outcome cannot be read back", async (t) => {
  const stored = memoryStorage({
    [STORAGE_KEYS.dataEpoch]: "unknown-before",
    [STORAGE_KEYS.state]: {
      ...createEmptyState(),
      revision: 3,
      notes: [note("saved", "Saved body")],
    },
    [STORAGE_KEYS.pendingCaptures]: { version: 1, captures: [] },
  });
  let failReadback = false;
  const storage = {
    values: stored.values,
    async get(keys) {
      if (failReadback) {
        throw new Error("Readback blocked");
      }
      return stored.get(keys);
    },
    set: stored.set.bind(stored),
    async remove(keys) {
      if (Array.isArray(keys) && keys.includes(STORAGE_KEYS.pendingCaptures)) {
        failReadback = true;
        throw new Error("Cleanup blocked");
      }
      await stored.remove(keys);
    },
  };
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue } = setup;

  documentValue.getElementById("clearLocalDataButton").click();
  const confirmation = documentValue.getElementById("resetConfirmationInput");
  confirmation.value = "DELETE";
  confirmation.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  submit(documentValue, "resetForm");
  await waitFor(() => documentValue.getElementById("retryLoadButton").textContent === "Reload page");

  assert.equal(storage.values[STORAGE_KEYS.state].notes.length, 0);
  assert.notEqual(storage.values[STORAGE_KEYS.dataEpoch], "unknown-before");
  assert.equal(controller.getState().notes.length, 1);
  assert.equal(documentValue.getElementById("resetDialog").open, false);
  assert.equal(documentValue.getElementById("newNoteButton").disabled, true);
  assert.equal(documentValue.getElementById("clearLocalDataButton").disabled, true);
  assert.match(documentValue.getElementById("libraryStatus").textContent, /could not confirm/u);
  assert.equal(documentValue.activeElement, documentValue.getElementById("retryLoadButton"));
});

test("focuses Reload page after a stale reset confirmation", async (t) => {
  const storage = memoryStorage({
    [STORAGE_KEYS.dataEpoch]: "stale-reset-before",
    [STORAGE_KEYS.state]: {
      ...createEmptyState(),
      notes: [note("saved", "Saved body")],
    },
  });
  const setup = await setupLibrary(t, [], storage);
  const { documentValue } = setup;
  documentValue.getElementById("clearLocalDataButton").click();
  const confirmation = documentValue.getElementById("resetConfirmationInput");
  confirmation.value = "DELETE";
  confirmation.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  storage.values[STORAGE_KEYS.dataEpoch] = "stale-reset-after";
  submit(documentValue, "resetForm");
  await waitFor(() => documentValue.getElementById("resetDialog").open === false);

  assert.equal(documentValue.getElementById("retryLoadButton").textContent, "Reload page");
  assert.equal(documentValue.getElementById("clearLocalDataButton").disabled, true);
  assert.equal(documentValue.activeElement, documentValue.getElementById("retryLoadButton"));
  assert.match(documentValue.getElementById("libraryStatus").textContent, /reset in another window/u);
});

test("closes a reset review when another window resets the data", async (t) => {
  const original = note("saved", "Saved body");
  const storage = memoryStorage({
    [STORAGE_KEYS.dataEpoch]: "reset-dialog-before",
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes: [original] },
  });
  const setup = await setupLibrary(t, [], storage);
  const { chromeApi, controller, documentValue } = setup;
  const priorState = controller.getState();

  documentValue.getElementById("clearLocalDataButton").click();
  const dialog = documentValue.getElementById("resetDialog");
  const confirmation = documentValue.getElementById("resetConfirmationInput");
  confirmation.value = "DELETE";
  confirmation.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  assert.equal(documentValue.getElementById("confirmResetButton").disabled, false);

  const resetState = createEmptyState();
  storage.values[STORAGE_KEYS.dataEpoch] = "reset-dialog-after";
  storage.values[STORAGE_KEYS.state] = resetState;
  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.dataEpoch]: {
      oldValue: "reset-dialog-before",
      newValue: "reset-dialog-after",
    },
    [STORAGE_KEYS.state]: { oldValue: priorState, newValue: resetState },
  });

  assert.equal(dialog.open, false);
  assert.equal(confirmation.value, "");
  assert.equal(documentValue.getElementById("clearLocalDataButton").disabled, true);
  assert.equal(documentValue.getElementById("retryLoadButton").textContent, "Reload page");
  assert.equal(documentValue.activeElement, documentValue.getElementById("retryLoadButton"));
  assert.match(documentValue.getElementById("libraryStatus").textContent, /reset in another window/u);
  assert.deepEqual(storage.values[STORAGE_KEYS.state], resetState);
});

test("discards an import file that finishes reading after reset", async (t) => {
  const storage = memoryStorage({
    [STORAGE_KEYS.dataEpoch]: "import-reset-before",
    [STORAGE_KEYS.state]: {
      ...createEmptyState(),
      notes: [note("current", "Current body")],
    },
  });
  const setup = await setupLibrary(t, [], storage);
  const { controller, documentValue } = setup;
  const imported = {
    ...createEmptyState(),
    notes: [note("imported", "Imported body")],
  };
  const backupText = serializeBackup(imported, { now: START });
  const readGate = deferred();
  let readStarted = false;
  const importInput = documentValue.getElementById("importFileInput");
  Object.defineProperty(importInput, "files", {
    configurable: true,
    value: [{
      size: new TextEncoder().encode(backupText).byteLength,
      async text() {
        readStarted = true;
        return readGate.promise;
      },
    }],
  });
  importInput.dispatchEvent(new documentValue.defaultView.Event("change", { bubbles: true }));
  await waitFor(() => readStarted);

  documentValue.getElementById("clearLocalDataButton").click();
  const confirmation = documentValue.getElementById("resetConfirmationInput");
  confirmation.value = "DELETE";
  confirmation.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  submit(documentValue, "resetForm");
  await waitFor(() => controller.getState().notes.length === 0);
  readGate.resolve(backupText);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

  assert.equal(documentValue.getElementById("importDialog").open, false);
  assert.equal(controller.getState().notes.length, 0);
  assert.match(documentValue.getElementById("libraryStatus").textContent, /Local notes/u);
});

test("reconciles storage events suppressed by a failed reset", async (t) => {
  const stored = memoryStorage({
    [STORAGE_KEYS.dataEpoch]: "failed-reset-epoch",
    [STORAGE_KEYS.state]: {
      ...createEmptyState(),
      notes: [note("first", "First body")],
    },
  });
  const resetWriteGate = deferred();
  let resetWriteStarted = false;
  let blockResetWrite = true;
  const storage = {
    values: stored.values,
    get: stored.get.bind(stored),
    remove: stored.remove.bind(stored),
    async set(update) {
      if (blockResetWrite && Object.hasOwn(update, STORAGE_KEYS.resetCleanup)) {
        resetWriteStarted = true;
        await resetWriteGate.promise;
        blockResetWrite = false;
        throw new Error("Reset write blocked");
      }
      await stored.set(update);
    },
  };
  const setup = await setupLibrary(t, [], storage);
  const { chromeApi, controller, documentValue } = setup;
  documentValue.getElementById("clearLocalDataButton").click();
  const confirmation = documentValue.getElementById("resetConfirmationInput");
  confirmation.value = "DELETE";
  confirmation.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  submit(documentValue, "resetForm");
  await waitFor(() => resetWriteStarted);

  const externalState = addNote(
    controller.getState(),
    { title: "Second", body: "Saved elsewhere" },
    { idFactory: () => "second", now: START },
  ).state;
  const externalDraft = {
    version: 1,
    ownerSessionId: "external-editor",
    generation: 1,
    contentGeneration: 1,
    draft: {
      noteId: null,
      baseRevision: externalState.revision,
      baseNote: null,
      title: "External draft",
      body: "Draft saved elsewhere",
      course: "CS 101",
      source: { title: "", url: "" },
      updatedAt: START,
    },
  };
  const externalRecovery = {
    createdAt: START,
    rejectedNotes: 2,
    rejectedDrafts: 1,
  };
  storage.values[STORAGE_KEYS.state] = externalState;
  storage.values[STORAGE_KEYS.editorDraft] = externalDraft;
  storage.values[STORAGE_KEYS.recovery] = externalRecovery;
  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.state]: { oldValue: controller.getState(), newValue: externalState },
    [STORAGE_KEYS.editorDraft]: { oldValue: undefined, newValue: externalDraft },
    [STORAGE_KEYS.recovery]: { oldValue: undefined, newValue: externalRecovery },
  });
  resetWriteGate.resolve();
  await waitFor(() => documentValue.getElementById("resetStatus").textContent.includes("Changes from another window"));

  assert.equal(controller.getState().notes.length, 2);
  assert.equal(documentValue.getElementById("editorDraftRecovery").hidden, false);
  assert.match(documentValue.getElementById("editorDraftMessage").textContent, /draft saved/u);
  assert.equal(documentValue.getElementById("recoveryNotice").hidden, false);
  assert.match(documentValue.getElementById("recoveryMessage").textContent, /2 invalid notes/u);
  assert.match(documentValue.getElementById("recoveryMessage").textContent, /1 invalid draft/u);
  assert.equal(documentValue.getElementById("resetDialog").open, true);
  assert.equal(confirmation.value, "");
  assert.equal(confirmation.disabled, false);
  assert.equal(documentValue.activeElement, confirmation);
  assert.equal(storage.values[STORAGE_KEYS.dataEpoch], "failed-reset-epoch");
});

test("keeps editor text visible and blocks writes after a data reset", async (t) => {
  const original = note("first", "Original body");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes: [original] },
  });
  const setup = await setupLibrary(t, [], storage);
  const { chromeApi, controller, documentValue } = setup;
  documentValue.querySelector("[data-action='edit']").click();
  const body = documentValue.getElementById("editorBody");
  body.value = "Text kept in the old page";
  body.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));

  const priorEpoch = storage.values[STORAGE_KEYS.dataEpoch];
  const resetState = createEmptyState();
  storage.values[STORAGE_KEYS.dataEpoch] = "epoch-after-reset";
  storage.values[STORAGE_KEYS.state] = resetState;
  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.dataEpoch]: {
      oldValue: priorEpoch,
      newValue: "epoch-after-reset",
    },
    [STORAGE_KEYS.state]: {
      oldValue: controller.getState(),
      newValue: resetState,
    },
  });

  assert.equal(body.value, "Text kept in the old page");
  assert.equal(documentValue.getElementById("editorDialog").open, true);
  assert.equal(documentValue.getElementById("newNoteButton").disabled, true);
  assert.equal(documentValue.getElementById("retryLoadButton").textContent, "Reload page");
  assert.match(documentValue.getElementById("editorStatus").textContent, /still here/u);

  submit(documentValue, "editorForm");
  await waitFor(() => documentValue.getElementById("libraryStatus").textContent.includes("reset in another window"));

  assert.equal(body.value, "Text kept in the old page");
  assert.equal(documentValue.getElementById("editorDialog").open, true);
  assert.deepEqual(storage.values[STORAGE_KEYS.state], resetState);
});

test("blocks a clean editor after reset, keeps text, and closes on cancel", async (t) => {
  const original = note("first", "Original body");
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes: [original] },
  });
  const setup = await setupLibrary(t, [], storage, { confirmDiscardDraft: () => true });
  const { chromeApi, controller, documentValue } = setup;
  documentValue.querySelector("[data-action='edit']").click();

  const priorEpoch = storage.values[STORAGE_KEYS.dataEpoch];
  const resetState = createEmptyState();
  storage.values[STORAGE_KEYS.dataEpoch] = "epoch-after-clean-editor";
  storage.values[STORAGE_KEYS.state] = resetState;
  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.dataEpoch]: {
      oldValue: priorEpoch,
      newValue: "epoch-after-clean-editor",
    },
    [STORAGE_KEYS.state]: {
      oldValue: controller.getState(),
      newValue: resetState,
    },
  });

  const body = documentValue.getElementById("editorBody");
  assert.match(documentValue.getElementById("editorStatus").textContent, /can no longer save/u);
  assert.equal(documentValue.getElementById("saveEditorButton").disabled, true);
  assert.equal(documentValue.getElementById("editorSaveDuplicateButton").disabled, true);
  assert.equal(documentValue.getElementById("saveEditorAsNewButton").disabled, true);
  assert.equal(body.disabled, false);

  body.value = "Text entered after the reset";
  body.dispatchEvent(new documentValue.defaultView.Event("input", { bubbles: true }));
  submit(documentValue, "editorForm");

  assert.equal(body.value, "Text entered after the reset");
  assert.match(documentValue.getElementById("editorStatus").textContent, /can no longer save/u);
  assert.deepEqual(storage.values[STORAGE_KEYS.state], resetState);

  documentValue.getElementById("editorDialog").dispatchEvent(
    new documentValue.defaultView.Event("cancel", { cancelable: true }),
  );
  await waitFor(() => documentValue.getElementById("editorDialog").open === false);
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
  await waitFor(() => documentValue.getElementById("libraryStatus").textContent === "No notes match the current view.");
  assert.equal(blobs.length, 1);
  assert.equal(documentValue.getElementById("libraryStatus").textContent, "No notes match the current view.");
});

test("exports saved changes before their storage event arrives", async (t) => {
  const blobs = [];
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: {
      ...createEmptyState(),
      notes: [note("original", "Original body", { title: "Original lecture" })],
    },
  });
  const setup = await setupLibrary(t, [], storage, {
    urlApi: {
      createObjectURL(blob) {
        blobs.push(blob);
        return `blob:fresh-export-${blobs.length}`;
      },
      revokeObjectURL() {},
    },
  });
  const { controller, documentValue } = setup;
  documentValue.defaultView.HTMLAnchorElement.prototype.click = function click() {};

  storage.values[STORAGE_KEYS.state] = addNote(
    storage.values[STORAGE_KEYS.state],
    { title: "External lecture", body: "First external save" },
    { idFactory: () => "external", now: "2026-09-20T11:00:00.000Z" },
  ).state;
  documentValue.getElementById("exportJsonButton").click();
  await waitFor(() => blobs.length === 1);
  const backup = JSON.parse(await blobs[0].text());
  assert.deepEqual(backup.notes.map((entry) => entry.id), ["external", "original"]);

  const latest = storage.values[STORAGE_KEYS.state];
  storage.values[STORAGE_KEYS.state] = {
    ...latest,
    revision: latest.revision + 1,
    notes: latest.notes.map((entry) => entry.id === "external"
      ? {
          ...entry,
          body: "Phrase saved immediately before export",
          updatedAt: "2026-09-20T12:00:00.000Z",
        }
      : entry),
  };
  documentValue.getElementById("searchInput").value = "immediately before";
  documentValue.getElementById("exportMarkdownButton").click();
  await waitFor(() => blobs.length === 2);
  const markdown = await blobs[1].text();

  assert.match(markdown, /Phrase saved immediately before export/u);
  assert.doesNotMatch(markdown, /Original lecture/u);
  assert.equal(controller.getState().notes[0].body, "Phrase saved immediately before export");
  assert.equal(documentValue.getElementById("searchInput").value, "immediately before");
});

test("exports real update times while sorting Trash by deletion", async (t) => {
  const first = {
    ...note("first", "First body", { title: "First lecture" }),
    updatedAt: "2026-09-20T15:00:00.000Z",
  };
  const second = {
    ...note("second", "Second body", { title: "Second lecture" }),
    updatedAt: "2026-09-20T10:30:00.000Z",
  };
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: {
      ...createEmptyState(),
      trash: [
        { note: first, deletedAt: "2026-09-20T11:00:00.000Z", originalIndex: 0 },
        { note: second, deletedAt: "2026-09-20T12:00:00.000Z", originalIndex: 1 },
      ],
    },
  });
  const blobs = [];
  const setup = await setupLibrary(t, [], storage, {
    urlApi: {
      createObjectURL(blob) {
        blobs.push(blob);
        return "blob:trash-export";
      },
      revokeObjectURL() {},
    },
  });
  const { documentValue } = setup;
  documentValue.defaultView.HTMLAnchorElement.prototype.click = function click() {};
  documentValue.getElementById("trashViewButton").click();

  assert.deepEqual(
    [...documentValue.querySelectorAll(".note-card")].map((card) => card.dataset.noteId),
    ["second", "first"],
  );
  documentValue.getElementById("exportMarkdownButton").click();
  await waitFor(() => blobs.length === 1);
  const markdown = await blobs[0].text();

  assert.match(markdown, /Second lecture[\s\S]*Updated: 2026-09-20T10:30:00\.000Z/u);
  assert.match(markdown, /First lecture[\s\S]*Updated: 2026-09-20T15:00:00\.000Z/u);
  assert.doesNotMatch(markdown, /Updated: 2026-09-20T1[12]:00:00\.000Z/u);
});

test("can omit sources from copied notes and Markdown without changing backups", async (t) => {
  const blobs = [];
  const copied = [];
  const setup = await setupLibrary(
    t,
    [note("private-share", "Share this body")],
    null,
    {
      navigatorValue: {
        clipboard: {
          async writeText(value) {
            copied.push(value);
          },
        },
      },
      urlApi: {
        createObjectURL(blob) {
          blobs.push(blob);
          return `blob:share-${blobs.length}`;
        },
        revokeObjectURL() {},
      },
    },
  );
  const { controller, documentValue } = setup;
  documentValue.defaultView.HTMLAnchorElement.prototype.click = function click() {};
  const includeSource = documentValue.getElementById("includeSourceOnShare");

  assert.equal(includeSource.checked, true);
  includeSource.checked = false;
  includeSource.dispatchEvent(new documentValue.defaultView.Event("change", { bubbles: true }));
  await waitFor(() => controller.getState().settings.includeSourceOnShare === false);

  documentValue.querySelector("[data-action='copy']").click();
  await waitFor(() => copied.length === 1);
  documentValue.getElementById("exportMarkdownButton").click();
  await waitFor(() => blobs.length === 1);
  documentValue.getElementById("exportJsonButton").click();
  await waitFor(() => blobs.length === 2);

  const markdown = await blobs[0].text();
  const backup = JSON.parse(await blobs[1].text());
  assert.doesNotMatch(copied[0], /Source:|example\.com/u);
  assert.doesNotMatch(markdown, /Source:|example\.com/u);
  assert.match(copied[0], /Share this body/u);
  assert.match(markdown, /Share this body/u);
  assert.equal(backup.notes[0].source.title, "Lecture");
  assert.equal(backup.notes[0].source.url, "https://example.com/lecture");
});

test("uses the visible source preference when its save fails", async (t) => {
  const blobs = [];
  const copied = [];
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: {
      ...createEmptyState(),
      notes: [note("pending-source-setting", "Private source body")],
    },
  });
  const originalSet = storage.set.bind(storage);
  const settingsWrite = deferred();
  let holdNextStateWrite = false;
  let settingsWriteStarted = false;
  storage.set = async (update) => {
    if (holdNextStateWrite && STORAGE_KEYS.state in update) {
      holdNextStateWrite = false;
      settingsWriteStarted = true;
      await settingsWrite.promise;
      throw new Error("Settings save failed");
    }
    return originalSet(update);
  };
  t.after(() => settingsWrite.resolve());
  const setup = await setupLibrary(t, [], storage, {
    navigatorValue: {
      clipboard: {
        async writeText(value) {
          copied.push(value);
        },
      },
    },
    urlApi: {
      createObjectURL(blob) {
        blobs.push(blob);
        return "blob:pending-source-setting";
      },
      revokeObjectURL() {},
    },
  });
  const { controller, documentValue } = setup;
  documentValue.defaultView.HTMLAnchorElement.prototype.click = function click() {};
  const includeSource = documentValue.getElementById("includeSourceOnShare");

  holdNextStateWrite = true;
  includeSource.checked = false;
  includeSource.dispatchEvent(new documentValue.defaultView.Event("change", { bubbles: true }));
  await waitFor(() => settingsWriteStarted);
  documentValue.querySelector("[data-action='copy']").click();
  documentValue.getElementById("exportMarkdownButton").click();
  await waitFor(() => copied.length === 1);

  assert.equal(controller.getState().settings.includeSourceOnShare, true);
  assert.equal(includeSource.checked, false);
  assert.doesNotMatch(copied[0], /Source:|example\.com/u);

  settingsWrite.resolve();
  await waitFor(() => blobs.length === 1);
  assert.equal(controller.getState().settings.includeSourceOnShare, true);
  assert.equal(includeSource.checked, true);
  assert.doesNotMatch(await blobs[0].text(), /Source:|example\.com/u);
});

test("shows copy feedback on the selected note", async (t) => {
  const scheduled = new Map();
  const copied = [];
  let nextTimer = 0;
  const setup = await setupLibrary(
    t,
    [note("copy", "Copy body")],
    null,
    {
      navigatorValue: { clipboard: { async writeText(value) { copied.push(value); } } },
      timerApi: {
        clearTimeout(identifier) {
          scheduled.delete(identifier);
        },
        setTimeout(callback) {
          nextTimer += 1;
          scheduled.set(nextTimer, callback);
          return nextTimer;
        },
      },
    },
  );
  const { documentValue } = setup;
  const button = documentValue.querySelector("[data-action='copy']");
  button.click();
  await waitFor(() => button.textContent === "Copied");
  button.click();
  await waitFor(() => copied.length === 2);

  assert.match(copied[0], /Copy body/u);
  assert.equal(scheduled.size, 1);
  [...scheduled.values()][0]();
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

test("does not retry an editor handoff rejected after a data reset", async (t) => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const messages = [];
  let nextTimer = 0;
  const scheduled = new Set();
  const setup = await setupLibrary(t, [], storage, {
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        return {
          ok: false,
          error: "The note data was reset in another window.",
          code: "data-reset",
        };
      },
    },
    timerApi: {
      clearTimeout(identifier) {
        scheduled.delete(identifier);
      },
      setTimeout() {
        nextTimer += 1;
        scheduled.add(nextTimer);
        return nextTimer;
      },
    },
  });
  const { documentValue, dom } = setup;
  documentValue.getElementById("newNoteButton").click();
  const body = documentValue.getElementById("editorBody");
  body.value = "Keep this editor text";
  body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  await waitFor(() => messages.length === 1);
  await waitFor(() => documentValue.getElementById("libraryStatus").textContent.includes("reset in another window"));

  assert.equal(messages[0].expectedEpoch, storage.values[STORAGE_KEYS.dataEpoch]);
  assert.equal(STORAGE_KEYS.editorDraft in storage.values, false);
  assert.equal(body.value, "Keep this editor text");
  assert.equal(documentValue.getElementById("retryLoadButton").textContent, "Reload page");
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
