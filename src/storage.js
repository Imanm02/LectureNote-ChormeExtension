import {
  addNote,
  createEmptyState,
  isValidIdentifier,
  LIMITS,
  normalizeDraft,
  normalizeEditorDraft,
  normalizeState,
  recoverState,
  ValidationError,
} from "./model.js";

export const STORAGE_KEYS = Object.freeze({
  state: "lectureNoteState",
  draft: "lectureNoteDraft",
  editorDraft: "lectureNoteEditorDraft",
  recovery: "lectureNoteRecovery",
  legacyResult: "result",
  legacySelection: "selectedText",
});

const STATE_LOCK = "lecture-note-state";
const EDITOR_DRAFT_VERSION = 1;
let localMutationQueue = Promise.resolve();

function getStorage(storage) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new TypeError("A Chrome storage area is required.");
  }
  return storage;
}

function sameData(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function encodedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function safeTextPrefix(value, maximumLength) {
  let result = value.slice(0, maximumLength);
  const lastCodeUnit = result.charCodeAt(result.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    result = result.slice(0, -1);
  }
  return result;
}

export function assertStateFits(value) {
  if (encodedBytes(value) > LIMITS.stateBytes) {
    throw new ValidationError(
      "The note library is too large for local storage. Export a backup and remove some notes.",
      "storage-size",
    );
  }
}

function assertEditorDraftFits(value) {
  if (encodedBytes(value) > LIMITS.editorDraftBytes) {
    throw new ValidationError(
      "The editor draft is too large for local storage. Copy its text before closing.",
      "editor-draft-size",
    );
  }
}

function emptyEditorDraftRecord() {
  return {
    version: EDITOR_DRAFT_VERSION,
    ownerSessionId: "",
    generation: 0,
    contentGeneration: 0,
    draft: null,
  };
}

function normalizeEditorDraftRecord(value, options = {}) {
  if (value === undefined || value === null) {
    return emptyEditorDraftRecord();
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("The saved editor draft record is invalid.", "editor-draft-record");
  }
  if (value.version !== EDITOR_DRAFT_VERSION) {
    throw new ValidationError("The saved editor draft version is not supported.", "editor-draft-version");
  }

  const ownerSessionId = typeof value.ownerSessionId === "string" ? value.ownerSessionId : "";
  const generation = Number.isSafeInteger(value.generation) && value.generation >= 0
    ? value.generation
    : -1;
  const contentGeneration = Number.isSafeInteger(value.contentGeneration) && value.contentGeneration >= 0
    ? value.contentGeneration
    : 0;
  if (
    generation < 0 ||
    (generation === 0 && (ownerSessionId || contentGeneration !== 0)) ||
    (generation > 0 && !isValidIdentifier(ownerSessionId))
  ) {
    throw new ValidationError("The saved editor draft owner is invalid.", "editor-draft-owner");
  }

  const draft = value.draft === null ? null : normalizeEditorDraft(value.draft, options);
  if (draft && (!isValidIdentifier(ownerSessionId) || generation === 0)) {
    throw new ValidationError("The saved editor draft owner is missing.", "editor-draft-owner");
  }
  return { version: EDITOR_DRAFT_VERSION, ownerSessionId, generation, contentGeneration, draft };
}

function sameEditorDraftCursor(record, ownerSessionId, generation) {
  return record.ownerSessionId === ownerSessionId && record.generation === generation;
}

function sameEditorDraftContent(left, right) {
  if (left === null || right === null) {
    return left === right;
  }
  const { updatedAt: leftUpdatedAt, ...leftContent } = left;
  const { updatedAt: rightUpdatedAt, ...rightContent } = right;
  void leftUpdatedAt;
  void rightUpdatedAt;
  return sameData(leftContent, rightContent);
}

async function withStateLock(task, lockManager = globalThis.navigator?.locks) {
  if (lockManager && typeof lockManager.request === "function") {
    return lockManager.request(STATE_LOCK, task);
  }

  const result = localMutationQueue.then(task, task);
  localMutationQueue = result.catch(() => undefined);
  return result;
}

function recoveryCount(value, key) {
  const stored = value?.[key];
  if (Array.isArray(stored)) {
    return stored.length;
  }
  return Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
}

function normalizeRecovery(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    rejectedNotes: recoveryCount(value, "rejectedNotes"),
    rejectedDrafts: recoveryCount(value, "rejectedDrafts"),
  };
}

function appendRecovery(existing, update) {
  const prior = existing && typeof existing === "object" ? existing : {};
  return {
    createdAt: update.createdAt,
    rejectedNotes: recoveryCount(prior, "rejectedNotes") + (update.rejectedNotes || 0),
    rejectedDrafts: recoveryCount(prior, "rejectedDrafts") + (update.rejectedDrafts || 0),
  };
}

async function loadStateUnlocked(area, options) {
  const stored = await area.get([
    STORAGE_KEYS.state,
    STORAGE_KEYS.draft,
    STORAGE_KEYS.recovery,
    STORAGE_KEYS.legacyResult,
    STORAGE_KEYS.legacySelection,
  ]);
  const now = options.now || new Date().toISOString();
  const updates = {};
  let state;
  let recovery = normalizeRecovery(stored[STORAGE_KEYS.recovery]);

  if (
    stored[STORAGE_KEYS.recovery] !== undefined &&
    !sameData(stored[STORAGE_KEYS.recovery], recovery)
  ) {
    updates[STORAGE_KEYS.recovery] = recovery;
  }

  if (stored[STORAGE_KEYS.state] === undefined) {
    state = createEmptyState();
    updates[STORAGE_KEYS.state] = state;
  } else {
    try {
      state = normalizeState(stored[STORAGE_KEYS.state], options);
      if (!sameData(stored[STORAGE_KEYS.state], state)) {
        updates[STORAGE_KEYS.state] = state;
      }
    } catch {
      const recovered = recoverState(stored[STORAGE_KEYS.state], options);
      state = recovered.state;
      recovery = appendRecovery(stored[STORAGE_KEYS.recovery], {
        createdAt: now,
        rejectedNotes: recovered.rejected.length,
      });
      updates[STORAGE_KEYS.state] = state;
      updates[STORAGE_KEYS.recovery] = recovery;
    }
  }

  let draft = null;
  if (stored[STORAGE_KEYS.draft] !== undefined) {
    try {
      draft = normalizeDraft(stored[STORAGE_KEYS.draft], options);
      if (!sameData(stored[STORAGE_KEYS.draft], draft)) {
        updates[STORAGE_KEYS.draft] = draft;
      }
    } catch {
      recovery = appendRecovery(recovery || stored[STORAGE_KEYS.recovery], {
        createdAt: now,
        rejectedDrafts: 1,
      });
      draft = null;
      updates[STORAGE_KEYS.draft] = null;
      updates[STORAGE_KEYS.recovery] = recovery;
    }
  }

  const legacyResult = stored[STORAGE_KEYS.legacyResult];
  if (typeof legacyResult === "string" && legacyResult.trim()) {
    const truncated = legacyResult.length > LIMITS.body;
    try {
      const added = addNote(
        state,
        {
          title: "Imported generated note",
          body: safeTextPrefix(legacyResult, LIMITS.body),
          course: "",
          source: {},
        },
        options,
      );
      state = added.state;
      updates[STORAGE_KEYS.state] = state;
    } catch (error) {
      if (!(error instanceof ValidationError) || error.code !== "duplicate") {
        throw error;
      }
    }
    if (truncated) {
      recovery = appendRecovery(recovery || stored[STORAGE_KEYS.recovery], {
        createdAt: now,
        rejectedNotes: 1,
      });
      updates[STORAGE_KEYS.recovery] = recovery;
    }
  }

  const legacySelection = stored[STORAGE_KEYS.legacySelection];
  if (!draft && typeof legacySelection === "string" && legacySelection.trim()) {
    const truncated = legacySelection.length > LIMITS.body;
    draft = normalizeDraft({ body: safeTextPrefix(legacySelection, LIMITS.body) }, options);
    updates[STORAGE_KEYS.draft] = draft;
    if (truncated) {
      recovery = appendRecovery(recovery || stored[STORAGE_KEYS.recovery], {
        createdAt: now,
        rejectedDrafts: 1,
      });
      updates[STORAGE_KEYS.recovery] = recovery;
    }
  }

  if (Object.keys(updates).length > 0) {
    if (updates[STORAGE_KEYS.state]) {
      assertStateFits(updates[STORAGE_KEYS.state]);
    }
    await area.set(updates);
  }

  const legacyKeys = [STORAGE_KEYS.legacyResult, STORAGE_KEYS.legacySelection].filter(
    (key) => stored[key] !== undefined,
  );
  if (legacyKeys.length > 0) {
    if (typeof area.remove !== "function") {
      throw new TypeError("The storage area cannot finish data migration.");
    }
    await area.remove(legacyKeys);
  }

  return state;
}

export async function loadState(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(() => loadStateUnlocked(area, options), lockManager);
}

async function saveStateUnlocked(value, area, options) {
  const state = normalizeState(value, options);
  assertStateFits(state);
  if (options.expectedRevision !== undefined) {
    const stored = await area.get(STORAGE_KEYS.state);
    const current = normalizeState(stored[STORAGE_KEYS.state], options);
    if (current.revision !== options.expectedRevision) {
      throw new ValidationError(
        "The note library changed in another window. Your edit was not overwritten.",
        "state-conflict",
      );
    }
    if (state.revision !== current.revision + 1) {
      throw new ValidationError("The note update has an invalid revision.", "revision-invalid");
    }
  }

  await area.set({ [STORAGE_KEYS.state]: state });
  return state;
}

export async function saveState(
  value,
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(() => saveStateUnlocked(value, area, options), lockManager);
}

export async function mutateState(
  mutation,
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  if (typeof mutation !== "function") {
    throw new TypeError("A state mutation function is required.");
  }

  return withStateLock(async () => {
    const area = getStorage(storage);
    const current = await loadStateUnlocked(area, options);
    const result = await mutation(current);
    const nextState = result?.state || result;
    if (sameData(nextState, current)) {
      return result;
    }
    const saved = await saveStateUnlocked(nextState, area, {
      ...options,
      expectedRevision: current.revision,
    });
    if (result && typeof result === "object" && "state" in result) {
      return { ...result, state: saved };
    }
    return saved;
  }, lockManager);
}

export async function loadDraft(storage = chrome.storage.local, options = {}) {
  const area = getStorage(storage);
  const stored = await area.get(STORAGE_KEYS.draft);
  return normalizeDraft(stored[STORAGE_KEYS.draft], options);
}

async function clearDraftUnlocked(area, { expectedSessionId, allowUnowned = false } = {}) {
  if (typeof area.remove !== "function") {
    throw new TypeError("The storage area cannot remove draft data.");
  }
  if (expectedSessionId) {
    const stored = await area.get(STORAGE_KEYS.draft);
    const current = stored[STORAGE_KEYS.draft];
    if (current !== undefined && current !== null) {
      const currentSessionId =
        current && typeof current === "object" && typeof current.sessionId === "string"
          ? current.sessionId
          : "";
      if (currentSessionId !== expectedSessionId && !(allowUnowned && !currentSessionId)) {
        return false;
      }
    }
  }
  await area.remove(STORAGE_KEYS.draft);
  return true;
}

export async function saveDraft(
  value,
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(async () => {
    const draft = normalizeDraft(value, options);
    if (!draft) {
      await clearDraftUnlocked(area);
      return null;
    }
    await area.set({ [STORAGE_KEYS.draft]: draft });
    return draft;
  }, lockManager);
}

export async function clearDraft(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(() => clearDraftUnlocked(area, options), lockManager);
}

async function loadEditorDraftUnlocked(area, options = {}) {
  const stored = await area.get([STORAGE_KEYS.editorDraft, STORAGE_KEYS.recovery]);
  const rawRecord = stored[STORAGE_KEYS.editorDraft];
  let record;
  try {
    record = normalizeEditorDraftRecord(rawRecord, options);
  } catch (error) {
    if (
      error instanceof ValidationError &&
      error.code === "editor-draft-version" &&
      Number.isSafeInteger(rawRecord?.version) &&
      rawRecord.version > EDITOR_DRAFT_VERSION
    ) {
      throw error;
    }
    record = emptyEditorDraftRecord();
    const recovery = appendRecovery(stored[STORAGE_KEYS.recovery], {
      createdAt: options.now || new Date().toISOString(),
      rejectedDrafts: 1,
    });
    await area.set({
      [STORAGE_KEYS.editorDraft]: record,
      [STORAGE_KEYS.recovery]: recovery,
    });
    return record;
  }
  if (rawRecord !== undefined && !sameData(rawRecord, record)) {
    assertEditorDraftFits(record);
    await area.set({ [STORAGE_KEYS.editorDraft]: record });
  }
  return record;
}

export async function loadEditorDraft(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(() => loadEditorDraftUnlocked(area, options), lockManager);
}

async function writeEditorDraftUnlocked(value, area, options) {
  const {
    sessionId,
    expectedOwnerSessionId = "",
    expectedGeneration = 0,
    contentGeneration,
    ...normalizeOptions
  } = options;
  if (!isValidIdentifier(sessionId)) {
    throw new ValidationError("The editor draft session is invalid.", "editor-draft-session");
  }
  if (
    typeof expectedOwnerSessionId !== "string" ||
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration < 0
  ) {
    throw new ValidationError("The editor draft cursor is invalid.", "editor-draft-cursor");
  }
  if (
    contentGeneration !== undefined &&
    (!Number.isSafeInteger(contentGeneration) || contentGeneration < 0)
  ) {
    throw new ValidationError("The editor draft content generation is invalid.", "editor-draft-content-generation");
  }

  const current = await loadEditorDraftUnlocked(area, normalizeOptions);
  const draft = value === null ? null : normalizeEditorDraft(value, normalizeOptions);
  const cursorMatches = sameEditorDraftCursor(
    current,
    expectedOwnerSessionId,
    expectedGeneration,
  );
  const sameSession = current.ownerSessionId === sessionId;
  if (
    sameSession &&
    contentGeneration === current.contentGeneration &&
    sameEditorDraftContent(current.draft, draft)
  ) {
    return { saved: true, record: current };
  }
  const supersedesSameSession =
    sameSession &&
    contentGeneration !== undefined &&
    contentGeneration > current.contentGeneration;
  if (!cursorMatches && !supersedesSameSession) {
    return { saved: false, record: current };
  }
  if (
    sameSession &&
    contentGeneration !== undefined &&
    contentGeneration <= current.contentGeneration
  ) {
    return { saved: false, record: current };
  }

  const record = {
    version: EDITOR_DRAFT_VERSION,
    ownerSessionId: sessionId,
    generation: current.generation + 1,
    contentGeneration: contentGeneration ?? current.contentGeneration + 1,
    draft,
  };
  assertEditorDraftFits(record);
  await area.set({ [STORAGE_KEYS.editorDraft]: record });
  return { saved: true, record };
}

export async function saveEditorDraft(
  value,
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(() => writeEditorDraftUnlocked(value, area, options), lockManager);
}

export async function clearEditorDraft(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(() => writeEditorDraftUnlocked(null, area, options), lockManager);
}

export async function mutateStateAndClearEditorDraft(
  mutation,
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  if (typeof mutation !== "function") {
    throw new TypeError("A state mutation function is required.");
  }

  return withStateLock(async () => {
    const area = getStorage(storage);
    const expectedOwnerSessionId = options.expectedOwnerSessionId ?? "";
    const expectedGeneration = options.expectedGeneration ?? 0;
    if (
      typeof expectedOwnerSessionId !== "string" ||
      !Number.isSafeInteger(expectedGeneration) ||
      expectedGeneration < 0
    ) {
      throw new ValidationError("The editor draft cursor is invalid.", "editor-draft-cursor");
    }
    const current = await loadStateUnlocked(area, options);
    const result = await mutation(current);
    const nextState = normalizeState(result?.state || result, options);
    assertStateFits(nextState);
    if (nextState.revision !== current.revision + 1) {
      throw new ValidationError("The note update has an invalid revision.", "revision-invalid");
    }

    const currentDraft = await loadEditorDraftUnlocked(area, options);
    const canClear = sameEditorDraftCursor(
      currentDraft,
      expectedOwnerSessionId,
      expectedGeneration,
    );
    const updates = { [STORAGE_KEYS.state]: nextState };
    let editorDraftRecord = currentDraft;
    if (canClear) {
      if (!isValidIdentifier(options.sessionId)) {
        throw new ValidationError("The editor draft session is invalid.", "editor-draft-session");
      }
      editorDraftRecord = {
        version: EDITOR_DRAFT_VERSION,
        ownerSessionId: options.sessionId,
        generation: currentDraft.generation + 1,
        contentGeneration: currentDraft.contentGeneration + 1,
        draft: null,
      };
      updates[STORAGE_KEYS.editorDraft] = editorDraftRecord;
    }

    await area.set(updates);
    if (result && typeof result === "object" && "state" in result) {
      return {
        ...result,
        state: nextState,
        editorDraftCleared: canClear,
        editorDraftRecord,
      };
    }
    return {
      state: nextState,
      editorDraftCleared: canClear,
      editorDraftRecord,
    };
  }, lockManager);
}

export async function loadRecoveryInfo(storage = chrome.storage.local) {
  const area = getStorage(storage);
  const stored = await area.get(STORAGE_KEYS.recovery);
  const recovery = normalizeRecovery(stored[STORAGE_KEYS.recovery]);
  return {
    rejectedNotes: recovery?.rejectedNotes || 0,
    rejectedDrafts: recovery?.rejectedDrafts || 0,
  };
}
