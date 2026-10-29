import {
  addNote,
  createEmptyState,
  isValidIdentifier,
  LIMITS,
  normalizeDraft,
  normalizeEditorDraft,
  normalizeState,
  recoverState,
  safeTextPrefix,
  ValidationError,
} from "./model.js";

export const STORAGE_KEYS = Object.freeze({
  state: "lectureNoteState",
  dataEpoch: "lectureNoteDataEpoch",
  dataConsent: "lectureNoteDataConsent",
  resetCleanup: "lectureNoteResetCleanup",
  draft: "lectureNoteDraft",
  editorDraft: "lectureNoteEditorDraft",
  pendingCaptures: "lectureNotePendingCaptures",
  recovery: "lectureNoteRecovery",
  helpSeen: "lectureNoteHelpSeen",
  legacyResult: "result",
  legacySelection: "selectedText",
});

const STATE_LOCK = "lecture-note-state";
const POPUP_DRAFT_VERSION = 1;
const EDITOR_DRAFT_VERSION = 1;
const PENDING_CAPTURE_VERSION = 1;
const DATA_CONSENT_VERSION = 1;
const DATA_EPOCH_ATTEMPTS = 25;
const RESET_CLEANUP_KEYS = Object.freeze([
  STORAGE_KEYS.dataConsent,
  STORAGE_KEYS.pendingCaptures,
  STORAGE_KEYS.recovery,
  STORAGE_KEYS.helpSeen,
  STORAGE_KEYS.legacyResult,
  STORAGE_KEYS.legacySelection,
]);
export const MAX_PENDING_CAPTURES = 10;
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

function assertPopupDraftFits(value) {
  if (encodedBytes(value) > LIMITS.popupDraftBytes) {
    throw new ValidationError(
      "The popup draft is too large for local storage. Copy its text before closing.",
      "popup-draft-size",
    );
  }
}

function assertPendingCapturesFit(value) {
  if (encodedBytes(value) > LIMITS.pendingCapturesBytes) {
    throw new ValidationError(
      "The pending capture queue needs too much local storage. Finish or discard a capture before adding another.",
      "pending-capture-size",
    );
  }
}

function emptyPopupDraftRecord() {
  return {
    version: POPUP_DRAFT_VERSION,
    ownerSessionId: "",
    generation: 0,
    contentGeneration: 0,
    draft: null,
  };
}

function normalizePopupDraftRecord(value, options = {}) {
  if (value === undefined || value === null) {
    return emptyPopupDraftRecord();
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("The saved popup draft record is invalid.", "popup-draft-record");
  }

  if ("version" in value && "draft" in value && value.version !== POPUP_DRAFT_VERSION) {
    throw new ValidationError(
      "The saved popup draft version is not supported.",
      "popup-draft-version",
    );
  }

  if (value.version !== POPUP_DRAFT_VERSION || !("draft" in value)) {
    const draft = normalizeDraft(value, options);
    const ownerSessionId = draft?.sessionId || "";
    return {
      version: POPUP_DRAFT_VERSION,
      ownerSessionId,
      generation: ownerSessionId ? 1 : 0,
      contentGeneration: 0,
      draft,
    };
  }

  const ownerSessionId = typeof value.ownerSessionId === "string" ? value.ownerSessionId : "";
  const generation = Number.isSafeInteger(value.generation) && value.generation >= 0
    ? value.generation
    : -1;
  const contentGeneration =
    Number.isSafeInteger(value.contentGeneration) && value.contentGeneration >= 0
      ? value.contentGeneration
      : -1;
  if (
    generation < 0 ||
    contentGeneration < 0 ||
    (generation === 0 && (ownerSessionId || contentGeneration !== 0)) ||
    (generation > 0 && !isValidIdentifier(ownerSessionId))
  ) {
    throw new ValidationError("The saved popup draft owner is invalid.", "popup-draft-owner");
  }

  const draft = value.draft === null ? null : normalizeDraft(value.draft, options);
  return {
    version: POPUP_DRAFT_VERSION,
    ownerSessionId,
    generation,
    contentGeneration,
    draft,
  };
}

function samePopupDraftCursor(record, ownerSessionId, generation) {
  return record.ownerSessionId === ownerSessionId && record.generation === generation;
}

function samePopupDraftContent(left, right) {
  if (left === null || right === null) {
    return left === right;
  }
  const { updatedAt: leftUpdatedAt, ...leftContent } = left;
  const { updatedAt: rightUpdatedAt, ...rightContent } = right;
  void leftUpdatedAt;
  void rightUpdatedAt;
  return sameData(leftContent, rightContent);
}

function emptyPendingCaptureRecord() {
  return {
    version: PENDING_CAPTURE_VERSION,
    captures: [],
  };
}

function normalizePendingCapture(value, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("A pending capture is invalid.", "pending-capture-type");
  }
  if (!isValidIdentifier(value.id)) {
    throw new ValidationError("A pending capture ID is invalid.", "pending-capture-id");
  }
  const draft = normalizeDraft(
    {
      title: value.title,
      body: value.text,
      course: "",
      source: { title: value.title, url: value.url },
      updatedAt: value.createdAt,
    },
    options,
  );
  if (!draft?.body) {
    throw new ValidationError("A pending capture has no note text.", "pending-capture-empty");
  }
  return {
    id: value.id,
    title: draft.title,
    text: draft.body,
    url: draft.source.url,
    wasTruncated: value.wasTruncated === true,
    createdAt: draft.updatedAt,
  };
}

function normalizePendingCaptureRecord(value, options = {}) {
  if (value === undefined || value === null) {
    return emptyPendingCaptureRecord();
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== PENDING_CAPTURE_VERSION ||
    !Array.isArray(value.captures)
  ) {
    throw new ValidationError(
      "The pending capture queue is invalid.",
      "pending-capture-record",
    );
  }
  if (value.captures.length > MAX_PENDING_CAPTURES) {
    throw new ValidationError(
      "The pending capture queue contains too many items.",
      "pending-capture-limit",
    );
  }
  const captures = value.captures.map((capture) => normalizePendingCapture(capture, options));
  if (new Set(captures.map((capture) => capture.id)).size !== captures.length) {
    throw new ValidationError(
      "The pending capture queue contains duplicate IDs.",
      "pending-capture-duplicate",
    );
  }
  return { version: PENDING_CAPTURE_VERSION, captures };
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

function createDataEpoch(epochFactory, previousEpoch = "") {
  for (let attempt = 0; attempt < DATA_EPOCH_ATTEMPTS; attempt += 1) {
    const candidate = epochFactory();
    if (isValidIdentifier(candidate) && candidate !== previousEpoch) {
      return candidate;
    }
  }
  throw new ValidationError("A new data reset token could not be created.", "data-epoch-create");
}

async function removeResetAncillaryData(area) {
  if (typeof area.remove !== "function") {
    throw new TypeError("The storage area cannot finish a data reset.");
  }
  await area.remove(RESET_CLEANUP_KEYS);
  await area.remove(STORAGE_KEYS.resetCleanup);
}

async function loadDataEpochUnlocked(area, options = {}) {
  const stored = await area.get([STORAGE_KEYS.dataEpoch, STORAGE_KEYS.resetCleanup]);
  const storedEpoch = stored[STORAGE_KEYS.dataEpoch];
  const epoch = isValidIdentifier(storedEpoch)
    ? storedEpoch
    : createDataEpoch(options.epochFactory || (() => crypto.randomUUID()));

  if (epoch !== storedEpoch) {
    await area.set({ [STORAGE_KEYS.dataEpoch]: epoch });
  }

  if (stored[STORAGE_KEYS.resetCleanup] !== undefined) {
    if (stored[STORAGE_KEYS.resetCleanup] === epoch) {
      await removeResetAncillaryData(area);
    } else {
      if (typeof area.remove !== "function") {
        throw new TypeError("The storage area cannot remove an invalid reset marker.");
      }
      await area.remove(STORAGE_KEYS.resetCleanup);
    }
  }
  return epoch;
}

function validateExpectedDataEpoch(options) {
  if (options.expectedEpoch !== undefined && !isValidIdentifier(options.expectedEpoch)) {
    throw new ValidationError("The expected data reset token is invalid.", "data-epoch-invalid");
  }
}

function throwDataResetConflict() {
  throw new ValidationError(
    "The note data was reset in another window. This older change was not saved.",
    "data-reset",
  );
}

async function assertExistingExpectedDataEpochUnlocked(area, options = {}) {
  validateExpectedDataEpoch(options);
  if (options.expectedEpoch === undefined) {
    return;
  }
  const stored = await area.get(STORAGE_KEYS.dataEpoch);
  const epoch = stored[STORAGE_KEYS.dataEpoch];
  if (options.expectedEpoch !== epoch) {
    throwDataResetConflict();
  }
}

async function assertExpectedDataEpochUnlocked(area, options = {}) {
  validateExpectedDataEpoch(options);
  if (options.expectedEpoch !== undefined) {
    await assertExistingExpectedDataEpochUnlocked(area, options);
    return options.expectedEpoch;
  }
  const epoch = await loadDataEpochUnlocked(area, options);
  return epoch;
}

export async function loadDataEpoch(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(() => loadDataEpochUnlocked(area, options), lockManager);
}

export async function loadDataConsent(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(async () => {
    validateExpectedDataEpoch(options);
    const stored = await area.get([STORAGE_KEYS.dataConsent, STORAGE_KEYS.dataEpoch]);
    const consent = stored[STORAGE_KEYS.dataConsent];
    const epoch = stored[STORAGE_KEYS.dataEpoch];
    if (options.expectedEpoch !== undefined && epoch !== options.expectedEpoch) {
      throwDataResetConflict();
    }
    const accepted = Boolean(
      consent &&
        typeof consent === "object" &&
        !Array.isArray(consent) &&
        consent.version === DATA_CONSENT_VERSION &&
        consent.accepted === true &&
        isValidIdentifier(epoch) &&
        consent.epoch === epoch,
    );
    return accepted ? epoch : null;
  }, lockManager);
}

export async function saveDataConsent(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(async () => {
    const epoch = await assertExpectedDataEpochUnlocked(area, options);
    await area.set({
      [STORAGE_KEYS.dataConsent]: {
        version: DATA_CONSENT_VERSION,
        epoch,
        accepted: true,
      },
    });
    await assertExpectedDataEpochUnlocked(area, { expectedEpoch: epoch });
    return epoch;
  }, lockManager);
}

export async function clearStoredDataBeforeConsent(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks } = {},
) {
  const area = getStorage(storage);
  if (typeof area.clear !== "function") {
    throw new TypeError("The storage area cannot clear saved extension data.");
  }
  return withStateLock(async () => {
    await area.clear();
    return true;
  }, lockManager);
}

export async function loadHelpSeen(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(async () => {
    const epoch = await assertExpectedDataEpochUnlocked(area, options);
    const stored = await area.get(STORAGE_KEYS.helpSeen);
    const rawValue = stored[STORAGE_KEYS.helpSeen];
    const seen = rawValue === true || (
      rawValue?.version === 1 &&
      rawValue.epoch === epoch &&
      rawValue.seen === true
    );
    if (rawValue === true) {
      await assertExpectedDataEpochUnlocked(area, options);
      await area.set({
        [STORAGE_KEYS.helpSeen]: { version: 1, epoch, seen: true },
      });
    }
    await assertExpectedDataEpochUnlocked(area, options);
    return seen;
  }, lockManager);
}

export async function saveHelpSeen(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(async () => {
    const epoch = await assertExpectedDataEpochUnlocked(area, options);
    await area.set({
      [STORAGE_KEYS.helpSeen]: { version: 1, epoch, seen: true },
    });
    await assertExpectedDataEpochUnlocked(area, options);
    return true;
  }, lockManager);
}

function nextDraftTombstoneGeneration(value) {
  if (Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER) {
    return value + 1;
  }
  return 1;
}

function createDraftTombstone(version, value, ownerSessionId) {
  return {
    version,
    ownerSessionId,
    generation: nextDraftTombstoneGeneration(value?.generation),
    contentGeneration: nextDraftTombstoneGeneration(value?.contentGeneration),
    draft: null,
  };
}

export async function resetAllData(
  storage = chrome.storage.local,
  {
    lockManager = globalThis.navigator?.locks,
    epochFactory = () => crypto.randomUUID(),
    expectedEpoch,
    expectedRevision,
  } = {},
) {
  const area = getStorage(storage);
  return withStateLock(async () => {
    const currentEpoch = await assertExpectedDataEpochUnlocked(area, {
      epochFactory,
      expectedEpoch,
    });
    const nextEpoch = createDataEpoch(epochFactory, currentEpoch);
    const stored = await area.get([
      STORAGE_KEYS.state,
      STORAGE_KEYS.draft,
      STORAGE_KEYS.editorDraft,
    ]);
    const storedRevision = stored[STORAGE_KEYS.state]?.revision;
    const currentRevision = Number.isSafeInteger(storedRevision) && storedRevision >= 0
      ? storedRevision
      : 0;
    if (
      expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    ) {
      throw new ValidationError("The expected library revision is invalid.", "revision-invalid");
    }
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      throw new ValidationError(
        "The note library changed after the data reset was reviewed.",
        "state-conflict",
      );
    }
    if (currentRevision === Number.MAX_SAFE_INTEGER) {
      throw new ValidationError("The note library revision cannot be advanced.", "revision-invalid");
    }

    const state = {
      ...createEmptyState(),
      revision: currentRevision + 1,
    };
    const resetOwnerSessionId = `reset_${nextEpoch}`;
    const popupDraftRecord = createDraftTombstone(
      POPUP_DRAFT_VERSION,
      stored[STORAGE_KEYS.draft],
      resetOwnerSessionId,
    );
    const editorDraftRecord = createDraftTombstone(
      EDITOR_DRAFT_VERSION,
      stored[STORAGE_KEYS.editorDraft],
      resetOwnerSessionId,
    );
    assertStateFits(state);
    await area.set({
      [STORAGE_KEYS.state]: state,
      [STORAGE_KEYS.dataEpoch]: nextEpoch,
      [STORAGE_KEYS.dataConsent]: {
        version: DATA_CONSENT_VERSION,
        epoch: nextEpoch,
        accepted: false,
      },
      [STORAGE_KEYS.resetCleanup]: nextEpoch,
      [STORAGE_KEYS.draft]: popupDraftRecord,
      [STORAGE_KEYS.editorDraft]: editorDraftRecord,
    });
    await removeResetAncillaryData(area);

    return {
      state,
      epoch: nextEpoch,
      popupDraftRecord,
      editorDraftRecord,
    };
  }, lockManager);
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
  let preservePopupDraft = false;
  if (stored[STORAGE_KEYS.draft] !== undefined) {
    try {
      const draftRecord = normalizePopupDraftRecord(stored[STORAGE_KEYS.draft], options);
      draft = draftRecord.draft;
      if (!sameData(stored[STORAGE_KEYS.draft], draftRecord)) {
        updates[STORAGE_KEYS.draft] = draftRecord;
      }
    } catch (error) {
      if (
        error instanceof ValidationError &&
        error.code === "popup-draft-version" &&
        Number.isSafeInteger(stored[STORAGE_KEYS.draft]?.version) &&
        stored[STORAGE_KEYS.draft].version > POPUP_DRAFT_VERSION
      ) {
        preservePopupDraft = true;
      } else {
        recovery = appendRecovery(recovery || stored[STORAGE_KEYS.recovery], {
          createdAt: now,
          rejectedDrafts: 1,
        });
        updates[STORAGE_KEYS.draft] = emptyPopupDraftRecord();
        updates[STORAGE_KEYS.recovery] = recovery;
      }
      draft = null;
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
  if (
    !preservePopupDraft &&
    !draft &&
    typeof legacySelection === "string" &&
    legacySelection.trim()
  ) {
    const truncated = legacySelection.length > LIMITS.body;
    draft = normalizeDraft({ body: safeTextPrefix(legacySelection, LIMITS.body) }, options);
    updates[STORAGE_KEYS.draft] = {
      ...emptyPopupDraftRecord(),
      draft,
    };
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
    await assertExpectedDataEpochUnlocked(area, options);
    await area.set(updates);
  }

  const legacyKeys = [STORAGE_KEYS.legacyResult, STORAGE_KEYS.legacySelection].filter(
    (key) =>
      stored[key] !== undefined &&
      !(preservePopupDraft && key === STORAGE_KEYS.legacySelection),
  );
  if (legacyKeys.length > 0) {
    if (typeof area.remove !== "function") {
      throw new TypeError("The storage area cannot finish data migration.");
    }
    await assertExpectedDataEpochUnlocked(area, options);
    await area.remove(legacyKeys);
  }

  return state;
}

export async function loadState(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(async () => {
    await assertExpectedDataEpochUnlocked(area, options);
    const state = await loadStateUnlocked(area, options);
    await assertExpectedDataEpochUnlocked(area, options);
    return state;
  }, lockManager);
}

async function saveStateUnlocked(value, area, options, epochChecked = false) {
  if (!epochChecked) {
    await assertExpectedDataEpochUnlocked(area, options);
  }
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
    await assertExpectedDataEpochUnlocked(area, options);
    const current = await loadStateUnlocked(area, options);
    const result = await mutation(current);
    const nextState = result?.state || result;
    if (sameData(nextState, current)) {
      return result;
    }
    const saved = await saveStateUnlocked(
      nextState,
      area,
      {
        ...options,
        expectedRevision: current.revision,
      },
      true,
    );
    if (result && typeof result === "object" && "state" in result) {
      return { ...result, state: saved };
    }
    return saved;
  }, lockManager);
}

async function loadPendingCapturesUnlocked(area, options = {}) {
  const stored = await area.get(STORAGE_KEYS.pendingCaptures);
  const rawRecord = stored[STORAGE_KEYS.pendingCaptures];
  const record = normalizePendingCaptureRecord(rawRecord, options);
  if (rawRecord !== undefined && !sameData(rawRecord, record)) {
    await assertExpectedDataEpochUnlocked(area, options);
    await area.set({ [STORAGE_KEYS.pendingCaptures]: record });
  }
  return record;
}

export async function loadPendingCaptures(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  const record = await withStateLock(async () => {
    await assertExpectedDataEpochUnlocked(area, options);
    const current = await loadPendingCapturesUnlocked(area, options);
    await assertExpectedDataEpochUnlocked(area, options);
    return current;
  }, lockManager);
  return record.captures;
}

export async function enqueuePendingCapture(
  value,
  storage = chrome.storage.local,
  {
    lockManager = globalThis.navigator?.locks,
    idFactory = () => crypto.randomUUID(),
    now = new Date().toISOString(),
    ...options
  } = {},
) {
  const area = getStorage(storage);
  return withStateLock(async () => {
    await assertExpectedDataEpochUnlocked(area, options);
    const current = await loadPendingCapturesUnlocked(area, { ...options, now });
    if (current.captures.length >= MAX_PENDING_CAPTURES) {
      throw new ValidationError(
        `Finish or discard a captured selection before adding more than ${MAX_PENDING_CAPTURES}.`,
        "pending-capture-full",
      );
    }
    const capture = normalizePendingCapture(
      {
        ...value,
        id: value?.id || idFactory(),
        createdAt: value?.createdAt || now,
      },
      { ...options, now },
    );
    if (current.captures.some((item) => item.id === capture.id)) {
      throw new ValidationError(
        "A pending capture with this ID already exists.",
        "pending-capture-duplicate",
      );
    }
    const captures = [...current.captures, capture];
    const record = {
      version: PENDING_CAPTURE_VERSION,
      captures,
    };
    assertPendingCapturesFit(record);
    await area.set({
      [STORAGE_KEYS.pendingCaptures]: record,
    });
    return { capture, captures };
  }, lockManager);
}

export async function removePendingCapture(
  identifier,
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  if (!isValidIdentifier(identifier)) {
    throw new ValidationError("The pending capture ID is invalid.", "pending-capture-id");
  }
  const area = getStorage(storage);
  return withStateLock(async () => {
    await assertExpectedDataEpochUnlocked(area, options);
    const current = await loadPendingCapturesUnlocked(area, options);
    const captures = current.captures.filter((capture) => capture.id !== identifier);
    const removed = captures.length !== current.captures.length;
    if (removed) {
      await area.set({
        [STORAGE_KEYS.pendingCaptures]: {
          version: PENDING_CAPTURE_VERSION,
          captures,
        },
      });
    }
    return { removed, captures };
  }, lockManager);
}

async function loadPopupDraftUnlocked(area, options = {}) {
  const stored = await area.get(STORAGE_KEYS.draft);
  const rawRecord = stored[STORAGE_KEYS.draft];
  const record = normalizePopupDraftRecord(rawRecord, options);
  if (rawRecord !== undefined && !sameData(rawRecord, record)) {
    await assertExpectedDataEpochUnlocked(area, options);
    await area.set({ [STORAGE_KEYS.draft]: record });
  }
  return record;
}

export async function loadPopupDraft(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(async () => {
    await assertExpectedDataEpochUnlocked(area, options);
    const record = await loadPopupDraftUnlocked(area, options);
    await assertExpectedDataEpochUnlocked(area, options);
    return record;
  }, lockManager);
}

export async function loadDraft(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const record = await loadPopupDraft(storage, { lockManager, ...options });
  return record.draft;
}

async function clearDraftUnlocked(area, { expectedSessionId, allowUnowned = false } = {}) {
  if (typeof area.remove !== "function") {
    throw new TypeError("The storage area cannot remove draft data.");
  }
  if (expectedSessionId) {
    const stored = await area.get(STORAGE_KEYS.draft);
    const current = normalizePopupDraftRecord(stored[STORAGE_KEYS.draft]);
    if (current.draft) {
      const currentSessionId = current.ownerSessionId || current.draft.sessionId;
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
    await assertExpectedDataEpochUnlocked(area, options);
    const draft = normalizeDraft(value, options);
    if (!draft) {
      await clearDraftUnlocked(area);
      return null;
    }
    const current = await loadPopupDraftUnlocked(area, options);
    const ownerSessionId = draft.sessionId;
    const record = {
      version: POPUP_DRAFT_VERSION,
      ownerSessionId,
      generation: ownerSessionId ? current.generation + 1 : 0,
      contentGeneration: ownerSessionId ? current.contentGeneration + 1 : 0,
      draft,
    };
    assertPopupDraftFits(record);
    await area.set({ [STORAGE_KEYS.draft]: record });
    return draft;
  }, lockManager);
}

export async function clearDraft(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(async () => {
    await assertExpectedDataEpochUnlocked(area, options);
    return clearDraftUnlocked(area, options);
  }, lockManager);
}

async function writePopupDraftUnlocked(value, area, options) {
  await assertExistingExpectedDataEpochUnlocked(area, options);
  const {
    sessionId,
    expectedOwnerSessionId = "",
    expectedGeneration = 0,
    contentGeneration,
    ...normalizeOptions
  } = options;
  if (!isValidIdentifier(sessionId)) {
    throw new ValidationError("The popup draft session is invalid.", "popup-draft-session");
  }
  if (
    typeof expectedOwnerSessionId !== "string" ||
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration < 0
  ) {
    throw new ValidationError("The popup draft cursor is invalid.", "popup-draft-cursor");
  }
  if (!Number.isSafeInteger(contentGeneration) || contentGeneration < 0) {
    throw new ValidationError(
      "The popup draft content generation is invalid.",
      "popup-draft-content-generation",
    );
  }

  const current = await loadPopupDraftUnlocked(area, normalizeOptions);
  const draft = value === null ? null : normalizeDraft(value, normalizeOptions);
  await assertExpectedDataEpochUnlocked(area, options);
  const cursorMatches = samePopupDraftCursor(
    current,
    expectedOwnerSessionId,
    expectedGeneration,
  );
  const sameSession = current.ownerSessionId === sessionId;
  if (
    sameSession &&
    contentGeneration === current.contentGeneration &&
    samePopupDraftContent(current.draft, draft)
  ) {
    return { saved: true, record: current };
  }
  const supersedesSameSession = sameSession && contentGeneration > current.contentGeneration;
  if (!cursorMatches && !supersedesSameSession) {
    return { saved: false, record: current };
  }
  if (sameSession && contentGeneration <= current.contentGeneration) {
    return { saved: false, record: current };
  }

  const record = {
    version: POPUP_DRAFT_VERSION,
    ownerSessionId: sessionId,
    generation: current.generation + 1,
    contentGeneration,
    draft,
  };
  assertPopupDraftFits(record);
  await area.set({ [STORAGE_KEYS.draft]: record });
  return { saved: true, record };
}

export async function savePopupDraft(
  value,
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(() => writePopupDraftUnlocked(value, area, options), lockManager);
}

export async function clearPopupDraft(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(() => writePopupDraftUnlocked(null, area, options), lockManager);
}

export async function mutateStateAndClearPopupDraft(
  mutation,
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  if (typeof mutation !== "function") {
    throw new TypeError("A state mutation function is required.");
  }

  return withStateLock(async () => {
    const area = getStorage(storage);
    await assertExistingExpectedDataEpochUnlocked(area, options);
    const expectedOwnerSessionId = options.expectedOwnerSessionId ?? "";
    const expectedGeneration = options.expectedGeneration ?? 0;
    if (
      !isValidIdentifier(options.sessionId) ||
      typeof expectedOwnerSessionId !== "string" ||
      !Number.isSafeInteger(expectedGeneration) ||
      expectedGeneration < 0 ||
      !Number.isSafeInteger(options.contentGeneration) ||
      options.contentGeneration < 0
    ) {
      throw new ValidationError("The popup draft cursor is invalid.", "popup-draft-cursor");
    }

    const current = await loadStateUnlocked(area, options);
    const result = await mutation(current);
    const nextState = normalizeState(result?.state || result, options);
    assertStateFits(nextState);
    if (nextState.revision !== current.revision + 1) {
      throw new ValidationError("The note update has an invalid revision.", "revision-invalid");
    }

    const currentDraft = await loadPopupDraftUnlocked(area, options);
    await assertExpectedDataEpochUnlocked(area, options);
    const canClear = samePopupDraftCursor(
      currentDraft,
      expectedOwnerSessionId,
      expectedGeneration,
    );
    const updates = { [STORAGE_KEYS.state]: nextState };
    let popupDraftRecord = currentDraft;
    if (canClear) {
      popupDraftRecord = {
        version: POPUP_DRAFT_VERSION,
        ownerSessionId: options.sessionId,
        generation: currentDraft.generation + 1,
        contentGeneration: Math.max(
          currentDraft.contentGeneration + 1,
          options.contentGeneration,
        ),
        draft: null,
      };
      updates[STORAGE_KEYS.draft] = popupDraftRecord;
    }

    await area.set(updates);
    return {
      ...(result && typeof result === "object" && "state" in result ? result : {}),
      state: nextState,
      popupDraftCleared: canClear,
      popupDraftRecord,
    };
  }, lockManager);
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
    await assertExpectedDataEpochUnlocked(area, options);
    await area.set({
      [STORAGE_KEYS.editorDraft]: record,
      [STORAGE_KEYS.recovery]: recovery,
    });
    return record;
  }
  if (rawRecord !== undefined && !sameData(rawRecord, record)) {
    assertEditorDraftFits(record);
    await assertExpectedDataEpochUnlocked(area, options);
    await area.set({ [STORAGE_KEYS.editorDraft]: record });
  }
  return record;
}

export async function loadEditorDraft(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(async () => {
    await assertExpectedDataEpochUnlocked(area, options);
    const record = await loadEditorDraftUnlocked(area, options);
    await assertExpectedDataEpochUnlocked(area, options);
    return record;
  }, lockManager);
}

async function writeEditorDraftUnlocked(value, area, options) {
  await assertExistingExpectedDataEpochUnlocked(area, options);
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
  await assertExpectedDataEpochUnlocked(area, options);
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
    await assertExistingExpectedDataEpochUnlocked(area, options);
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
    await assertExpectedDataEpochUnlocked(area, options);
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

function emptyRecoveryNotice() {
  return { createdAt: "", rejectedNotes: 0, rejectedDrafts: 0 };
}

export async function loadRecoveryNotice(
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(async () => {
    await assertExpectedDataEpochUnlocked(area, options);
    const stored = await area.get(STORAGE_KEYS.recovery);
    const recovery = normalizeRecovery(stored[STORAGE_KEYS.recovery]) || emptyRecoveryNotice();
    await assertExpectedDataEpochUnlocked(area, options);
    return recovery;
  }, lockManager);
}

export async function loadRecoveryInfo(storage = chrome.storage.local, options = {}) {
  const recovery = await loadRecoveryNotice(storage, options);
  return {
    rejectedNotes: recovery.rejectedNotes,
    rejectedDrafts: recovery.rejectedDrafts,
  };
}

export async function acknowledgeRecovery(
  expectedValue,
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  const area = getStorage(storage);
  return withStateLock(async () => {
    await assertExpectedDataEpochUnlocked(area, options);
    const stored = await area.get(STORAGE_KEYS.recovery);
    const current = normalizeRecovery(stored[STORAGE_KEYS.recovery]);
    if (!current) {
      return { acknowledged: true, recovery: emptyRecoveryNotice() };
    }

    const expected = normalizeRecovery(expectedValue);
    if (!expected || !sameData(current, expected)) {
      return { acknowledged: false, recovery: current };
    }
    if (typeof area.remove !== "function") {
      throw new TypeError("The storage area cannot acknowledge recovery data.");
    }
    await area.remove(STORAGE_KEYS.recovery);
    return { acknowledged: true, recovery: emptyRecoveryNotice() };
  }, lockManager);
}
