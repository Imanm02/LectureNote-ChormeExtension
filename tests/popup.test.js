import assert from "node:assert/strict";
import test from "node:test";

import { initPopup } from "../src/popup.js";
import { createEmptyState } from "../src/model.js";
import { STORAGE_KEYS } from "../src/storage.js";
import { chromeMock, loadPage, memoryStorage, waitFor } from "./helpers.js";

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
  assert.equal(storage.values[STORAGE_KEYS.draft].body, "New selection");
  controller.destroy();
  dom.window.close();
});
