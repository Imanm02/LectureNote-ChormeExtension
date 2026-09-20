import assert from "node:assert/strict";
import test from "node:test";

import { handleDraftMessage, isAuthorizedDraftMessage } from "../src/background.js";
import { MESSAGE_TYPES } from "../src/messages.js";
import { LIMITS } from "../src/model.js";
import { loadDraft, loadEditorDraft } from "../src/storage.js";
import { memoryStorage } from "./helpers.js";

const RUNTIME_ID = "abcdefghijklmnopabcdefghijklmnop";

test("stores a draft handed off by an extension page", async () => {
  const storage = memoryStorage();
  const message = {
    type: MESSAGE_TYPES.saveDraft,
    draft: { body: "Keep this popup draft", sessionId: "popup-session" },
  };

  assert.equal(isAuthorizedDraftMessage(message, { id: RUNTIME_ID }, RUNTIME_ID), true);
  assert.deepEqual(
    await handleDraftMessage(message, { id: RUNTIME_ID }, storage, RUNTIME_ID),
    { handled: true, saved: true },
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

test("rejects an oversized handed-off draft", async () => {
  const storage = memoryStorage();

  await assert.rejects(
    () =>
      handleDraftMessage(
        {
          type: MESSAGE_TYPES.saveDraft,
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

test("stores editor drafts without replacing popup drafts", async () => {
  const storage = memoryStorage();
  await handleDraftMessage(
    { type: MESSAGE_TYPES.saveDraft, draft: { body: "Popup draft" } },
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

test("rejects unknown internal message types", async () => {
  const storage = memoryStorage();
  const message = { type: "save-anywhere", draft: { body: "Do not save" } };

  assert.equal(isAuthorizedDraftMessage(message, { id: RUNTIME_ID }, RUNTIME_ID), false);
  assert.deepEqual(
    await handleDraftMessage(message, { id: RUNTIME_ID }, storage, RUNTIME_ID),
    { handled: false },
  );
});
