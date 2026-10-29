import assert from "node:assert/strict";
import test from "node:test";

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

function note(identifier, body, overrides = {}) {
  return createNote(
    {
      title: overrides.title || `Note ${identifier}`,
      body,
      course: overrides.course || "CS 101",
      source: overrides.source || { title: "Lecture", url: "https://example.com/lecture" },
    },
    { idFactory: () => identifier, now: START },
  );
}

function librarySetup(notes) {
  const dom = loadPage("notes.html");
  enableDialogs(dom.window.document);
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes },
  });
  const copied = [];
  const navigatorValue = {
    clipboard: {
      async writeText(value) {
        copied.push(value);
      },
    },
  };
  const urlApi = {
    createObjectURL() {
      return "blob:test";
    },
    revokeObjectURL() {},
  };
  return { dom, storage, copied, navigatorValue, urlApi };
}

test("renders imported HTML as text and never creates active nodes", async () => {
  const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const setup = librarySetup([note("unsafe", payload, { title: "<b>Unsafe</b>" })]);
  const controller = await initLibrary({
    documentValue: setup.dom.window.document,
    chromeApi: chromeMock(setup.storage),
    navigatorValue: setup.navigatorValue,
    urlApi: setup.urlApi,
  });

  const card = setup.dom.window.document.querySelector(".note-card");
  assert.equal(card.querySelector(".note-title").textContent, "<b>Unsafe</b>");
  assert.match(card.querySelector(".note-excerpt").textContent, /<script>alert\(2\)<\/script>/u);
  assert.equal(card.querySelector("script"), null);
  assert.equal(card.querySelector("img"), null);
  controller.destroy();
  setup.dom.window.close();
});

test("searches Persian content and distinguishes filtered results", async () => {
  const setup = librarySetup([
    note("english", "Graph theory"),
    note("persian", "مقادیر ویژه", { title: "ماتریس", course: "ریاضی" }),
  ]);
  const controller = await initLibrary({
    documentValue: setup.dom.window.document,
    chromeApi: chromeMock(setup.storage),
    navigatorValue: setup.navigatorValue,
    urlApi: setup.urlApi,
  });
  const search = setup.dom.window.document.getElementById("searchInput");
  search.value = "ویژه";
  search.dispatchEvent(new setup.dom.window.Event("input", { bubbles: true }));

  await waitFor(() => setup.dom.window.document.querySelectorAll(".note-card").length === 1);
  assert.equal(setup.dom.window.document.querySelectorAll(".note-card").length, 1);
  assert.equal(setup.dom.window.document.querySelector(".note-title").textContent, "ماتریس");
  assert.equal(setup.dom.window.document.getElementById("resultSummary").textContent, "1 matching note (2 total)");
  controller.destroy();
  setup.dom.window.close();
});

test("edits, deletes, and restores a note through the library", async () => {
  const setup = librarySetup([note("first", "Original body")]);
  const controller = await initLibrary({
    documentValue: setup.dom.window.document,
    chromeApi: chromeMock(setup.storage),
    navigatorValue: setup.navigatorValue,
    urlApi: setup.urlApi,
  });
  const documentValue = setup.dom.window.document;

  documentValue.querySelector("[data-action='edit']").click();
  const body = documentValue.getElementById("editorBody");
  body.value = "Edited body";
  documentValue.getElementById("editorForm").dispatchEvent(
    new setup.dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await waitFor(() => controller.getState().notes[0].body === "Edited body");
  assert.equal(controller.getState().notes[0].createdAt, START);

  documentValue.querySelector("[data-action='delete']").click();
  documentValue.getElementById("deleteForm").dispatchEvent(
    new setup.dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await waitFor(() => controller.getState().notes.length === 0);
  assert.equal(documentValue.getElementById("undoBar").hidden, false);

  documentValue.getElementById("undoButton").click();
  await waitFor(() => controller.getState().notes.length === 1);
  assert.equal(controller.getState().notes[0].body, "Edited body");
  controller.destroy();
  setup.dom.window.close();
});

test("opens a full read-only note before edit or Trash actions", async () => {
  const fullBody = `Opening summary\n\n${"Detailed explanation ".repeat(45)}`;
  const saved = {
    ...note("detail", fullBody, {
      title: "Full lecture note",
      course: "Physics",
      source: { title: "Lecture 4", url: "https://example.com/lecture/4" },
    }),
    updatedAt: "2026-09-20T11:30:00.000Z",
  };
  const setup = librarySetup([saved]);
  const controller = await initLibrary({
    documentValue: setup.dom.window.document,
    chromeApi: chromeMock(setup.storage),
    navigatorValue: setup.navigatorValue,
    urlApi: setup.urlApi,
  });
  const documentValue = setup.dom.window.document;

  documentValue.querySelector(".note-excerpt").click();
  assert.equal(documentValue.getElementById("detailDialog").open, true);
  assert.equal(documentValue.getElementById("detailHeading").textContent, "Full lecture note");
  assert.equal(documentValue.getElementById("detailBody").textContent, saved.body);
  assert.equal(documentValue.getElementById("detailCourse").textContent, "Physics");
  assert.equal(documentValue.getElementById("detailSourceTitle").textContent, "Lecture 4");
  assert.equal(
    documentValue.getElementById("detailSourceUrl").href,
    "https://example.com/lecture/4",
  );
  assert.equal(documentValue.getElementById("detailCreated").dateTime, START);
  assert.equal(
    documentValue.getElementById("detailUpdated").dateTime,
    "2026-09-20T11:30:00.000Z",
  );

  documentValue.getElementById("detailCopyButton").click();
  await waitFor(() => setup.copied.length === 1);
  assert.match(setup.copied[0], /Full lecture note[\s\S]*Detailed explanation/u);
  assert.match(documentValue.getElementById("detailStatus").textContent, /Copied/u);

  documentValue.getElementById("detailEditButton").click();
  assert.equal(documentValue.getElementById("detailDialog").open, false);
  assert.equal(documentValue.getElementById("editorDialog").open, true);
  assert.equal(documentValue.getElementById("editorBody").value, saved.body);
  documentValue.getElementById("cancelEditorButton").click();
  await waitFor(() => !documentValue.getElementById("editorDialog").open);

  documentValue.querySelector("[data-action='view']").click();
  documentValue.getElementById("detailDeleteButton").click();
  assert.equal(documentValue.getElementById("detailDialog").open, false);
  assert.equal(documentValue.getElementById("deleteDialog").open, true);
  documentValue.getElementById("deleteForm").dispatchEvent(
    new setup.dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await waitFor(() => controller.getState().trash.length === 1);
  assert.equal(controller.getState().notes.length, 0);

  documentValue.getElementById("trashViewButton").click();
  documentValue.querySelector("[data-action='view']").click();
  assert.equal(documentValue.getElementById("detailActiveActions").hidden, true);
  assert.equal(documentValue.getElementById("detailTrashActions").hidden, false);
  assert.equal(documentValue.getElementById("detailDeletedRow").hidden, false);
  documentValue.getElementById("detailRestoreButton").click();
  await waitFor(() => controller.getState().notes.length === 1);
  assert.equal(controller.getState().trash.length, 0);
  assert.equal(documentValue.activeElement, documentValue.getElementById("trashViewButton"));

  controller.destroy();
  setup.dom.window.close();
});
