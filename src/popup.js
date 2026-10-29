import { captureActivePage, CaptureError } from "./capture.js";
import { addNote, LIMITS, normalizeSource, ValidationError } from "./model.js";
import { MESSAGE_TYPES } from "./messages.js";
import {
  clearPopupDraft,
  loadPendingCaptures,
  loadPopupDraft,
  loadRecoveryInfo,
  loadState,
  mutateStateAndClearPopupDraft,
  removePendingCapture,
  savePopupDraft,
  STORAGE_KEYS,
} from "./storage.js";
import { listCourses, selectNotes } from "./selectors.js";
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
    courseSuggestions: requiredElement(documentValue, "courseSuggestions"),
    body: requiredElement(documentValue, "bodyInput"),
    bodyCount: requiredElement(documentValue, "bodyCount"),
    sourceTitle: requiredElement(documentValue, "sourceTitle"),
    sourceLink: requiredElement(documentValue, "sourceLink"),
    useSelection: requiredElement(documentValue, "useSelectionButton"),
    discardSelection: requiredElement(documentValue, "discardSelectionButton"),
    save: requiredElement(documentValue, "saveButton"),
    discard: requiredElement(documentValue, "discardButton"),
    duplicate: requiredElement(documentValue, "duplicateNotice"),
    saveCopy: requiredElement(documentValue, "saveCopyButton"),
    status: requiredElement(documentValue, "status"),
    recentList: requiredElement(documentValue, "recentList"),
    recentEmpty: requiredElement(documentValue, "recentEmpty"),
    noteCount: requiredElement(documentValue, "noteCount"),
    help: requiredElement(documentValue, "helpButton"),
    helpPanel: requiredElement(documentValue, "helpPanel"),
    closeHelp: requiredElement(documentValue, "closeHelpButton"),
    openSidePanel: requiredElement(documentValue, "openSidePanelButton"),
  };
}

function errorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "The action could not be completed.";
}

export async function openLibraryBesidePage(chromeApi = chrome) {
  const libraryUrl = typeof chromeApi.runtime?.getURL === "function"
    ? chromeApi.runtime.getURL("notes.html")
    : "notes.html";
  let panelError = null;

  if (typeof chromeApi.sidePanel?.open === "function") {
    try {
      await chromeApi.sidePanel.open({
        windowId: chromeApi.windows?.WINDOW_ID_CURRENT ?? -2,
      });
      return { opened: "side-panel" };
    } catch (error) {
      panelError = error;
    }
  }

  if (typeof chromeApi.tabs?.create === "function") {
    try {
      await chromeApi.tabs.create({ url: libraryUrl });
      return { opened: "tab", panelError };
    } catch (error) {
      const detail = panelError
        ? `${errorMessage(panelError)} ${errorMessage(error)}`
        : errorMessage(error);
      throw new Error(`The library could not be opened. ${detail}`, { cause: error });
    }
  }

  throw panelError || new Error("The library could not be opened in this Chrome version.");
}

export async function initPopup({
  documentValue = document,
  chromeApi = chrome,
  timerApi = globalThis,
  confirmDiscard,
} = {}) {
  const elements = popupElements(documentValue);
  const storage = chromeApi.storage.local;
  const numberFormatter = new Intl.NumberFormat(documentValue.documentElement.lang || undefined);
  const draftSessionId = crypto.randomUUID();
  let state;
  let currentSource = { title: "", url: "" };
  let livePageCapture = null;
  let pendingCaptures = [];
  let pendingCapture = null;
  let appliedPendingCaptureId = "";
  let pageCapture = null;
  let draftTimer = null;
  let draftQueue = Promise.resolve();
  let draftHandoff = Promise.resolve();
  let draftGeneration = 0;
  let draftDirty = false;
  let hasDiscardableDraft = false;
  let draftCursor = {
    ownerSessionId: "",
    generation: 0,
    contentGeneration: 0,
  };
  let ready = false;
  let destroyed = false;
  let helpSeen = false;

  async function showHelp({ persist = true } = {}) {
    elements.helpPanel.hidden = false;
    elements.help.setAttribute("aria-expanded", "true");
    if (!persist || helpSeen) {
      return;
    }
    try {
      await storage.set({ [STORAGE_KEYS.helpSeen]: true });
      helpSeen = true;
    } catch (error) {
      setStatus(elements.status, `Help preference not saved: ${errorMessage(error)}`, "warning");
    }
  }

  function hideHelp() {
    elements.helpPanel.hidden = true;
    elements.help.setAttribute("aria-expanded", "false");
    elements.help.focus();
  }

  function updateBodyCount() {
    elements.bodyCount.textContent = `${numberFormatter.format(elements.body.value.length)} / ${numberFormatter.format(LIMITS.body)}`;
  }

  function setBusy(busy) {
    elements.form.setAttribute("aria-busy", String(busy));
    elements.form.inert = busy;
    elements.save.disabled = busy;
    elements.discard.disabled = busy || !hasDiscardableDraft;
    elements.useSelection.disabled = busy;
    elements.discardSelection.disabled = busy;
    elements.saveCopy.disabled = busy;
  }

  function updateDiscardControl() {
    elements.discard.textContent = pageCapture ? "Reset draft" : "Discard draft";
    elements.discard.disabled = elements.form.inert || !hasDiscardableDraft;
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
    const courses = listCourses(state.notes);
    elements.noteCount.textContent = String(state.notes.length);
    elements.recentList.replaceChildren();
    elements.courseSuggestions.replaceChildren(
      ...courses.map((courseName) => {
        const option = documentValue.createElement("option");
        option.value = courseName;
        return option;
      }),
    );
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
      metadata.append(`Updated ${formatDate(note.updatedAt)}`);

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

  function updateDraftCursor(record) {
    draftCursor = {
      ownerSessionId: record.ownerSessionId,
      generation: record.generation,
      contentGeneration: record.contentGeneration,
    };
  }

  async function persistDraft() {
    if (destroyed || !ready || !draftDirty) {
      return false;
    }
    const generation = draftGeneration;
    const draft = formDraft();
    const pendingCaptureId = appliedPendingCaptureId;
    let saved = false;
    try {
      await enqueueDraftOperation(async () => {
        if (destroyed || !draftDirty || generation !== draftGeneration) {
          return;
        }
        const result = await savePopupDraft(draft, storage, {
          sessionId: draftSessionId,
          expectedOwnerSessionId: draftCursor.ownerSessionId,
          expectedGeneration: draftCursor.generation,
          contentGeneration: generation,
        });
        if (!result.saved) {
          throw new ValidationError(
            "Another popup saved a newer draft. This popup did not overwrite it.",
            "popup-draft-conflict",
          );
        }
        updateDraftCursor(result.record);
        if (draftDirty && generation === draftGeneration) {
          draftDirty = false;
        }
        saved = true;
      });
    } catch (error) {
      if (draftDirty && generation === draftGeneration) {
        setStatus(elements.status, `Draft not saved: ${errorMessage(error)}`, "error");
      }
      return false;
    }
    if (saved && pendingCaptureId) {
      try {
        await consumePendingCapture(pendingCaptureId);
      } catch (error) {
        setStatus(
          elements.status,
          `Draft saved, but the captured selection remains queued: ${errorMessage(error)}`,
          "warning",
        );
      }
    }
    return saved;
  }

  function scheduleDraftSave() {
    cancelDraftTimer();
    draftTimer = timerApi.setTimeout(() => {
      draftTimer = null;
      void persistDraft();
    }, 150);
  }

  function updateCaptureActions({ offerSelection = false } = {}) {
    elements.useSelection.textContent = pendingCapture
      ? "Use captured selection"
      : "Use page selection";
    if (!pageCapture?.text) {
      elements.useSelection.hidden = true;
    } else if (offerSelection) {
      elements.useSelection.hidden = false;
    }
    elements.discardSelection.hidden = !pendingCapture;
  }

  function setPendingCaptureList(captures, { offerSelection = false } = {}) {
    pendingCaptures = Array.isArray(captures) ? captures : [];
    pendingCapture = pendingCaptures[0] || null;
    if (
      appliedPendingCaptureId &&
      !pendingCaptures.some((capture) => capture.id === appliedPendingCaptureId)
    ) {
      appliedPendingCaptureId = "";
    }
    pageCapture = pendingCapture || livePageCapture;
    updateCaptureActions({ offerSelection });
  }

  async function consumePendingCapture(identifier, { offerSelection = true } = {}) {
    const result = await removePendingCapture(identifier, storage);
    if (appliedPendingCaptureId === identifier) {
      appliedPendingCaptureId = "";
    }
    setPendingCaptureList(result.captures, { offerSelection });
    return result.removed;
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

  function captureStatus(capture, context = "initial") {
    const selectionName = capture.id ? "captured selection" : "page selection";
    if (capture.wasTruncated) {
      const prefix = context === "replaced"
        ? `The ${selectionName} replaced the recovered draft.`
        : context === "reset"
          ? `The draft was reset to the ${selectionName}.`
          : "The selection was captured.";
      setStatus(
        elements.status,
        `${prefix} It was limited to ${numberFormatter.format(LIMITS.body)} characters.`,
        "warning",
      );
    } else if (context === "replaced") {
      setStatus(elements.status, `The ${selectionName} replaced the recovered draft.`, "info");
    } else if (context === "reset") {
      setStatus(elements.status, `The draft was reset to the ${selectionName}.`, "success");
    } else if (capture.text) {
      setStatus(elements.status, "Selection captured. Edit it before saving.", "success");
    } else {
      setStatus(elements.status, "No selected text found. You can type a note.", "info");
    }
  }

  function pendingCaptureStatus(prefix = "") {
    if (!pendingCapture) {
      return;
    }
    const count = pendingCaptures.length;
    const waiting = count === 1
      ? "A captured selection is waiting."
      : `${numberFormatter.format(count)} captured selections are waiting.`;
    const truncation = pendingCapture.wasTruncated
      ? ` The first was limited to ${numberFormatter.format(LIMITS.body)} characters.`
      : "";
    setStatus(
      elements.status,
      `${prefix ? `${prefix} ` : ""}${waiting}${truncation} Use it or discard it.`,
      pendingCapture.wasTruncated ? "warning" : "info",
    );
  }

  function fillFromDraft(draft) {
    elements.title.value = draft.title;
    elements.body.value = draft.body;
    elements.course.value = draft.course;
    showSource(draft.source);
    updateBodyCount();
  }

  function prepareNextNote(course) {
    elements.form.reset();
    elements.course.value = course;
    if (pageCapture) {
      const source = normalizeSource({
        title: pageCapture.title.slice(0, LIMITS.sourceTitle),
        url: pageCapture.url.length <= LIMITS.captureUrl ? pageCapture.url : "",
      });
      elements.title.value = source.title.slice(0, LIMITS.title);
      showSource(source);
      elements.useSelection.hidden = !pageCapture.text;
    } else {
      showSource({});
      elements.useSelection.hidden = true;
    }
    updateBodyCount();
    hasDiscardableDraft = false;
    updateDiscardControl();
    updateCaptureActions();
  }

  async function saveNote(allowDuplicate = false) {
    let focusTarget = null;
    const savedCourse = elements.course.value;
    const pendingCaptureId = appliedPendingCaptureId;
    elements.duplicate.hidden = true;
    elements.body.removeAttribute("aria-invalid");
    setBusy(true);
    cancelDraftTimer();
    try {
      const result = await enqueueDraftOperation(() =>
        mutateStateAndClearPopupDraft(
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
          {
            sessionId: draftSessionId,
            expectedOwnerSessionId: draftCursor.ownerSessionId,
            expectedGeneration: draftCursor.generation,
            contentGeneration: Math.max(
              draftGeneration + 1,
              draftCursor.contentGeneration + 1,
            ),
          },
        ),
      );
      state = result.state;
      draftDirty = false;
      updateDraftCursor(result.popupDraftRecord);
      draftGeneration = Math.max(draftGeneration + 1, draftCursor.contentGeneration);
      const draftWarning = result.popupDraftCleared
        ? ""
        : "Note saved. A newer draft from another popup was kept.";
      let pendingWarning = "";
      if (pendingCaptureId) {
        try {
          await consumePendingCapture(pendingCaptureId);
        } catch (error) {
          pendingWarning =
            `Note saved, but the captured selection remains queued: ${errorMessage(error)}`;
        }
      }
      prepareNextNote(savedCourse);
      renderRecentNotes();
      const successMessage = currentSource.url || currentSource.title
        ? "Note saved. Source kept for the next note."
        : "Note saved.";
      const warning = draftWarning || pendingWarning;
      setStatus(elements.status, warning || successMessage, warning ? "warning" : "success");
      focusTarget = elements.body;
    } catch (error) {
      if (draftDirty) {
        scheduleDraftSave();
      }
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

  elements.help.addEventListener("click", () => {
    if (elements.helpPanel.hidden) {
      void showHelp();
      elements.helpPanel.focus({ preventScroll: true });
    } else {
      hideHelp();
    }
  });
  elements.closeHelp.addEventListener("click", hideHelp);
  elements.openSidePanel.addEventListener("click", async () => {
    elements.openSidePanel.disabled = true;
    try {
      const result = await openLibraryBesidePage(chromeApi);
      if (result.opened === "side-panel") {
        setStatus(elements.status, "Library opened beside the page.", "success");
      } else if (result.panelError) {
        setStatus(
          elements.status,
          `Side panel unavailable: ${errorMessage(result.panelError)} Opened the library in a tab.`,
          "warning",
        );
      } else {
        setStatus(
          elements.status,
          "Side panel unavailable. Opened the library in a tab.",
          "warning",
        );
      }
    } catch (error) {
      setStatus(elements.status, errorMessage(error), "error");
    } finally {
      elements.openSidePanel.disabled = false;
    }
  });

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveNote(false);
  });
  elements.form.addEventListener("input", () => {
    if (!ready) {
      return;
    }
    draftDirty = true;
    hasDiscardableDraft = true;
    draftGeneration += 1;
    elements.duplicate.hidden = true;
    elements.body.removeAttribute("aria-invalid");
    updateBodyCount();
    updateDiscardControl();
    scheduleDraftSave();
  });
  elements.form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      elements.form.requestSubmit();
    }
  });
  elements.saveCopy.addEventListener("click", () => void saveNote(true));
  elements.useSelection.addEventListener("click", async () => {
    if (!pageCapture) {
      return;
    }
    const capture = pageCapture;
    const pendingCaptureId = pendingCapture?.id === capture.id ? capture.id : "";
    fillFromCapture(capture);
    appliedPendingCaptureId = pendingCaptureId;
    draftDirty = true;
    hasDiscardableDraft = true;
    draftGeneration += 1;
    updateDiscardControl();
    captureStatus(capture, "replaced");
    if (pendingCaptureId) {
      setBusy(true);
      await persistDraft();
      setBusy(false);
      updateDiscardControl();
    } else {
      scheduleDraftSave();
    }
    elements.title.focus();
  });
  elements.discardSelection.addEventListener("click", async () => {
    if (!pendingCapture) {
      return;
    }
    const confirmReset = confirmDiscard || ((message) => documentValue.defaultView.confirm(message));
    if (!confirmReset("Discard this captured selection? This cannot be undone.")) {
      return;
    }
    const captureId = pendingCapture.id;
    const wasApplied = appliedPendingCaptureId === captureId;
    setBusy(true);
    try {
      await consumePendingCapture(captureId, { offerSelection: !wasApplied });
      if (wasApplied) {
        const currentDraftRecord = await loadPopupDraft(storage);
        updateDraftCursor(currentDraftRecord);
        draftGeneration = Math.max(draftGeneration, currentDraftRecord.contentGeneration);
        draftDirty = false;
        elements.form.reset();
        if (currentDraftRecord.draft) {
          fillFromDraft(currentDraftRecord.draft);
          hasDiscardableDraft = true;
          updateCaptureActions({ offerSelection: Boolean(pageCapture?.text) });
        } else if (pendingCapture) {
          appliedPendingCaptureId = pendingCapture.id;
          fillFromCapture(pendingCapture);
          hasDiscardableDraft = false;
          updateCaptureActions();
        } else if (livePageCapture) {
          fillFromCapture(livePageCapture);
          hasDiscardableDraft = false;
          updateCaptureActions();
        } else {
          showSource({});
          updateBodyCount();
          hasDiscardableDraft = false;
          elements.useSelection.hidden = true;
          updateCaptureActions();
        }
      }
      updateDiscardControl();
      const message = pendingCapture
        ? "Captured selection discarded. The next capture is ready."
        : "Captured selection discarded.";
      setStatus(elements.status, message, "success");
    } catch (error) {
      setStatus(elements.status, `Captured selection not discarded: ${errorMessage(error)}`, "error");
    } finally {
      setBusy(false);
    }
    elements.body.focus();
  });
  elements.discard.addEventListener("click", async () => {
    if (!hasDiscardableDraft) {
      return;
    }
    const confirmReset = confirmDiscard || ((message) => documentValue.defaultView.confirm(message));
    const prompt = pendingCapture
      ? "Discard this unfinished draft and start with the captured selection?"
      : pageCapture
        ? "Reset this draft to the current page selection?"
      : "Discard this unfinished draft?";
    if (!confirmReset(prompt)) {
      return;
    }
    let shouldFocusBody = false;
    setBusy(true);
    cancelDraftTimer();
    draftDirty = false;
    draftGeneration += 1;
    try {
      const result = await enqueueDraftOperation(() =>
        clearPopupDraft(storage, {
          sessionId: draftSessionId,
          expectedOwnerSessionId: draftCursor.ownerSessionId,
          expectedGeneration: draftCursor.generation,
          contentGeneration: Math.max(
            draftGeneration,
            draftCursor.contentGeneration + 1,
          ),
        }),
      );
      updateDraftCursor(result.record);
      hasDiscardableDraft = false;
      elements.form.reset();
      if (pageCapture) {
        fillFromCapture(pageCapture);
        appliedPendingCaptureId = pendingCapture?.id === pageCapture.id ? pageCapture.id : "";
      } else {
        showSource({});
        updateBodyCount();
      }
      if (!result.saved) {
        setStatus(elements.status, "The local draft was reset. A newer draft from another popup was kept.", "warning");
      } else if (pageCapture) {
        captureStatus(pageCapture, "reset");
      } else {
        setStatus(elements.status, "Draft discarded.", "success");
      }
      shouldFocusBody = true;
    } catch (error) {
      setStatus(elements.status, errorMessage(error), "error");
    } finally {
      setBusy(false);
      updateDiscardControl();
    }
    if (shouldFocusBody) {
      elements.body.focus();
    }
  });

  const storageChangeHandler = async (changes, areaName) => {
    if (
      areaName !== "local" ||
      destroyed ||
      (!changes[STORAGE_KEYS.state] && !changes[STORAGE_KEYS.pendingCaptures])
    ) {
      return;
    }
    try {
      if (changes[STORAGE_KEYS.state]) {
        state = await loadState(storage);
        applyTheme(state.settings.theme, documentValue);
        renderRecentNotes();
      }
      if (changes[STORAGE_KEYS.pendingCaptures]) {
        const captures = await loadPendingCaptures(storage);
        const offerSelection = Boolean(
          captures[0] && captures[0].id !== appliedPendingCaptureId,
        );
        setPendingCaptureList(captures, { offerSelection });
        if (captures[0] && !appliedPendingCaptureId) {
          pendingCaptureStatus();
        }
      }
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
    const [draftRecord, capture, recovery, helpPreference, queuedCaptures] = await Promise.all([
      loadPopupDraft(storage),
      capturePromise,
      loadRecoveryInfo(storage),
      storage.get(STORAGE_KEYS.helpSeen),
      loadPendingCaptures(storage),
    ]);
    const draft = draftRecord.draft;
    updateDraftCursor(draftRecord);
    draftGeneration = Math.max(draftGeneration, draftRecord.contentGeneration);
    renderRecentNotes();

    if (!(capture instanceof Error)) {
      livePageCapture = capture;
    }
    setPendingCaptureList(queuedCaptures);
    if (draft) {
      fillFromDraft(draft);
      hasDiscardableDraft = true;
      elements.useSelection.hidden = !pageCapture?.text;
      updateCaptureActions();
      if (pendingCapture) {
        pendingCaptureStatus("Recovered an unfinished draft.");
      } else {
        setStatus(elements.status, "Recovered an unfinished draft.", "success");
      }
    } else if (pageCapture) {
      appliedPendingCaptureId = pendingCapture?.id === pageCapture.id ? pageCapture.id : "";
      fillFromCapture(pageCapture);
      updateCaptureActions();
      captureStatus(pageCapture);
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

    helpSeen = helpPreference[STORAGE_KEYS.helpSeen] === true;
    if (!helpSeen) {
      await showHelp();
    }

  } catch (error) {
    setStatus(elements.status, `Notes could not be loaded: ${errorMessage(error)}`, "error");
  } finally {
    setBusy(!loadSucceeded);
    updateDiscardControl();
    updateBodyCount();
    if (loadSucceeded) {
      (elements.body.value ? elements.title : elements.body).focus();
    }
  }

  function handoffDraft() {
    cancelDraftTimer();
    if (!ready || !draftDirty) {
      return;
    }
    const draft = formDraft();
    const contentGeneration = draftGeneration;
    const expectedOwnerSessionId = draftCursor.ownerSessionId;
    const expectedGeneration = draftCursor.generation;
    const pendingCaptureId = appliedPendingCaptureId;
    draftDirty = false;
    const saveDirectly = async () => {
      const result = await savePopupDraft(draft, storage, {
        sessionId: draftSessionId,
        expectedOwnerSessionId,
        expectedGeneration,
        contentGeneration,
      });
      if (
        result.saved &&
        result.record.contentGeneration >= draftCursor.contentGeneration
      ) {
        updateDraftCursor(result.record);
        if (pendingCaptureId) {
          await removePendingCapture(pendingCaptureId, storage);
        }
      }
    };
    let operation;
    if (typeof chromeApi.runtime?.sendMessage === "function") {
      operation = chromeApi.runtime
        .sendMessage({
          type: MESSAGE_TYPES.saveDraft,
          draft,
          sessionId: draftSessionId,
          expectedOwnerSessionId,
          expectedGeneration,
          contentGeneration,
          pendingCaptureId,
        })
        .then((response) => {
          if (!response?.ok) {
            throw new Error(response?.error || "The background page did not save the draft.");
          }
          if (
            response.saved &&
            response.cursor?.contentGeneration >= draftCursor.contentGeneration
          ) {
            updateDraftCursor(response.cursor);
          }
        })
        .catch(saveDirectly);
    } else {
      operation = saveDirectly();
    }
    const guardedOperation = operation.catch((error) => {
      if (!destroyed) {
        setStatus(elements.status, `Draft not saved: ${errorMessage(error)}`, "error");
      }
    });
    draftHandoff = Promise.all([draftHandoff, guardedOperation]).then(() => undefined);
  }

  const pageHideHandler = () => handoffDraft();
  const visibilityChangeHandler = () => {
    if (documentValue.visibilityState === "hidden") {
      handoffDraft();
    }
  };
  documentValue.defaultView?.addEventListener("pagehide", pageHideHandler);
  documentValue.addEventListener("visibilitychange", visibilityChangeHandler);

  return {
    getState: () => state,
    async flushDraft() {
      cancelDraftTimer();
      await persistDraft();
      await draftQueue;
      await draftHandoff;
    },
    destroy() {
      destroyed = true;
      cancelDraftTimer();
      chromeApi.storage.onChanged?.removeListener(storageChangeHandler);
      documentValue.defaultView?.removeEventListener("pagehide", pageHideHandler);
      documentValue.removeEventListener("visibilitychange", visibilityChangeHandler);
    },
  };
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  void initPopup();
}
