import assert from "node:assert/strict";
import test from "node:test";

import { parseBackup } from "../src/backup.js";
import {
  addNote,
  createEmptyState,
  createNote,
  LIMITS,
  normalizeSource,
  SCHEMA_VERSION,
} from "../src/model.js";
import {
  acknowledgeRecovery,
  assertStateFits,
  clearDraft,
  enqueuePendingCapture,
  loadDataEpoch,
  loadDraft,
  loadRecoveryInfo,
  loadRecoveryNotice,
  loadState,
  mutateState,
  resetAllData,
  saveDraft,
  saveEditorDraft,
  savePopupDraft,
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

function editorDraft(body = "Unfinished graph note") {
  return {
    noteId: null,
    baseRevision: 4,
    baseNote: null,
    title: "Draft lecture",
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

test("acknowledges only the recovery notice that was reviewed", async () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.recovery]: {
      createdAt: NOW,
      rejectedNotes: 1,
      rejectedDrafts: 0,
    },
  });
  const lockManager = trackingLockManager();
  const reviewed = await loadRecoveryNotice(storage, { lockManager });

  storage.values[STORAGE_KEYS.recovery] = {
    createdAt: "2026-09-20T11:00:00.000Z",
    rejectedNotes: 1,
    rejectedDrafts: 0,
  };
  const conflicted = await acknowledgeRecovery(reviewed, storage, { lockManager });

  assert.equal(conflicted.acknowledged, false);
  assert.equal(conflicted.recovery.createdAt, "2026-09-20T11:00:00.000Z");
  assert.deepEqual(storage.values[STORAGE_KEYS.recovery], conflicted.recovery);

  const acknowledged = await acknowledgeRecovery(conflicted.recovery, storage, { lockManager });
  assert.equal(acknowledged.acknowledged, true);
  assert.equal(STORAGE_KEYS.recovery in storage.values, false);
  assert.equal(new Set(lockManager.names).size, 1);
  assert.equal(lockManager.maximumActive, 1);
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

test("accepts every supported backup schema version", () => {
  for (let schemaVersion = 1; schemaVersion <= SCHEMA_VERSION; schemaVersion += 1) {
    const restored = parseBackup(JSON.stringify({
      format: "lecturenote-backup",
      schemaVersion,
      notes: [],
      ...(schemaVersion >= 2 ? { trash: [] } : {}),
    }), { now: NOW });

    assert.equal(restored.schemaVersion, schemaVersion);
    assert.deepEqual(restored.notes, []);
    assert.deepEqual(restored.trash, []);
  }
  assert.throws(
    () => parseBackup(`{"format":"lecturenote-backup","schemaVersion":1.5,"notes":[]}`),
    { code: "schema-version" },
  );
});

test("creates one persistent data reset token", async () => {
  const storage = memoryStorage();
  const first = await loadDataEpoch(storage, {
    epochFactory: () => "epoch-first",
    lockManager: null,
  });
  const second = await loadDataEpoch(storage, {
    epochFactory: () => {
      throw new Error("The stored token should be reused");
    },
    lockManager: null,
  });

  assert.equal(first, "epoch-first");
  assert.equal(second, "epoch-first");
  assert.equal(storage.values[STORAGE_KEYS.dataEpoch], "epoch-first");
});

test("resets all stored data and advances draft tombstones", async () => {
  const note = createNote(noteInput(), { idFactory: () => "saved-note", now: NOW });
  const trashed = createNote(noteInput("Deleted note"), {
    idFactory: () => "deleted-note",
    now: NOW,
  });
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: {
      ...createEmptyState(),
      revision: 4,
      notes: [note],
      trash: [{ note: trashed, deletedAt: NOW, originalIndex: 1 }],
      settings: { theme: "dark", sort: "title-asc" },
    },
    [STORAGE_KEYS.dataEpoch]: "epoch-before",
    [STORAGE_KEYS.draft]: {
      version: 1,
      ownerSessionId: "popup-before",
      generation: 7,
      contentGeneration: 9,
      draft: { body: "Popup work", sessionId: "popup-before", updatedAt: NOW },
    },
    [STORAGE_KEYS.editorDraft]: {
      version: 1,
      ownerSessionId: "editor-before",
      generation: 5,
      contentGeneration: 6,
      draft: editorDraft(),
    },
    [STORAGE_KEYS.pendingCaptures]: { version: 1, captures: [] },
    [STORAGE_KEYS.recovery]: { createdAt: NOW, rejectedNotes: 1, rejectedDrafts: 1 },
    [STORAGE_KEYS.helpSeen]: true,
    [STORAGE_KEYS.legacyResult]: "Old generated note",
    [STORAGE_KEYS.legacySelection]: "Old selection",
  });

  const reset = await resetAllData(storage, {
    lockManager: null,
    epochFactory: () => "epoch-after",
  });

  assert.equal(reset.epoch, "epoch-after");
  assert.equal(reset.state.revision, 5);
  assert.deepEqual(reset.state.notes, []);
  assert.deepEqual(reset.state.trash, []);
  assert.deepEqual(reset.state.settings, { theme: "system", sort: "updated-desc" });
  assert.deepEqual(storage.values[STORAGE_KEYS.draft], {
    version: 1,
    ownerSessionId: "reset_epoch-after",
    generation: 8,
    contentGeneration: 10,
    draft: null,
  });
  assert.deepEqual(storage.values[STORAGE_KEYS.editorDraft], {
    version: 1,
    ownerSessionId: "reset_epoch-after",
    generation: 6,
    contentGeneration: 7,
    draft: null,
  });
  assert.equal(storage.values[STORAGE_KEYS.dataEpoch], "epoch-after");
  for (const key of [
    STORAGE_KEYS.resetCleanup,
    STORAGE_KEYS.pendingCaptures,
    STORAGE_KEYS.recovery,
    STORAGE_KEYS.helpSeen,
    STORAGE_KEYS.legacyResult,
    STORAGE_KEYS.legacySelection,
  ]) {
    assert.equal(key in storage.values, false);
  }
});

test("rejects stale library and draft writers after a reset", async () => {
  const originalState = {
    ...createEmptyState(),
    revision: 4,
    notes: [createNote(noteInput(), { idFactory: () => "saved-note", now: NOW })],
  };
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: originalState,
    [STORAGE_KEYS.dataEpoch]: "epoch-before",
  });
  await resetAllData(storage, {
    lockManager: null,
    epochFactory: () => "epoch-after",
  });
  const resetValues = structuredClone(storage.values);
  let mutationCalled = false;

  await assert.rejects(
    () =>
      saveState(
        { ...originalState, revision: 5 },
        storage,
        { expectedEpoch: "epoch-before", expectedRevision: 4, lockManager: null, now: NOW },
      ),
    { code: "data-reset" },
  );
  await assert.rejects(
    () =>
      mutateState(
        (state) => {
          mutationCalled = true;
          return state;
        },
        storage,
        { expectedEpoch: "epoch-before", lockManager: null, now: NOW },
      ),
    { code: "data-reset" },
  );
  await assert.rejects(
    () =>
      savePopupDraft(
        { body: "Stale popup", sessionId: "popup-before" },
        storage,
        {
          sessionId: "popup-before",
          expectedOwnerSessionId: "",
          expectedGeneration: 0,
          expectedEpoch: "epoch-before",
          contentGeneration: 1,
          lockManager: null,
          now: NOW,
        },
      ),
    { code: "data-reset" },
  );
  await assert.rejects(
    () =>
      saveEditorDraft(editorDraft(), storage, {
        sessionId: "editor-before",
        expectedOwnerSessionId: "",
        expectedGeneration: 0,
        expectedEpoch: "epoch-before",
        lockManager: null,
        now: NOW,
      }),
    { code: "data-reset" },
  );
  await assert.rejects(
    () =>
      enqueuePendingCapture(
        { id: "stale-capture", text: "Stale selection" },
        storage,
        { expectedEpoch: "epoch-before", lockManager: null, now: NOW },
      ),
    { code: "data-reset" },
  );

  assert.equal(mutationCalled, false);
  assert.deepEqual(storage.values, resetValues);
});

test("finishes reset cleanup after an interrupted removal", async () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.state]: {
      ...createEmptyState(),
      revision: 2,
      notes: [createNote(noteInput(), { idFactory: () => "saved-note", now: NOW })],
    },
    [STORAGE_KEYS.dataEpoch]: "epoch-before",
    [STORAGE_KEYS.pendingCaptures]: { version: 1, captures: [] },
    [STORAGE_KEYS.recovery]: { createdAt: NOW, rejectedNotes: 1, rejectedDrafts: 0 },
    [STORAGE_KEYS.helpSeen]: true,
  });
  const remove = storage.remove.bind(storage);
  let interruptCleanup = true;
  storage.remove = async (keys) => {
    if (interruptCleanup && Array.isArray(keys) && keys.includes(STORAGE_KEYS.pendingCaptures)) {
      interruptCleanup = false;
      delete storage.values[STORAGE_KEYS.recovery];
      throw new Error("Cleanup interrupted");
    }
    await remove(keys);
  };

  await assert.rejects(
    () =>
      resetAllData(storage, {
        lockManager: null,
        epochFactory: () => "epoch-after",
      }),
    /Cleanup interrupted/u,
  );

  assert.equal(storage.values[STORAGE_KEYS.state].revision, 3);
  assert.deepEqual(storage.values[STORAGE_KEYS.state].notes, []);
  assert.equal(storage.values[STORAGE_KEYS.dataEpoch], "epoch-after");
  assert.equal(storage.values[STORAGE_KEYS.resetCleanup], "epoch-after");
  assert.equal(STORAGE_KEYS.pendingCaptures in storage.values, true);
  assert.equal(STORAGE_KEYS.recovery in storage.values, false);

  const resumedEpoch = await loadDataEpoch(storage, { lockManager: null });

  assert.equal(resumedEpoch, "epoch-after");
  assert.equal(STORAGE_KEYS.resetCleanup in storage.values, false);
  assert.equal(STORAGE_KEYS.pendingCaptures in storage.values, false);
  assert.equal(STORAGE_KEYS.helpSeen in storage.values, false);
  assert.deepEqual(storage.values[STORAGE_KEYS.state].notes, []);
});
