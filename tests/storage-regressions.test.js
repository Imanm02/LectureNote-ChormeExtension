import assert from "node:assert/strict";
import test from "node:test";

import { parseBackup } from "../src/backup.js";
import {
  addNote,
  createEmptyState,
  createNote,
  LIMITS,
  normalizeSource,
} from "../src/model.js";
import {
  assertStateFits,
  clearDraft,
  loadDraft,
  loadRecoveryInfo,
  loadState,
  mutateState,
  saveDraft,
  saveState,
  STORAGE_KEYS,
} from "../src/storage.js";
import { memoryStorage } from "./helpers.js";

const NOW = "2026-09-20T10:00:00.000Z";

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function noteInput(body = "Graph theory") {
  return {
    title: "Lecture",
    body,
    course: "CS 101",
    source: { title: "Course page", url: "https://example.com/lecture" },
  };
}

function textAtJsonSize(property, size) {
  const empty = JSON.stringify({ [property]: "" });
  return JSON.stringify({ [property]: "x".repeat(size - empty.length) });
}

function backupAtSize(size) {
  const empty = JSON.stringify({
    format: "lecturenote-backup",
    schemaVersion: 1,
    notes: [],
    padding: "",
  });
  return JSON.stringify({
    format: "lecturenote-backup",
    schemaVersion: 1,
    notes: [],
    padding: "x".repeat(size - empty.length),
  });
}

function trackingLockManager() {
  const tails = new Map();
  let active = 0;
  let maximumActive = 0;

  return {
    names: [],
    get maximumActive() {
      return maximumActive;
    },
    request(name, task) {
      this.names.push(name);
      const previous = tails.get(name) || Promise.resolve();
      let release;
      const turn = new Promise((resolve) => {
        release = resolve;
      });
      tails.set(name, previous.then(() => turn));

      return previous.then(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          return await task();
        } finally {
          active -= 1;
          release();
        }
      });
    },
  };
}

test("rejects an oversized state without replacing saved notes", async () => {
  const prior = createEmptyState();
  const storage = memoryStorage({ [STORAGE_KEYS.state]: prior });
  const notes = Array.from({ length: 71 }, (_, index) => {
    const prefix = `${index}:`;
    return createNote(noteInput(`${prefix}${"x".repeat(LIMITS.body - prefix.length)}`), {
      idFactory: () => `note-${index}`,
      now: NOW,
    });
  });
  const oversized = { ...prior, revision: 1, notes };

  await assert.rejects(() => saveState(oversized, storage, { now: NOW }), {
    code: "storage-size",
  });
  assert.deepEqual(storage.values[STORAGE_KEYS.state], prior);
});

test("uses one state lock for repair loads and mutations", async () => {
  const first = createNote(noteInput("First"), { idFactory: () => "same", now: NOW });
  const second = createNote(noteInput("Second"), { idFactory: () => "same", now: NOW });
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes: [first, second] },
  });
  const lockManager = trackingLockManager();

  await Promise.all([
    loadState(storage, { idFactory: () => "repaired", lockManager, now: NOW }),
    mutateState(
      (state) => addNote(state, noteInput("Added"), { idFactory: () => "added", now: NOW }),
      storage,
      { lockManager, now: NOW },
    ),
  ]);

  const saved = await loadState(storage, { lockManager, now: NOW });
  assert.equal(saved.notes.length, 3);
  assert.equal(new Set(saved.notes.map((note) => note.id)).size, 3);
  assert.equal(new Set(lockManager.names).size, 1);
  assert.equal(lockManager.maximumActive, 1);
});

test("converts old recovery records to counts without retaining raw data", async () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: createEmptyState(),
    [STORAGE_KEYS.recovery]: {
      createdAt: NOW,
      rejectedNotes: [
        { index: 0, note: { body: "Private rejected note" }, reason: "Invalid note" },
        { index: 1, note: { body: "Another private note" }, reason: "Invalid note" },
      ],
      rejectedDrafts: [{ draft: { body: "Private rejected draft" } }],
    },
  });

  await loadState(storage, { now: NOW });

  assert.deepEqual(storage.values[STORAGE_KEYS.recovery], {
    createdAt: NOW,
    rejectedNotes: 2,
    rejectedDrafts: 1,
  });
  assert.deepEqual(await loadRecoveryInfo(storage), {
    rejectedNotes: 2,
    rejectedDrafts: 1,
  });
  assert.doesNotMatch(JSON.stringify(storage.values), /Private rejected/u);
});

test("rejects strict invalid URLs and redacts captured source details", () => {
  const captured = normalizeSource({
    title: "Lecture page",
    url: "https://student:password@example.com/watch?id=42&course=cs101&utm_source=mail&token=secret&id_token=jwt&refresh_token=refresh&oauth_token=oauth&auth_token=auth&client_secret=private&jwt=signed&JSESSIONID=session&X-Amz-Security-Token=aws&lang=fa#answer",
  });

  assert.deepEqual(captured, {
    title: "Lecture page",
    url: "https://example.com/watch?id=42&course=cs101&lang=fa",
  });
  assert.deepEqual(normalizeSource({ title: "Local", url: "file:///private/lecture.pdf" }), {
    title: "Local",
    url: "",
  });
  assert.throws(
    () => normalizeSource({ url: "file:///private/lecture.pdf" }, { strictUrl: true }),
    { code: "source-url-invalid" },
  );
  assert.throws(() => normalizeSource({ url: "not a URL" }, { strictUrl: true }), {
    code: "source-url-invalid",
  });
});

test("recovers only the supported number of valid stored notes", async () => {
  const notes = Array.from({ length: LIMITS.notes + 1 }, (_, index) => ({
    id: `note-${index}`,
    title: `Note ${index}`,
    body: `Body ${index}`,
    course: "",
    source: {},
    createdAt: NOW,
    updatedAt: NOW,
  }));
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: { ...createEmptyState(), notes },
  });

  const recovered = await loadState(storage, { now: NOW });

  assert.equal(recovered.notes.length, LIMITS.notes);
  assert.equal(storage.values[STORAGE_KEYS.state].notes.length, LIMITS.notes);
  assert.deepEqual(await loadRecoveryInfo(storage), {
    rejectedNotes: 1,
    rejectedDrafts: 0,
  });
});

test("bounds oversized legacy selections and records discarded text", async () => {
  const storage = memoryStorage({
    result: `${"y".repeat(LIMITS.body)}😀tail`,
    selectedText: `${"x".repeat(LIMITS.body)}😀tail`,
  });

  const state = await loadState(storage, {
    idFactory: () => "legacy-result",
    lockManager: null,
    now: NOW,
  });
  const draft = await loadDraft(storage, { now: NOW });

  assert.equal(state.notes[0].body.length, LIMITS.body);
  assert.equal(draft.body.length, LIMITS.body);
  assert.equal(draft.body.endsWith("\ud83d"), false);
  assert.deepEqual(await loadRecoveryInfo(storage), { rejectedNotes: 1, rejectedDrafts: 1 });
  assert.equal("result" in storage.values, false);
  assert.equal("selectedText" in storage.values, false);
});

test("serializes migration with a newer draft write", async () => {
  const storage = memoryStorage({ selectedText: "Legacy selection" });
  const baseSet = storage.set.bind(storage);
  const migrationStarted = deferred();
  const releaseMigration = deferred();
  let blockMigration = true;
  storage.set = async (update) => {
    if (
      blockMigration &&
      Object.hasOwn(update, STORAGE_KEYS.state) &&
      Object.hasOwn(update, STORAGE_KEYS.draft)
    ) {
      blockMigration = false;
      migrationStarted.resolve();
      await releaseMigration.promise;
    }
    await baseSet(update);
  };
  const lockManager = trackingLockManager();

  const migration = loadState(storage, { lockManager, now: NOW });
  await migrationStarted.promise;
  const newerDraft = saveDraft(
    { body: "Newer draft", sessionId: "popup-new" },
    storage,
    { lockManager, now: NOW },
  );
  releaseMigration.resolve();
  await Promise.all([migration, newerDraft]);

  assert.equal((await loadDraft(storage, { now: NOW })).body, "Newer draft");
});

test("does not clear a draft owned by another popup", async () => {
  const storage = memoryStorage();
  await saveDraft(
    { body: "Newer popup draft", sessionId: "popup-b" },
    storage,
    { lockManager: null, now: NOW },
  );

  const skipped = await clearDraft(storage, {
    allowUnowned: true,
    expectedSessionId: "popup-a",
    lockManager: null,
  });
  assert.equal(skipped, false);
  assert.equal((await loadDraft(storage, { now: NOW })).body, "Newer popup draft");

  const cleared = await clearDraft(storage, {
    allowUnowned: true,
    expectedSessionId: "popup-b",
    lockManager: null,
  });
  assert.equal(cleared, true);
  assert.equal(await loadDraft(storage, { now: NOW }), null);
});

test("accepts exact byte limits and rejects one byte more", () => {
  const stateAtLimit = JSON.parse(textAtJsonSize("padding", LIMITS.stateBytes));
  const stateOverLimit = JSON.parse(textAtJsonSize("padding", LIMITS.stateBytes + 1));
  const backupAtLimit = backupAtSize(LIMITS.importBytes);
  const backupOverLimit = backupAtSize(LIMITS.importBytes + 1);

  assert.doesNotThrow(() => assertStateFits(stateAtLimit));
  assert.throws(() => assertStateFits(stateOverLimit), { code: "storage-size" });
  assert.deepEqual(parseBackup(backupAtLimit, { now: NOW }).notes, []);
  assert.throws(() => parseBackup(backupOverLimit, { now: NOW }), { code: "import-size" });
});
