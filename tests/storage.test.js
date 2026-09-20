import assert from "node:assert/strict";
import test from "node:test";

import {
  clearEditorDraft,
  clearDraft,
  loadEditorDraft,
  loadDraft,
  loadRecoveryInfo,
  loadState,
  mutateState,
  mutateStateAndClearEditorDraft,
  saveEditorDraft,
  saveDraft,
  saveState,
  STORAGE_KEYS,
} from "../src/storage.js";
import { addNote, createEmptyState, createNote, LIMITS } from "../src/model.js";

const NOW = "2026-09-20T10:00:00.000Z";

function memoryStorage(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((name) => name in values).map((name) => [name, values[name]]));
    },
    async set(update) {
      Object.assign(values, structuredClone(update));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete values[key];
      }
    },
  };
}

function identifiers(...values) {
  let index = 0;
  return () => values[index++] || `generated-${index}`;
}

function sample(body = "Graph theory") {
  return {
    title: "Lecture",
    body,
    course: "CS 101",
    source: { title: "Course page", url: "https://example.com/lecture" },
  };
}

function editorDraft(body = "Unfinished graph note") {
  return {
    noteId: null,
    baseRevision: 0,
    baseNote: null,
    title: "Draft lecture",
    body,
    course: "CS 101",
    source: { title: "Course page", url: "https://" },
  };
}

test("initializes an empty versioned state", async () => {
  const storage = memoryStorage();
  const state = await loadState(storage, { now: NOW });

  assert.equal(state.schemaVersion, 1);
  assert.deepEqual(state.notes, []);
  assert.deepEqual(storage.values[STORAGE_KEYS.state], state);
});

test("migrates legacy result and selection without losing text", async () => {
  const storage = memoryStorage({
    result: "Generated note",
    selectedText: "Selected lecture text",
  });
  const state = await loadState(storage, { idFactory: () => "legacy-note", now: NOW });
  const draft = await loadDraft(storage, { now: NOW });

  assert.equal(state.notes[0].body, "Generated note");
  assert.equal(draft.body, "Selected lecture text");
  assert.equal("result" in storage.values, false);
  assert.equal("selectedText" in storage.values, false);
});

test("saves and reloads valid state", async () => {
  const storage = memoryStorage();
  const state = await loadState(storage, { now: NOW });
  const saved = await saveState(state, storage, { now: NOW });
  const loaded = await loadState(storage, { now: NOW });

  assert.deepEqual(loaded, saved);
});

test("persists, loads, and clears a draft", async () => {
  const storage = memoryStorage();
  await saveDraft(
    {
      title: "Draft",
      body: "Unfinished note",
      course: "CS 101",
      source: { title: "Lecture", url: "https://example.com" },
    },
    storage,
    { now: NOW },
  );

  const draft = await loadDraft(storage, { now: NOW });
  assert.equal(draft.body, "Unfinished note");
  await clearDraft(storage);
  assert.equal(await loadDraft(storage), null);
});

test("rejects an oversized draft without replacing the saved draft", async () => {
  const storage = memoryStorage();
  await saveDraft({ body: "Keep this draft" }, storage, { now: NOW });

  await assert.rejects(
    () => saveDraft({ body: "x".repeat(LIMITS.body + 1) }, storage, { now: NOW }),
    { code: "note-text-length" },
  );
  assert.equal((await loadDraft(storage)).body, "Keep this draft");
});

test("rejects stale state instead of overwriting a newer note", async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const firstClient = await loadState(storage, { now: NOW });
  const secondClient = await loadState(storage, { now: NOW });
  const firstUpdate = addNote(firstClient, sample("First"), {
    idFactory: () => "first",
    now: NOW,
  }).state;
  const secondUpdate = addNote(secondClient, sample("Second"), {
    idFactory: () => "second",
    now: NOW,
  }).state;

  await saveState(firstUpdate, storage, { expectedRevision: 0, now: NOW });
  await assert.rejects(
    () => saveState(secondUpdate, storage, { expectedRevision: 0, now: NOW }),
    { code: "state-conflict" },
  );
  assert.equal((await loadState(storage)).notes[0].body, "First");
});

test("serializes concurrent mutations without losing a note", async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  await Promise.all([
    mutateState(
      (state) => addNote(state, sample("First"), { idFactory: () => "first", now: NOW }),
      storage,
      { lockManager: null, now: NOW },
    ),
    mutateState(
      (state) => addNote(state, sample("Second"), { idFactory: () => "second", now: NOW }),
      storage,
      { lockManager: null, now: NOW },
    ),
  ]);

  const state = await loadState(storage, { now: NOW });
  assert.deepEqual(new Set(state.notes.map((note) => note.body)), new Set(["First", "Second"]));
});

test("persists repaired duplicate IDs on the first load", async () => {
  const first = createNote(sample("First"), { idFactory: () => "same", now: NOW });
  const second = createNote(sample("Second"), { idFactory: () => "same", now: NOW });
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes: [first, second] },
  });

  const repaired = await loadState(storage, { idFactory: identifiers("repair-a"), now: NOW });
  const reloaded = await loadState(storage, { idFactory: identifiers("repair-b"), now: NOW });

  assert.deepEqual(reloaded.notes.map((note) => note.id), repaired.notes.map((note) => note.id));
  assert.deepEqual(
    storage.values[STORAGE_KEYS.state].notes.map((note) => note.id),
    repaired.notes.map((note) => note.id),
  );
});

test("quarantines a malformed stored note while keeping valid notes", async () => {
  const valid = createNote(sample("Valid"), { idFactory: () => "valid", now: NOW });
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: {
      ...createEmptyState(),
      notes: [valid, { id: "broken", title: "Missing body" }],
    },
  });

  const state = await loadState(storage, { now: NOW });
  const recovery = await loadRecoveryInfo(storage);

  assert.deepEqual(state.notes, [valid]);
  assert.equal(recovery.rejectedNotes, 1);
  assert.equal(storage.values[STORAGE_KEYS.recovery].rejectedNotes, 1);
  assert.equal(JSON.stringify(storage.values[STORAGE_KEYS.recovery]).includes("broken"), false);
});

test("migrates state and draft in one retryable storage write", async () => {
  const storage = memoryStorage({ result: "Generated", selectedText: "Selected" });
  const originalSet = storage.set;
  let fail = true;
  storage.set = async (update) => {
    if (fail) {
      fail = false;
      throw new Error("Write failed");
    }
    return originalSet.call(storage, update);
  };

  await assert.rejects(
    () => loadState(storage, { idFactory: () => "legacy", now: NOW }),
    /Write failed/u,
  );
  assert.equal(STORAGE_KEYS.state in storage.values, false);
  assert.equal(STORAGE_KEYS.draft in storage.values, false);

  const state = await loadState(storage, { idFactory: () => "legacy", now: NOW });
  assert.equal(state.notes[0].body, "Generated");
  assert.equal((await loadDraft(storage)).body, "Selected");
});

test("retries legacy cleanup without duplicating migrated content", async () => {
  const storage = memoryStorage({ result: "Generated", selectedText: "Selected" });
  const originalRemove = storage.remove;
  let fail = true;
  storage.remove = async (keys) => {
    if (fail) {
      fail = false;
      throw new Error("Remove failed");
    }
    return originalRemove.call(storage, keys);
  };

  await assert.rejects(
    () => loadState(storage, { idFactory: () => "legacy", now: NOW }),
    /Remove failed/u,
  );
  const state = await loadState(storage, { idFactory: () => "unused", now: NOW });

  assert.equal(state.notes.length, 1);
  assert.equal((await loadDraft(storage)).body, "Selected");
  assert.equal("result" in storage.values, false);
  assert.equal("selectedText" in storage.values, false);
});

test("keeps a newer draft when removing a legacy selection", async () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.draft]: {
      title: "Current",
      body: "Newer draft",
      course: "",
      source: {},
      updatedAt: NOW,
    },
    selectedText: "Older selection",
  });

  await loadState(storage, { now: NOW });
  assert.equal((await loadDraft(storage)).body, "Newer draft");
  assert.equal("selectedText" in storage.values, false);
});

test("propagates storage failures without reporting success", async () => {
  const failure = new Error("Quota exceeded");
  const storage = {
    async get() {
      return {};
    },
    async set() {
      throw failure;
    },
    async remove() {},
  };

  await assert.rejects(() => loadState(storage, { now: NOW }), failure);
  await assert.rejects(() => saveDraft({ body: "Keep me" }, storage, { now: NOW }), failure);
});

test("keeps popup and editor drafts in separate records", async () => {
  const storage = memoryStorage();
  await saveDraft({ body: "Popup draft" }, storage, { now: NOW });
  const saved = await saveEditorDraft(editorDraft(), storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    now: NOW,
  });

  assert.equal(saved.saved, true);
  assert.equal((await loadDraft(storage)).body, "Popup draft");
  assert.equal((await loadEditorDraft(storage)).draft.body, "Unfinished graph note");
  assert.equal((await loadEditorDraft(storage)).draft.source.url, "https://");
});

test("rejects stale editor writes and delayed resurrection", async () => {
  const storage = memoryStorage();
  const first = await saveEditorDraft(editorDraft("First"), storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    now: NOW,
  });
  const second = await saveEditorDraft(editorDraft("Second"), storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: first.record.ownerSessionId,
    expectedGeneration: first.record.generation,
    now: NOW,
  });
  const stale = await saveEditorDraft(editorDraft("Late first write"), storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: first.record.ownerSessionId,
    expectedGeneration: first.record.generation,
    now: NOW,
  });

  assert.equal(stale.saved, false);
  assert.equal(stale.record.draft.body, "Second");

  const cleared = await clearEditorDraft(storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: second.record.ownerSessionId,
    expectedGeneration: second.record.generation,
  });
  const resurrected = await saveEditorDraft(editorDraft("Delayed page close"), storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: second.record.ownerSessionId,
    expectedGeneration: second.record.generation,
    now: NOW,
  });

  assert.equal(cleared.record.draft, null);
  assert.equal(resurrected.saved, false);
  assert.equal((await loadEditorDraft(storage)).draft, null);
});

test("orders stale-cursor writes within one editor session", async () => {
  const storage = memoryStorage();
  const first = await saveEditorDraft(editorDraft("First"), storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    contentGeneration: 1,
    now: NOW,
  });
  const second = await saveEditorDraft(editorDraft("Second"), storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    contentGeneration: 2,
    now: NOW,
  });
  const delayed = await saveEditorDraft(editorDraft("Delayed first"), storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    contentGeneration: 1,
    now: NOW,
  });
  const repeated = await saveEditorDraft(
    { ...editorDraft("Second"), updatedAt: "2026-09-20T11:00:00.000Z" },
    storage,
    {
    sessionId: "editor-one",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    contentGeneration: 2,
    now: NOW,
    },
  );
  const conflictingRepeat = await saveEditorDraft(editorDraft("Different second"), storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    contentGeneration: 2,
    now: NOW,
  });

  assert.equal(first.record.generation, 1);
  assert.equal(second.saved, true);
  assert.equal(second.record.generation, 2);
  assert.equal(second.record.contentGeneration, 2);
  assert.equal(delayed.saved, false);
  assert.equal(repeated.saved, true);
  assert.equal(repeated.record.generation, 2);
  assert.equal(conflictingRepeat.saved, false);
  assert.equal((await loadEditorDraft(storage)).draft.body, "Second");
});

test("orders editor tombstones without crossing owners", async () => {
  const storage = memoryStorage();
  const first = await saveEditorDraft(editorDraft("First"), storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    contentGeneration: 1,
    now: NOW,
  });
  const cleared = await clearEditorDraft(storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: first.record.ownerSessionId,
    expectedGeneration: first.record.generation,
    contentGeneration: 3,
  });
  const delayed = await saveEditorDraft(editorDraft("Delayed"), storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: first.record.ownerSessionId,
    expectedGeneration: first.record.generation,
    contentGeneration: 2,
    now: NOW,
  });
  const revived = await saveEditorDraft(editorDraft("New work"), storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: first.record.ownerSessionId,
    expectedGeneration: first.record.generation,
    contentGeneration: 4,
    now: NOW,
  });
  const foreignClear = await clearEditorDraft(storage, {
    sessionId: "editor-two",
    expectedOwnerSessionId: revived.record.ownerSessionId,
    expectedGeneration: revived.record.generation,
    contentGeneration: 1,
  });
  const crossedOwner = await saveEditorDraft(editorDraft("Must not return"), storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: revived.record.ownerSessionId,
    expectedGeneration: revived.record.generation,
    contentGeneration: 100,
    now: NOW,
  });

  assert.equal(cleared.record.draft, null);
  assert.equal(delayed.saved, false);
  assert.equal(revived.saved, true);
  assert.equal(revived.record.draft.body, "New work");
  assert.equal(foreignClear.record.draft, null);
  assert.equal(crossedOwner.saved, false);
  assert.equal((await loadEditorDraft(storage)).draft, null);
});

test("saves a note and clears its editor draft in one update", async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const savedDraft = await saveEditorDraft(editorDraft(), storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    now: NOW,
  });
  const result = await mutateStateAndClearEditorDraft(
    (state) => addNote(state, sample("Saved body"), { idFactory: () => "saved-note", now: NOW }),
    storage,
    {
      sessionId: "editor-one",
      expectedOwnerSessionId: savedDraft.record.ownerSessionId,
      expectedGeneration: savedDraft.record.generation,
      now: NOW,
    },
  );

  assert.equal(result.editorDraftCleared, true);
  assert.equal(result.state.notes[0].id, "saved-note");
  assert.equal((await loadEditorDraft(storage)).draft, null);
});

test("keeps another tab's editor draft while saving a note", async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  await saveEditorDraft(editorDraft("Other tab"), storage, {
    sessionId: "editor-other",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    now: NOW,
  });
  const result = await mutateStateAndClearEditorDraft(
    (state) => addNote(state, sample("Saved locally"), { idFactory: () => "saved-note", now: NOW }),
    storage,
    {
      sessionId: "editor-local",
      expectedOwnerSessionId: "",
      expectedGeneration: 0,
      now: NOW,
    },
  );

  assert.equal(result.editorDraftCleared, false);
  assert.equal(result.state.notes.length, 1);
  assert.equal((await loadEditorDraft(storage)).draft.body, "Other tab");
});

test("quarantines a malformed editor draft without blocking the library", async () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.editorDraft]: { version: 1, ownerSessionId: "bad id", generation: 1, draft: {} },
  });

  const state = await loadState(storage, { now: NOW });
  const record = await loadEditorDraft(storage, { now: NOW });
  const recovery = await loadRecoveryInfo(storage);

  assert.deepEqual(state.notes, []);
  assert.equal(record.draft, null);
  assert.equal(recovery.rejectedDrafts, 1);
});

test("preserves editor drafts from a newer storage version", async () => {
  const futureRecord = {
    version: 2,
    ownerSessionId: "future-editor",
    generation: 4,
    contentGeneration: 7,
    draft: { body: "Future draft data" },
  };
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.editorDraft]: futureRecord,
  });
  const before = structuredClone(storage.values);

  await assert.rejects(() => loadEditorDraft(storage), { code: "editor-draft-version" });
  await assert.rejects(
    () =>
      saveEditorDraft(editorDraft("Do not replace"), storage, {
        sessionId: "older-editor",
        expectedOwnerSessionId: "",
        expectedGeneration: 0,
        contentGeneration: 1,
      }),
    { code: "editor-draft-version" },
  );
  await assert.rejects(
    () =>
      mutateStateAndClearEditorDraft(
        (state) => addNote(state, sample("Do not save"), { idFactory: () => "not-saved", now: NOW }),
        storage,
        {
          sessionId: "older-editor",
          expectedOwnerSessionId: "",
          expectedGeneration: 0,
        },
      ),
    { code: "editor-draft-version" },
  );

  assert.deepEqual(storage.values, before);
});

test("does not quarantine a draft when canonicalization storage fails", async () => {
  const rawRecord = {
    version: 1,
    ownerSessionId: "editor-one",
    generation: 1,
    draft: { ...editorDraft(), ignored: "drop this" },
  };
  const storage = memoryStorage({ [STORAGE_KEYS.editorDraft]: rawRecord });
  const before = structuredClone(storage.values);
  const storedSet = storage.set.bind(storage);
  let setCalls = 0;
  storage.set = async (update) => {
    setCalls += 1;
    if (setCalls === 1) {
      throw new Error("Canonical write failed");
    }
    return storedSet(update);
  };

  await assert.rejects(() => loadEditorDraft(storage, { now: NOW }), /Canonical write failed/u);
  assert.deepEqual(storage.values, before);
  assert.equal(storage.values[STORAGE_KEYS.recovery], undefined);

  const recovered = await loadEditorDraft(storage, { now: NOW });
  assert.equal(recovered.draft.body, rawRecord.draft.body);
  assert.equal(recovered.contentGeneration, 0);
  assert.equal(Object.hasOwn(storage.values[STORAGE_KEYS.editorDraft].draft, "ignored"), false);
});

test("does not save a note without clearing its owned draft when the combined write fails", async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.state]: createEmptyState() });
  const savedDraft = await saveEditorDraft(editorDraft(), storage, {
    sessionId: "editor-one",
    expectedOwnerSessionId: "",
    expectedGeneration: 0,
    now: NOW,
  });
  const before = structuredClone(storage.values);
  const originalSet = storage.set.bind(storage);
  storage.set = async (update) => {
    if (Object.hasOwn(update, STORAGE_KEYS.state) && Object.hasOwn(update, STORAGE_KEYS.editorDraft)) {
      throw new Error("Combined write failed");
    }
    return originalSet(update);
  };

  await assert.rejects(
    () =>
      mutateStateAndClearEditorDraft(
        (state) => addNote(state, sample("Do not save"), { idFactory: () => "not-saved", now: NOW }),
        storage,
        {
          sessionId: "editor-one",
          expectedOwnerSessionId: savedDraft.record.ownerSessionId,
          expectedGeneration: savedDraft.record.generation,
          now: NOW,
        },
      ),
    /Combined write failed/u,
  );

  assert.deepEqual(storage.values, before);
});
