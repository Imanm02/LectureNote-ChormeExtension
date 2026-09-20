import assert from "node:assert/strict";
import test from "node:test";

import {
  clearDraft,
  loadDraft,
  loadRecoveryInfo,
  loadState,
  mutateState,
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
  assert.equal(storage.values[STORAGE_KEYS.recovery].rejectedNotes[0].note.id, "broken");
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
