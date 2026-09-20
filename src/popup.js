import { captureActivePage, CaptureError } from "./capture.js";
import { addNote, LIMITS, normalizeSource, ValidationError } from "./model.js";
import { MESSAGE_TYPES } from "./messages.js";
import {
  clearDraft,
  loadDraft,
  loadRecoveryInfo,
  loadState,
  mutateState,
  saveDraft,
  STORAGE_KEYS,
} from "./storage.js";
import { selectNotes } from "./selectors.js";
import { applyTheme, formatDate, setStatus } from "./ui.js";

function requiredElement(documentValue, identifier) {
  const element = documentValue.getElementById(identifier);
  if (!element) {
    throw new Error(`Missing popup element: ${identifier}`);
  }
  return element;
}

function popupElements(documentValue) {
  return {
    form: requiredElement(documentValue, "noteForm"),
    title: requiredElement(documentValue, "titleInput"),
    course: requiredElement(documentValue, "courseInput"),
    body: requiredElement(documentValue, "bodyInput"),
    bodyCount: requiredElement(documentValue, "bodyCount"),
    sourceTitle: requiredElement(documentValue, "sourceTitle"),
    sourceLink: requiredElement(documentValue, "sourceLink"),
    useSelection: requiredElement(documentValue, "useSelectionButton"),
    save: requiredElement(documentValue, "saveButton"),
    discard: requiredElement(documentValue, "discardButton"),
    duplicate: requiredElement(documentValue, "duplicateNotice"),
    saveCopy: requiredElement(documentValue, "saveCopyButton"),
    status: requiredElement(documentValue, "status"),
    recentList: requiredElement(documentValue, "recentList"),
    recentEmpty: requiredElement(documentValue, "recentEmpty"),
    noteCount: requiredElement(documentValue, "noteCount"),
  };
}

function errorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "The action could not be completed.";
}

export async function initPopup({
  documentValue = document,
  chromeApi = chrome,
  timerApi = globalThis,
} = {}) {
  const elements = popupElements(documentValue);
  const storage = chromeApi.storage.local;
  const numberFormatter = new Intl.NumberFormat(documentValue.documentElement.lang || undefined);
  const draftSessionId = crypto.randomUUID();
  let state;
  let currentSource = { title: "", url: "" };
  let pageCapture = null;
  let draftTimer = null;
  let draftQueue = Promise.resolve();
  let draftGeneration = 0;
  let draftDirty = false;
  let ready = false;
  let destroyed = false;

  function updateBodyCount() {
    elements.bodyCount.textContent = `${numberFormatter.format(elements.body.value.length)} / ${numberFormatter.format(LIMITS.body)}`;
  }

  function setBusy(busy) {
    elements.form.setAttribute("aria-busy", String(busy));
    elements.form.inert = busy;
    elements.save.disabled = busy;
    elements.discard.disabled = busy;
    elements.useSelection.disabled = busy;
    elements.saveCopy.disabled = busy;
  }

  function showSource(source) {
    currentSource = normalizeSource(source);
    elements.sourceTitle.textContent = currentSource.title || "Manual note";
    elements.sourceTitle.dir = "auto";
    if (currentSource.url) {
      elements.sourceLink.href = currentSource.url;
      elements.sourceLink.hidden = false;
    } else {
      elements.sourceLink.removeAttribute("href");
      elements.sourceLink.hidden = true;
    }
  }

  function renderRecentNotes() {
    const notes = selectNotes(state.notes).slice(0, 3);
    elements.noteCount.textContent = String(state.notes.length);
    elements.recentList.replaceChildren();
    elements.recentEmpty.hidden = state.notes.length > 0;

    for (const note of notes) {
      const item = documentValue.createElement("li");
      item.className = "recent-item";
      const link = documentValue.createElement("a");
      link.href = `notes.html#note=${encodeURIComponent(note.id)}`;
      link.target = "_blank";
      link.setAttribute("aria-label", `Edit ${note.title} in the note library`);

      const title = documentValue.createElement("span");
      title.className = "recent-title";
      title.dir = "auto";
      title.textContent = note.title;
      const metadata = documentValue.createElement("span");
      metadata.className = "recent-meta";
      if (note.course) {
        const course = documentValue.createElement("bdi");
        course.textContent = note.course;
        metadata.append(course, " · ");
      }
      metadata.append(formatDate(note.updatedAt));

      link.append(title, metadata);
      item.append(link);
      elements.recentList.append(item);
    }
  }

  function formDraft() {
    return {
      sessionId: draftSessionId,
      noteId: null,
      baseRevision: state.revision,
      title: elements.title.value,
      body: elements.body.value,
      course: elements.course.value,
      source: currentSource,
    };
  }

  function cancelDraftTimer() {
    if (draftTimer !== null) {
      timerApi.clearTimeout(draftTimer);
      draftTimer = null;
    }
  }

  function enqueueDraftOperation(task) {
    const operation = draftQueue.then(task, task);
    draftQueue = operation.catch(() => undefined);
    return operation;
  }

  async function persistDraft() {
    if (destroyed || !ready || !draftDirty) {
      return;
    }
    const generation = draftGeneration;
    const draft = formDraft();
    try {
      await enqueueDraftOperation(async () => {
        if (destroyed || !draftDirty || generation !== draftGeneration) {
          return;
        }
        await saveDraft(draft, storage);
      });
    } catch (error) {
      if (draftDirty && generation === draftGeneration) {
        setStatus(elements.status, `Draft not saved: ${errorMessage(error)}`, "error");
      }
    }
  }

  function scheduleDraftSave() {
    cancelDraftTimer();
    draftTimer = timerApi.setTimeout(() => {
      draftTimer = null;
      void persistDraft();
    }, 150);
  }

  function fillFromCapture(capture) {
    const capturedTitle = typeof capture.title === "string" ? capture.title : "";
    const capturedUrl = typeof capture.url === "string" ? capture.url : "";
    const source = normalizeSource({
      title: capturedTitle.slice(0, LIMITS.sourceTitle),
      url: capturedUrl.length <= LIMITS.captureUrl ? capturedUrl : "",
    });
    elements.title.value = source.title.slice(0, LIMITS.title);
    elements.body.value = capture.text;
    showSource(source);
    updateBodyCount();
    elements.useSelection.hidden = true;
    elements.duplicate.hidden = true;
    elements.body.removeAttribute("aria-invalid");
  }

  function fillFromDraft(draft) {
    elements.title.value = draft.title;
    elements.body.value = draft.body;
    elements.course.value = draft.course;
    showSource(draft.source);
    updateBodyCount();
  }

  async function saveNote(allowDuplicate = false) {
    let focusTarget = null;
    elements.duplicate.hidden = true;
    elements.body.removeAttribute("aria-invalid");
    setBusy(true);
    try {
      const result = await mutateState(
        (current) =>
          addNote(
            current,
            {
              title: elements.title.value,
              body: elements.body.value,
              course: elements.course.value,
              source: currentSource,
            },
            { allowDuplicate },
          ),
        storage,
      );
      state = result.state;
      cancelDraftTimer();
      draftDirty = false;
      draftGeneration += 1;
      let draftWarning = "";
      try {
        await enqueueDraftOperation(() =>
          clearDraft(storage, { expectedSessionId: draftSessionId, allowUnowned: true }),
        );
      } catch (error) {
        draftWarning = `Note saved, but the draft could not be cleared: ${errorMessage(error)}`;
      }
      elements.form.reset();
      showSource({});
      updateBodyCount();
      renderRecentNotes();
      setStatus(elements.status, draftWarning || "Note saved.", draftWarning ? "warning" : "success");
      focusTarget = elements.body;
    } catch (error) {
      if (error instanceof ValidationError && error.code === "duplicate") {
        elements.duplicate.hidden = false;
        setStatus(elements.status, "Review the duplicate warning before saving.", "warning");
        timerApi.setTimeout(() => elements.saveCopy.focus(), 0);
      } else {
        if (error instanceof ValidationError && error.code === "body-required") {
          elements.body.setAttribute("aria-invalid", "true");
          focusTarget = elements.body;
        }
        setStatus(elements.status, errorMessage(error), "error");
      }
    } finally {
      setBusy(false);
    }
    focusTarget?.focus();
  }

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveNote(false);
  });
  elements.form.addEventListener("input", () => {
    if (!ready) {
      return;
    }
    draftDirty = true;
    draftGeneration += 1;
    elements.duplicate.hidden = true;
    elements.body.removeAttribute("aria-invalid");
    updateBodyCount();
    scheduleDraftSave();
  });
  elements.form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      elements.form.requestSubmit();
    }
  });
  elements.saveCopy.addEventListener("click", () => void saveNote(true));
  elements.useSelection.addEventListener("click", () => {
    if (pageCapture) {
      fillFromCapture(pageCapture);
      draftDirty = true;
      draftGeneration += 1;
      scheduleDraftSave();
      setStatus(elements.status, "The active page selection replaced the recovered draft.", "info");
      elements.title.focus();
    }
  });
  elements.discard.addEventListener("click", async () => {
    let shouldFocusBody = false;
    setBusy(true);
    cancelDraftTimer();
    draftDirty = false;
    draftGeneration += 1;
    try {
      await enqueueDraftOperation(() =>
        clearDraft(storage, { expectedSessionId: draftSessionId, allowUnowned: true }),
      );
      elements.form.reset();
      if (pageCapture) {
        fillFromCapture(pageCapture);
      } else {
        showSource({});
        updateBodyCount();
      }
      setStatus(
        elements.status,
        pageCapture ? "Draft discarded. The current page selection is ready but not saved." : "Draft discarded.",
        "success",
      );
      shouldFocusBody = true;
    } catch (error) {
      setStatus(elements.status, errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
    if (shouldFocusBody) {
      elements.body.focus();
    }
  });

  const storageChangeHandler = async (changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEYS.state] || destroyed) {
      return;
    }
    try {
      state = await loadState(storage);
      applyTheme(state.settings.theme, documentValue);
      renderRecentNotes();
    } catch (error) {
      setStatus(elements.status, errorMessage(error), "error");
    }
  };
  chromeApi.storage.onChanged?.addListener(storageChangeHandler);

  setBusy(true);
  let loadSucceeded = false;
  try {
    const capturePromise = captureActivePage(chromeApi).catch((error) => error);
    state = await loadState(storage);
    applyTheme(state.settings.theme, documentValue);
    const [draft, capture, recovery] = await Promise.all([
      loadDraft(storage),
      capturePromise,
      loadRecoveryInfo(storage),
    ]);
    renderRecentNotes();

    if (!(capture instanceof Error)) {
      pageCapture = capture;
    }
    if (draft) {
      fillFromDraft(draft);
      elements.useSelection.hidden = !pageCapture?.text;
      setStatus(elements.status, "Recovered an unfinished draft.", "success");
    } else if (pageCapture) {
      fillFromCapture(pageCapture);
      if (pageCapture.wasTruncated) {
        setStatus(
          elements.status,
          `The selection was limited to ${numberFormatter.format(LIMITS.body)} characters.`,
          "warning",
        );
      } else if (pageCapture.text) {
        setStatus(elements.status, "Selection captured. Edit it before saving.", "success");
      } else {
        setStatus(elements.status, "No selected text found. You can type a note.", "info");
      }
    } else {
      showSource({});
      setStatus(elements.status, errorMessage(capture), capture instanceof CaptureError ? "warning" : "error");
    }

    if (recovery.rejectedNotes || recovery.rejectedDrafts) {
      setStatus(
        elements.status,
        "Some damaged saved data was discarded while the library was repaired.",
        "warning",
      );
    }

    ready = true;
    loadSucceeded = true;

  } catch (error) {
    setStatus(elements.status, `Notes could not be loaded: ${errorMessage(error)}`, "error");
  } finally {
    setBusy(!loadSucceeded);
    updateBodyCount();
    if (loadSucceeded) {
      (elements.body.value ? elements.title : elements.body).focus();
    }
  }

  const pageHideHandler = () => {
    cancelDraftTimer();
    if (!ready || !draftDirty) {
      return;
    }
    const draft = formDraft();
    draftDirty = false;
    draftGeneration += 1;
    if (typeof chromeApi.runtime?.sendMessage === "function") {
      void chromeApi.runtime
        .sendMessage({ type: MESSAGE_TYPES.saveDraft, draft })
        .catch(() => enqueueDraftOperation(() => saveDraft(draft, storage)));
    } else {
      void enqueueDraftOperation(() => saveDraft(draft, storage));
    }
  };
  documentValue.defaultView?.addEventListener("pagehide", pageHideHandler);

  return {
    getState: () => state,
    async flushDraft() {
      cancelDraftTimer();
      await persistDraft();
      await draftQueue;
    },
    destroy() {
      destroyed = true;
      cancelDraftTimer();
      chromeApi.storage.onChanged?.removeListener(storageChangeHandler);
      documentValue.defaultView?.removeEventListener("pagehide", pageHideHandler);
    },
  };
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  void initPopup();
}
