import assert from "node:assert/strict";
import test from "node:test";

import { handleDraftMessage, isAuthorizedDraftMessage } from "../src/background.js";
import { MESSAGE_TYPES } from "../src/messages.js";
import { LIMITS } from "../src/model.js";
import { loadDraft } from "../src/storage.js";
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
    { handled: true },
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
