import {
  addNote,
  createEmptyState,
  normalizeDraft,
  normalizeState,
  recoverState,
  ValidationError,
} from "./model.js";

export const STORAGE_KEYS = Object.freeze({
  state: "lectureNoteState",
  draft: "lectureNoteDraft",
  recovery: "lectureNoteRecovery",
  legacyResult: "result",
  legacySelection: "selectedText",
});

const STATE_LOCK = "lecture-note-state";
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

async function withStateLock(task, lockManager = globalThis.navigator?.locks) {
  if (lockManager && typeof lockManager.request === "function") {
    return lockManager.request(STATE_LOCK, task);
  }

  const result = localMutationQueue.then(task, task);
  localMutationQueue = result.catch(() => undefined);
  return result;
}

function appendRecovery(existing, update) {
  const prior = existing && typeof existing === "object" ? existing : {};
  const priorNotes = Array.isArray(prior.rejectedNotes) ? prior.rejectedNotes : [];
  const priorDrafts = Array.isArray(prior.rejectedDrafts) ? prior.rejectedDrafts : [];
  return {
    createdAt: update.createdAt,
    rejectedNotes: [...priorNotes, ...(update.rejectedNotes || [])],
    rejectedDrafts: [...priorDrafts, ...(update.rejectedDrafts || [])],
  };
}

export async function loadState(storage = chrome.storage.local, options = {}) {
  const area = getStorage(storage);
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
  let recovery = null;

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
        rejectedNotes: recovered.rejected,
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
    } catch (error) {
      recovery = appendRecovery(recovery || stored[STORAGE_KEYS.recovery], {
        createdAt: now,
        rejectedDrafts: [
          {
            draft: stored[STORAGE_KEYS.draft],
            reason: error instanceof Error ? error.message : "Invalid draft",
          },
        ],
      });
      draft = null;
      updates[STORAGE_KEYS.draft] = null;
      updates[STORAGE_KEYS.recovery] = recovery;
    }
  }

  const legacyResult = stored[STORAGE_KEYS.legacyResult];
  if (typeof legacyResult === "string" && legacyResult.trim()) {
    try {
      const added = addNote(
        state,
        {
          title: "Imported generated note",
          body: legacyResult,
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
  }

  const legacySelection = stored[STORAGE_KEYS.legacySelection];
  if (!draft && typeof legacySelection === "string" && legacySelection.trim()) {
    draft = normalizeDraft({ body: legacySelection }, options);
    updates[STORAGE_KEYS.draft] = draft;
  }

  if (Object.keys(updates).length > 0) {
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

export async function saveState(value, storage = chrome.storage.local, options = {}) {
  const area = getStorage(storage);
  const state = normalizeState(value, options);
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

export async function mutateState(
  mutation,
  storage = chrome.storage.local,
  { lockManager = globalThis.navigator?.locks, ...options } = {},
) {
  if (typeof mutation !== "function") {
    throw new TypeError("A state mutation function is required.");
  }

  return withStateLock(async () => {
    const current = await loadState(storage, options);
    const result = await mutation(current);
    const nextState = result?.state || result;
    const saved = await saveState(nextState, storage, {
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

export async function saveDraft(value, storage = chrome.storage.local, options = {}) {
  const area = getStorage(storage);
  const draft = normalizeDraft(value, options);
  if (!draft) {
    await clearDraft(area);
    return null;
  }
  await area.set({ [STORAGE_KEYS.draft]: draft });
  return draft;
}

export async function clearDraft(storage = chrome.storage.local) {
  const area = getStorage(storage);
  if (typeof area.remove !== "function") {
    throw new TypeError("The storage area cannot remove draft data.");
  }
  await area.remove(STORAGE_KEYS.draft);
}

export async function loadRecoveryInfo(storage = chrome.storage.local) {
  const area = getStorage(storage);
  const stored = await area.get(STORAGE_KEYS.recovery);
  const recovery = stored[STORAGE_KEYS.recovery];
  return {
    rejectedNotes: Array.isArray(recovery?.rejectedNotes) ? recovery.rejectedNotes.length : 0,
    rejectedDrafts: Array.isArray(recovery?.rejectedDrafts) ? recovery.rejectedDrafts.length : 0,
  };
}
