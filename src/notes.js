import {
  mergeImportedNotes,
  notesToMarkdown,
  parseBackup,
  replaceImportedNotes,
  serializeBackup,
} from "./backup.js";
import {
  addNote,
  LIMITS,
  removeNote,
  restoreNote,
  updateNote,
  updateSettings,
  ValidationError,
} from "./model.js";
import { MESSAGE_TYPES } from "./messages.js";
import { listCourses, selectNotes } from "./selectors.js";
import {
  assertStateFits,
  clearEditorDraft,
  loadEditorDraft,
  loadRecoveryInfo,
  loadState,
  mutateState,
  mutateStateAndClearEditorDraft,
  saveEditorDraft,
  STORAGE_KEYS,
} from "./storage.js";
import {
  applyTheme,
  backupFilename,
  downloadText,
  formatDate,
  noteToPlainText,
  setStatus,
} from "./ui.js";

function requiredElement(documentValue, identifier) {
  const element = documentValue.getElementById(identifier);
  if (!element) {
    throw new Error(`Missing library element: ${identifier}`);
  }
  return element;
}

function libraryElements(documentValue) {
  return {
    main: requiredElement(documentValue, "libraryMain"),
    newNote: requiredElement(documentValue, "newNoteButton"),
    emptyNewNote: requiredElement(documentValue, "emptyNewNoteButton"),
    search: requiredElement(documentValue, "searchInput"),
    course: requiredElement(documentValue, "courseFilter"),
    courseSuggestions: requiredElement(documentValue, "editorCourseSuggestions"),
    sort: requiredElement(documentValue, "sortSelect"),
    theme: requiredElement(documentValue, "themeSelect"),
    exportJson: requiredElement(documentValue, "exportJsonButton"),
    exportMarkdown: requiredElement(documentValue, "exportMarkdownButton"),
    importButton: requiredElement(documentValue, "importButton"),
    importFile: requiredElement(documentValue, "importFileInput"),
    summary: requiredElement(documentValue, "resultSummary"),
    status: requiredElement(documentValue, "libraryStatus"),
    retryLoad: requiredElement(documentValue, "retryLoadButton"),
    editorDraftRecovery: requiredElement(documentValue, "editorDraftRecovery"),
    editorDraftMessage: requiredElement(documentValue, "editorDraftMessage"),
    editorDraftStatus: requiredElement(documentValue, "editorDraftStatus"),
    resumeEditorDraft: requiredElement(documentValue, "resumeEditorDraftButton"),
    discardEditorDraft: requiredElement(documentValue, "discardEditorDraftButton"),
    empty: requiredElement(documentValue, "emptyState"),
    noResults: requiredElement(documentValue, "noResultsState"),
    clearFilters: requiredElement(documentValue, "clearFiltersButton"),
    list: requiredElement(documentValue, "notesList"),
    showMore: requiredElement(documentValue, "showMoreButton"),
    template: requiredElement(documentValue, "noteCardTemplate"),
    editorDialog: requiredElement(documentValue, "editorDialog"),
    editorForm: requiredElement(documentValue, "editorForm"),
    editorHeading: requiredElement(documentValue, "editorHeading"),
    editorTitle: requiredElement(documentValue, "editorTitle"),
    editorCourse: requiredElement(documentValue, "editorCourse"),
    editorBody: requiredElement(documentValue, "editorBody"),
    editorBodyCount: requiredElement(documentValue, "editorBodyCount"),
    editorSourceDetails: requiredElement(documentValue, "editorSourceDetails"),
    editorSourceTitle: requiredElement(documentValue, "editorSourceTitle"),
    editorSourceUrl: requiredElement(documentValue, "editorSourceUrl"),
    editorDuplicate: requiredElement(documentValue, "editorDuplicateNotice"),
    editorSaveDuplicate: requiredElement(documentValue, "editorSaveDuplicateButton"),
    editorConflict: requiredElement(documentValue, "editorConflictNotice"),
    saveEditorAsNew: requiredElement(documentValue, "saveEditorAsNewButton"),
    editorStatus: requiredElement(documentValue, "editorStatus"),
    saveEditor: requiredElement(documentValue, "saveEditorButton"),
    cancelEditor: requiredElement(documentValue, "cancelEditorButton"),
    closeEditor: requiredElement(documentValue, "closeEditorButton"),
    deleteDialog: requiredElement(documentValue, "deleteDialog"),
    deleteForm: requiredElement(documentValue, "deleteForm"),
    deleteMessage: requiredElement(documentValue, "deleteMessage"),
    deleteStatus: requiredElement(documentValue, "deleteStatus"),
    cancelDelete: requiredElement(documentValue, "cancelDeleteButton"),
    confirmDelete: requiredElement(documentValue, "confirmDeleteButton"),
    importDialog: requiredElement(documentValue, "importDialog"),
    importMessage: requiredElement(documentValue, "importMessage"),
    importStatus: requiredElement(documentValue, "importStatus"),
    cancelImport: requiredElement(documentValue, "cancelImportButton"),
    mergeImport: requiredElement(documentValue, "mergeImportButton"),
    replaceImport: requiredElement(documentValue, "replaceImportButton"),
    replaceDialog: requiredElement(documentValue, "replaceDialog"),
    replaceForm: requiredElement(documentValue, "replaceForm"),
    replaceMessage: requiredElement(documentValue, "replaceMessage"),
    replaceStatus: requiredElement(documentValue, "replaceStatus"),
    cancelReplace: requiredElement(documentValue, "cancelReplaceButton"),
    confirmReplace: requiredElement(documentValue, "confirmReplaceButton"),
    undoBar: requiredElement(documentValue, "undoBar"),
    undo: requiredElement(documentValue, "undoButton"),
    dismissUndo: requiredElement(documentValue, "dismissUndoButton"),
  };
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : "The action could not be completed.";
}

function showDialog(dialog) {
  if (!dialog.open) {
    dialog.showModal();
  }
}

function closeDialog(dialog) {
  if (dialog.open) {
    dialog.close();
  }
}

function isEditableTarget(target) {
  return target?.matches?.("input, textarea, select") === true;
}

function safeSlice(value, maximumLength) {
  let result = value.slice(0, maximumLength);
  const lastCodeUnit = result.charCodeAt(result.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    result = result.slice(0, -1);
  }
  return result;
}

const DISPLAY_BATCH = 100;
const SEARCH_DELAY = 120;

export async function initLibrary({
  documentValue = document,
  chromeApi = chrome,
  navigatorValue = navigator,
  timerApi = globalThis,
  urlApi = URL,
  confirmDiscardDraft,
} = {}) {
  const elements = libraryElements(documentValue);
  const storage = chromeApi.storage.local;
  const numberFormatter = new Intl.NumberFormat(documentValue.documentElement.lang || undefined);
  let state;
  let editingId = null;
  let editingSnapshot = null;
  let editingBaseNote = null;
  let editingBaseRevision = 0;
  let editorInitialInput = "";
  let editorDirty = false;
  let recoveringAsCopy = false;
  let editorReturnFocus = null;
  let editorSessionId = "";
  let editorDraftRecord = {
    ownerSessionId: "",
    generation: 0,
    contentGeneration: 0,
    draft: null,
  };
  let externalEditorDraftRecord = null;
  let editorDraftTimer = null;
  let editorDraftQueue = Promise.resolve();
  let editorDraftGeneration = 0;
  let editorDraftSynced = true;
  let editorDraftBlocked = false;
  let editorDraftSaveAnnounced = false;
  let editorDraftUnavailable = false;
  let pendingDelete = null;
  let deleteReturnFocus = null;
  let pendingImport = null;
  let undoRecord = null;
  let searchTimer = null;
  let visibleLimit = DISPLAY_BATCH;
  let courseSignature = "";
  let ready = false;
  let hashHandled = false;
  let destroyed = false;

  function noteWord(count) {
    return count === 1 ? "note" : "notes";
  }

  function setStatusWithValue(element, prefix, value, suffix, kind = "info") {
    setStatus(element, "", kind);
    const isolated = documentValue.createElement("bdi");
    isolated.textContent = value;
    element.append(prefix, isolated, suffix);
  }

  function setLibraryAvailable(available) {
    ready = available;
    elements.main.setAttribute("aria-busy", String(!available));
    for (const control of [
      elements.newNote,
      elements.emptyNewNote,
      elements.search,
      elements.course,
      elements.sort,
      elements.theme,
      elements.exportJson,
      elements.exportMarkdown,
      elements.importButton,
      elements.showMore,
      elements.resumeEditorDraft,
      elements.discardEditorDraft,
    ]) {
      control.disabled = !available;
    }
    elements.list.inert = !available;
  }

  function selectedNotes() {
    return selectNotes(state.notes, {
      query: elements.search.value,
      course: elements.course.value,
      sort: elements.sort.value,
    });
  }

  function renderCourseOptions() {
    const courses = listCourses(state.notes);
    const signature = JSON.stringify(courses);
    if (signature === courseSignature) {
      return;
    }
    courseSignature = signature;
    const selected = elements.course.value;
    const allOption = elements.course.options[0] || documentValue.createElement("option");
    allOption.value = "";
    allOption.textContent = "All courses";
    elements.course.replaceChildren(allOption);
    elements.courseSuggestions.replaceChildren();
    for (const course of courses) {
      const option = documentValue.createElement("option");
      option.value = course;
      option.textContent = course;
      elements.course.append(option);

      const suggestion = documentValue.createElement("option");
      suggestion.value = course;
      elements.courseSuggestions.append(suggestion);
    }
    elements.course.value = [...elements.course.options].some((option) => option.value === selected)
      ? selected
      : "";
  }

  function createNoteCard(note) {
    const fragment = elements.template.content.cloneNode(true);
    const card = fragment.querySelector(".note-card");
    card.dataset.noteId = note.id;

    const course = fragment.querySelector(".note-course");
    course.textContent = note.course;
    course.hidden = !note.course;
    const title = fragment.querySelector(".note-title");
    title.textContent = note.title;
    const time = fragment.querySelector(".note-time");
    const showCreated = state.settings.sort.startsWith("created-");
    const dateValue = showCreated ? note.createdAt : note.updatedAt;
    const dateLabel = showCreated ? "Created" : "Updated";
    time.dateTime = dateValue;
    time.textContent = `${dateLabel} ${formatDate(dateValue)}`;
    time.title = `${dateLabel} ${dateValue}`;

    const excerpt = fragment.querySelector(".note-excerpt");
    excerpt.textContent = note.body.length > 600 ? `${safeSlice(note.body, 600)}…` : note.body;

    const sourceLink = fragment.querySelector(".note-source-link");
    const sourceTitle = fragment.querySelector(".note-source-title");
    if (note.source.url) {
      sourceLink.href = note.source.url;
      sourceLink.textContent = note.source.title || "Open source";
      sourceLink.hidden = false;
    } else if (note.source.title) {
      sourceTitle.textContent = note.source.title;
      sourceTitle.hidden = false;
    }

    for (const button of fragment.querySelectorAll("button[data-action]")) {
      const action = button.dataset.action;
      const label = action === "copy" ? "Copy" : action === "edit" ? "Edit" : "Delete";
      button.setAttribute("aria-label", `${label} ${note.title}`);
    }

    return fragment;
  }

  function refreshReturnFocus(target) {
    if (!target || target.isConnected) {
      return target;
    }
    const card = target.closest?.("[data-note-id]");
    const action = target.dataset?.action;
    if (card && action) {
      const replacement = [...elements.list.querySelectorAll("[data-note-id]")].find(
        (candidate) => candidate.dataset.noteId === card.dataset.noteId,
      );
      return replacement?.querySelector(`[data-action='${action}']`) || elements.newNote;
    }
    return elements.newNote;
  }

  function render() {
    if (!state) {
      return;
    }
    renderCourseOptions();
    elements.sort.value = state.settings.sort;
    elements.theme.value = state.settings.theme;
    const notes = selectedNotes();
    const shownNotes = notes.slice(0, visibleLimit);
    elements.list.replaceChildren(...shownNotes.map(createNoteCard));
    editorReturnFocus = refreshReturnFocus(editorReturnFocus);
    deleteReturnFocus = refreshReturnFocus(deleteReturnFocus);

    const hasNotes = state.notes.length > 0;
    const hasFilters = Boolean(elements.search.value.trim() || elements.course.value);
    elements.empty.hidden = hasNotes;
    elements.noResults.hidden = !hasNotes || notes.length > 0 || !hasFilters;
    elements.list.hidden = !hasNotes || notes.length === 0;
    elements.showMore.hidden = shownNotes.length >= notes.length;
    if (!hasNotes) {
      elements.summary.textContent = "No saved notes";
    } else if (notes.length === 0) {
      elements.summary.textContent = "No matching notes";
    } else if (shownNotes.length < notes.length) {
      elements.summary.textContent = hasFilters
        ? `Showing ${numberFormatter.format(shownNotes.length)} of ${numberFormatter.format(notes.length)} matching ${noteWord(notes.length)} (${numberFormatter.format(state.notes.length)} total)`
        : `Showing ${numberFormatter.format(shownNotes.length)} of ${numberFormatter.format(state.notes.length)} ${noteWord(state.notes.length)}`;
    } else if (hasFilters) {
      elements.summary.textContent = `${numberFormatter.format(notes.length)} matching ${noteWord(notes.length)} (${numberFormatter.format(state.notes.length)} total)`;
    } else {
      elements.summary.textContent = `${numberFormatter.format(state.notes.length)} ${noteWord(state.notes.length)}`;
    }
    renderEditorDraftRecovery();
  }

  function updateEditorCount() {
    elements.editorBodyCount.textContent = `${numberFormatter.format(elements.editorBody.value.length)} / ${numberFormatter.format(LIMITS.body)}`;
  }

  function editorInput() {
    return {
      title: elements.editorTitle.value,
      body: elements.editorBody.value,
      course: elements.editorCourse.value,
      source: {
        title: elements.editorSourceTitle.value,
        url: elements.editorSourceUrl.value,
      },
    };
  }

  function emptyEditorInput() {
    return { title: "", body: "", course: "", source: { title: "", url: "" } };
  }

  function noteEditorInput(note) {
    return note
      ? {
          title: note.title,
          body: note.body,
          course: note.course,
          source: { ...note.source },
        }
      : emptyEditorInput();
  }

  function formEditorDraft() {
    return {
      noteId: editingId,
      baseRevision: editingBaseRevision,
      baseNote: editingBaseNote,
      ...editorInput(),
    };
  }

  function cancelEditorDraftTimer() {
    if (editorDraftTimer !== null) {
      timerApi.clearTimeout(editorDraftTimer);
      editorDraftTimer = null;
    }
  }

  function enqueueEditorDraftOperation(task) {
    const operation = editorDraftQueue.then(task, task);
    editorDraftQueue = operation.catch(() => undefined);
    return operation;
  }

  function blockEditorDraft(record) {
    externalEditorDraftRecord = record;
    editorDraftBlocked = true;
    editorDraftSynced = false;
    setStatus(
      elements.editorStatus,
      "Another library tab changed the saved draft. Keep this editor open and copy or save your work before closing.",
      "error",
    );
  }

  function adoptEditorDraftRecord(record) {
    if (!record || record.generation < editorDraftRecord.generation) {
      return false;
    }
    editorDraftRecord = record;
    return true;
  }

  async function persistEditorDraft(force = false) {
    if (destroyed || !elements.editorDialog.open || !editorDirty) {
      return true;
    }
    const generation = editorDraftGeneration;
    const draft = formEditorDraft();
    try {
      return await enqueueEditorDraftOperation(async () => {
        if (destroyed || !elements.editorDialog.open || (!force && generation !== editorDraftGeneration)) {
          return true;
        }
        if (editorDraftBlocked) {
          return false;
        }
        let result = await saveEditorDraft(draft, storage, {
          sessionId: editorSessionId,
          expectedOwnerSessionId: editorDraftRecord.ownerSessionId,
          expectedGeneration: editorDraftRecord.generation,
          contentGeneration: generation,
        });
        if (!result.saved && !result.record.draft) {
          adoptEditorDraftRecord(result.record);
          externalEditorDraftRecord = null;
          editorDraftBlocked = false;
          result = await saveEditorDraft(draft, storage, {
            sessionId: editorSessionId,
            expectedOwnerSessionId: editorDraftRecord.ownerSessionId,
            expectedGeneration: editorDraftRecord.generation,
            contentGeneration: generation,
          });
        }
        if (!result.saved) {
          if (
            result.record.ownerSessionId === editorSessionId &&
            result.record.contentGeneration >= generation
          ) {
            adoptEditorDraftRecord(result.record);
            const newerSaveIsCurrent =
              result.record.contentGeneration === editorDraftGeneration && editorDirty;
            editorDraftSynced = newerSaveIsCurrent;
            return newerSaveIsCurrent;
          }
          blockEditorDraft(result.record);
          return false;
        }
        adoptEditorDraftRecord(result.record);
        const savedCurrentInput = generation === editorDraftGeneration && editorDirty;
        editorDraftSynced = savedCurrentInput;
        if (savedCurrentInput && !editorDraftSaveAnnounced) {
          editorDraftSaveAnnounced = true;
          setStatus(elements.editorStatus, "Draft saved automatically.", "success");
        }
        return savedCurrentInput;
      });
    } catch (error) {
      editorDraftSynced = false;
      setStatus(
        elements.editorStatus,
        `Draft could not be saved: ${errorMessage(error)} Keep this editor open and copy your work before closing.`,
        "error",
      );
      return false;
    }
  }

  async function clearCurrentEditorDraft() {
    const generation = editorDraftGeneration;
    try {
      return await enqueueEditorDraftOperation(async () => {
        if (editorDraftBlocked) {
          const cleanCurrentInput = generation === editorDraftGeneration && !editorDirty;
          editorDraftSynced = cleanCurrentInput;
          return cleanCurrentInput;
        }
        if (!editorDraftRecord.draft) {
          const cleanCurrentInput = generation === editorDraftGeneration && !editorDirty;
          editorDraftSynced = cleanCurrentInput;
          return cleanCurrentInput;
        }
        const result = await clearEditorDraft(storage, {
          sessionId: editorSessionId,
          expectedOwnerSessionId: editorDraftRecord.ownerSessionId,
          expectedGeneration: editorDraftRecord.generation,
          contentGeneration: generation,
        });
        if (!result.saved) {
          if (
            !result.record.draft ||
            (result.record.ownerSessionId === editorSessionId &&
              result.record.contentGeneration >= generation)
          ) {
            adoptEditorDraftRecord(result.record);
            externalEditorDraftRecord = null;
            editorDraftBlocked = false;
            const cleanCurrentInput =
              !result.record.draft && generation === editorDraftGeneration && !editorDirty;
            editorDraftSynced = cleanCurrentInput;
            return cleanCurrentInput;
          }
          blockEditorDraft(result.record);
          return false;
        }
        adoptEditorDraftRecord(result.record);
        const clearedCurrentInput = generation === editorDraftGeneration && !editorDirty;
        editorDraftSynced = clearedCurrentInput;
        return clearedCurrentInput;
      });
    } catch (error) {
      editorDraftSynced = false;
      setStatus(elements.editorStatus, `The saved draft could not be cleared: ${errorMessage(error)}`, "error");
      return false;
    }
  }

  function scheduleEditorDraftSave() {
    cancelEditorDraftTimer();
    editorDraftSynced = false;
    editorDraftTimer = timerApi.setTimeout(() => {
      editorDraftTimer = null;
      void persistEditorDraft();
    }, 150);
  }

  async function flushEditorDraft() {
    cancelEditorDraftTimer();
    const saved = editorDirty ? await persistEditorDraft(true) : await clearCurrentEditorDraft();
    await editorDraftQueue;
    return saved;
  }

  function renderEditorDraftRecovery(record = externalEditorDraftRecord || editorDraftRecord) {
    const draft = record?.draft;
    if (!draft || elements.editorDialog.open) {
      elements.editorDraftRecovery.hidden = true;
      return;
    }

    const current = draft.noteId
      ? state?.notes.find((note) => note.id === draft.noteId)
      : null;
    const baseMatches = Boolean(
      current && draft.baseNote && JSON.stringify(current) === JSON.stringify(draft.baseNote),
    );
    const stale = Boolean(draft.noteId && !baseMatches);
    elements.resumeEditorDraft.textContent = stale ? "Recover as new note" : "Resume draft";
    elements.editorDraftMessage.replaceChildren();
    if (stale) {
      elements.editorDraftMessage.textContent = "The original note changed or was deleted. Recover this draft as a new note without overwriting library changes.";
    } else if (draft.noteId) {
      const title = documentValue.createElement("bdi");
      title.dir = "auto";
      title.textContent = draft.title || draft.baseNote?.title || "Untitled note";
      elements.editorDraftMessage.append(
        "Changes to “",
        title,
        `” were saved as a draft ${formatDate(draft.updatedAt)}.`,
      );
    } else {
      elements.editorDraftMessage.textContent = `A draft saved ${formatDate(draft.updatedAt)} is ready to continue.`;
    }
    elements.editorDraftRecovery.hidden = false;
  }

  function setEditorBusy(busy) {
    elements.editorForm.setAttribute("aria-busy", String(busy));
    elements.editorForm.inert = busy;
    elements.saveEditor.disabled = busy;
    elements.cancelEditor.disabled = busy;
    elements.closeEditor.disabled = busy;
    elements.editorSaveDuplicate.disabled = busy;
    elements.saveEditorAsNew.disabled = busy;
  }

  function openEditorValues({
    note = null,
    input = noteEditorInput(note),
    baseline = noteEditorInput(note),
    trigger = null,
    heading = note ? "Edit note" : "New note",
    saveLabel = note ? "Save changes" : "Save note",
    baseNote = note,
    baseRevision = state.revision,
    synced = true,
    recoveryCopy = false,
  } = {}) {
    editingId = note?.id || null;
    editingBaseNote = baseNote ? structuredClone(baseNote) : null;
    editingSnapshot = baseNote ? JSON.stringify(baseNote) : null;
    editingBaseRevision = baseRevision;
    recoveringAsCopy = recoveryCopy;
    editorReturnFocus = trigger || documentValue.activeElement;
    elements.editorHeading.textContent = heading;
    elements.saveEditor.textContent = saveLabel;
    elements.editorTitle.value = input.title || "";
    elements.editorCourse.value = input.course || "";
    elements.editorBody.value = input.body || "";
    elements.editorSourceTitle.value = input.source?.title || "";
    elements.editorSourceUrl.value = input.source?.url || "";
    elements.editorSourceDetails.open = Boolean(input.source?.title || input.source?.url);
    elements.editorDuplicate.hidden = true;
    elements.editorConflict.hidden = true;
    elements.editorBody.removeAttribute("aria-invalid");
    elements.editorSourceUrl.removeAttribute("aria-invalid");
    setStatus(elements.editorStatus, "", "info");
    updateEditorCount();
    editorInitialInput = JSON.stringify(baseline);
    editorDirty = JSON.stringify(editorInput()) !== editorInitialInput;
    editorDraftSynced = synced;
    editorDraftBlocked = false;
    externalEditorDraftRecord = null;
    editorDraftSaveAnnounced = synced && editorDirty;
    showDialog(elements.editorDialog);
    elements.editorDraftRecovery.hidden = true;
    elements.editorTitle.focus();
  }

  function openEditor(note = null, trigger = null) {
    if (!ready) {
      return;
    }
    if (editorDraftUnavailable) {
      setStatus(
        elements.status,
        "An unfinished draft was saved by a newer extension version. Update the extension before editing notes.",
        "warning",
      );
      return;
    }
    if ((externalEditorDraftRecord || editorDraftRecord).draft) {
      renderEditorDraftRecovery();
      setStatus(elements.status, "Resume or discard the unfinished draft before opening another note.", "warning");
      elements.resumeEditorDraft.focus();
      return;
    }
    editorSessionId = crypto.randomUUID();
    editorDraftGeneration = Math.max(
      editorDraftGeneration + 1,
      editorDraftRecord.contentGeneration + 1,
    );
    editorDraftSaveAnnounced = false;
    openEditorValues({ note, trigger });
  }

  function finishCloseEditor() {
    cancelEditorDraftTimer();
    editorDirty = false;
    closeDialog(elements.editorDialog);
  }

  function restoreEditorFocusAfterClose() {
    let target = editorReturnFocus;
    if (
      !target?.isConnected ||
      target.closest?.("[hidden]") ||
      target.closest?.("dialog:not([open])")
    ) {
      target = elements.editorDraftRecovery.hidden
        ? elements.newNote
        : elements.resumeEditorDraft;
    }
    target.focus();
    editorReturnFocus = null;
  }

  async function requestCloseEditor() {
    setEditorBusy(true);
    const hadDraft = editorDirty;
    const saved = await flushEditorDraft();
    if (!saved) {
      setEditorBusy(false);
      const confirmDiscard = confirmDiscardDraft || ((message) => documentValue.defaultView.confirm(message));
      if (
        confirmDiscard(
          "Close this editor and discard changes that could not be saved as a draft? Any draft from another library tab will remain.",
        )
      ) {
        finishCloseEditor();
        renderEditorDraftRecovery();
        restoreEditorFocusAfterClose();
        setStatus(elements.status, "Editor closed. Unsaved local changes were discarded.", "warning");
      }
      return;
    }
    setEditorBusy(false);
    finishCloseEditor();
    renderEditorDraftRecovery();
    restoreEditorFocusAfterClose();
    if (hadDraft) {
      setStatus(elements.status, "Draft kept. Resume it when you are ready.", "success");
    }
  }

  async function resumeEditorDraft() {
    let focusAfter = null;
    elements.resumeEditorDraft.disabled = true;
    elements.discardEditorDraft.disabled = true;
    setStatus(elements.editorDraftStatus, "", "info");
    try {
      const nextState = await loadState(storage);
      const record = await loadEditorDraft(storage);
      if (!record.draft) {
        state = nextState;
        editorDraftRecord = record;
        externalEditorDraftRecord = null;
        renderEditorDraftRecovery();
        setStatus(elements.status, "The draft is no longer available.", "warning");
        focusAfter = elements.newNote;
        return;
      }

      const draft = record.draft;
      const current = draft.noteId
        ? nextState.notes.find((note) => note.id === draft.noteId)
        : null;
      const baseMatches = Boolean(
        current && draft.baseNote && JSON.stringify(current) === JSON.stringify(draft.baseNote),
      );
      const recoveryCopy = Boolean(draft.noteId && !baseMatches);
      const claimedDraft = recoveryCopy
        ? { ...draft, noteId: null, baseNote: null, baseRevision: nextState.revision }
        : draft;
      const sessionId = crypto.randomUUID();
      const claimed = await saveEditorDraft(claimedDraft, storage, {
        sessionId,
        expectedOwnerSessionId: record.ownerSessionId,
        expectedGeneration: record.generation,
        contentGeneration: 1,
      });
      if (!claimed.saved) {
        state = nextState;
        editorDraftRecord = claimed.record;
        externalEditorDraftRecord = null;
        renderEditorDraftRecovery();
        setStatus(elements.editorDraftStatus, "The draft changed in another library tab. Review the latest version.", "warning");
        focusAfter = elements.resumeEditorDraft;
        return;
      }

      state = nextState;
      editorSessionId = sessionId;
      adoptEditorDraftRecord(claimed.record);
      externalEditorDraftRecord = null;
      editorDraftGeneration = claimed.record.contentGeneration;
      const input = {
        title: claimedDraft.title,
        body: claimedDraft.body,
        course: claimedDraft.course,
        source: { ...claimedDraft.source },
      };
      openEditorValues({
        note: recoveryCopy ? null : current,
        input,
        baseline: recoveryCopy ? emptyEditorInput() : noteEditorInput(current),
        trigger: elements.resumeEditorDraft,
        heading: recoveryCopy ? "Recover draft" : current ? "Resume edit" : "Resume draft",
        saveLabel: recoveryCopy ? "Save as new note" : current ? "Save changes" : "Save note",
        baseNote: recoveryCopy ? null : draft.baseNote,
        baseRevision: draft.baseRevision,
        synced: true,
        recoveryCopy,
      });
      setStatus(
        elements.editorStatus,
        recoveryCopy
          ? "The original note changed or was deleted. Saving will create a new note without overwriting library changes."
          : "Draft resumed. Changes are saved automatically.",
        recoveryCopy ? "warning" : "success",
      );
    } catch (error) {
      setStatus(elements.editorDraftStatus, `Draft could not be opened: ${errorMessage(error)}`, "error");
      focusAfter = elements.resumeEditorDraft;
    } finally {
      elements.resumeEditorDraft.disabled = false;
      elements.discardEditorDraft.disabled = false;
      focusAfter?.focus();
    }
  }

  async function discardRecoveredEditorDraft() {
    const record = externalEditorDraftRecord || editorDraftRecord;
    if (!record.draft) {
      renderEditorDraftRecovery(record);
      return;
    }
    const confirmDiscard = confirmDiscardDraft || ((message) => documentValue.defaultView.confirm(message));
    if (!confirmDiscard("Discard this unfinished draft? This cannot be undone.")) {
      elements.discardEditorDraft.focus();
      return;
    }

    elements.resumeEditorDraft.disabled = true;
    elements.discardEditorDraft.disabled = true;
    setStatus(elements.editorDraftStatus, "", "info");
    let focusAfter = null;
    try {
      const result = await clearEditorDraft(storage, {
        sessionId: crypto.randomUUID(),
        expectedOwnerSessionId: record.ownerSessionId,
        expectedGeneration: record.generation,
      });
      if (!result.saved) {
        editorDraftRecord = result.record;
        externalEditorDraftRecord = null;
        renderEditorDraftRecovery();
        setStatus(elements.editorDraftStatus, "The draft changed in another library tab. Review it before discarding.", "warning");
        focusAfter = elements.discardEditorDraft;
        return;
      }
      editorDraftRecord = result.record;
      externalEditorDraftRecord = null;
      elements.editorDraftRecovery.hidden = true;
      setStatus(elements.status, "Draft discarded.", "success");
      focusAfter = elements.newNote;
    } catch (error) {
      setStatus(elements.editorDraftStatus, `Draft could not be discarded: ${errorMessage(error)}`, "error");
      focusAfter = elements.discardEditorDraft;
    } finally {
      elements.resumeEditorDraft.disabled = false;
      elements.discardEditorDraft.disabled = false;
      focusAfter?.focus();
    }
  }

  function convertEditorToNewNote() {
    editingId = null;
    editingSnapshot = null;
    editingBaseNote = null;
    editingBaseRevision = state.revision;
    recoveringAsCopy = true;
    editorInitialInput = JSON.stringify(emptyEditorInput());
    editorDirty = true;
    editorDraftSynced = false;
    editorDraftGeneration += 1;
    elements.editorHeading.textContent = "Recover draft";
    elements.saveEditor.textContent = "Save as new note";
    elements.editorConflict.hidden = true;
    setStatus(
      elements.editorStatus,
      "Saving will create a new note without overwriting library changes.",
      "warning",
    );
  }

  async function saveEditor(allowDuplicate = false) {
    if (elements.saveEditor.disabled) {
      return;
    }
    const editingIdentifier = editingId;
    const originalSnapshot = editingSnapshot;
    const input = editorInput();
    const wasRecoveryCopy = recoveringAsCopy;
    let focusTarget = null;
    elements.editorDuplicate.hidden = true;
    elements.editorBody.removeAttribute("aria-invalid");
    elements.editorSourceUrl.removeAttribute("aria-invalid");
    setEditorBusy(true);
    try {
      cancelEditorDraftTimer();
      editorDraftGeneration += 1;
      await flushEditorDraft();
      const result = await mutateStateAndClearEditorDraft(
        (current) => {
          if (!editingIdentifier) {
            return addNote(current, input, { allowDuplicate, strictSourceUrl: true });
          }
          const latest = current.notes.find((note) => note.id === editingIdentifier);
          if (!latest) {
            throw new ValidationError("The note was deleted in another window.", "note-missing");
          }
          if (originalSnapshot && JSON.stringify(latest) !== originalSnapshot) {
            throw new ValidationError(
              "This note changed in another window. Close and reopen it before saving.",
              "edit-conflict",
            );
          }
          return updateNote(current, editingIdentifier, input, {
            allowDuplicate,
            strictSourceUrl: true,
          });
        },
        storage,
        {
          sessionId: editorSessionId,
          expectedOwnerSessionId: editorDraftRecord.ownerSessionId,
          expectedGeneration: editorDraftRecord.generation,
        },
      );
      state = result.state;
      editorDraftRecord = result.editorDraftRecord;
      externalEditorDraftRecord = null;
      editorDraftSynced = result.editorDraftCleared;
      const savedId = result.note.id;
      editorDirty = false;
      finishCloseEditor();
      render();
      renderEditorDraftRecovery();
      editorReturnFocus = null;
      const savedMessage = wasRecoveryCopy ? "Recovered draft saved as a new note." : "Note saved.";
      setStatus(
        elements.status,
        result.editorDraftCleared
          ? savedMessage
          : `${savedMessage} A draft from another library tab was kept.`,
        result.editorDraftCleared ? "success" : "warning",
      );
      [...elements.list.querySelectorAll("[data-note-id]")]
        .find((card) => card.dataset.noteId === savedId)
        ?.querySelector("[data-action='edit']")
        ?.focus();
    } catch (error) {
      if (error instanceof ValidationError && error.code === "duplicate") {
        elements.editorDuplicate.hidden = false;
        setStatus(elements.editorStatus, "Review the duplicate warning before saving.", "warning");
        timerApi.setTimeout(() => elements.editorSaveDuplicate.focus(), 0);
      } else if (
        error instanceof ValidationError &&
        ["edit-conflict", "note-missing"].includes(error.code)
      ) {
        elements.editorConflict.hidden = false;
        setStatus(elements.editorStatus, "", "info");
        timerApi.setTimeout(() => elements.saveEditorAsNew.focus(), 0);
      } else {
        if (error instanceof ValidationError && error.code === "body-required") {
          elements.editorBody.setAttribute("aria-invalid", "true");
          focusTarget = elements.editorBody;
        }
        if (error instanceof ValidationError && error.code.startsWith("source-url")) {
          elements.editorSourceUrl.setAttribute("aria-invalid", "true");
          elements.editorSourceDetails.open = true;
          focusTarget = elements.editorSourceUrl;
        }
        setStatus(elements.editorStatus, errorMessage(error), "error");
      }
    } finally {
      setEditorBusy(false);
    }
    focusTarget?.focus();
  }

  function openDelete(note, trigger) {
    pendingDelete = note;
    deleteReturnFocus = trigger;
    elements.deleteMessage.dir = "ltr";
    const title = documentValue.createElement("bdi");
    title.dir = "auto";
    title.textContent = note.title;
    elements.deleteMessage.replaceChildren("“", title, "” will be removed from this Chrome profile.");
    setStatus(elements.deleteStatus, "", "info");
    showDialog(elements.deleteDialog);
    elements.cancelDelete.focus();
  }

  function hideUndo() {
    elements.undoBar.hidden = true;
    undoRecord = null;
  }

  function showUndo(record) {
    hideUndo();
    undoRecord = record;
    elements.undoBar.hidden = false;
  }

  async function deleteNote() {
    if (!pendingDelete) {
      return;
    }
    const noteToDelete = pendingDelete;
    elements.confirmDelete.disabled = true;
    elements.cancelDelete.disabled = true;
    try {
      const result = await mutateState((current) => {
        const latest = current.notes.find((note) => note.id === noteToDelete.id);
        if (!latest) {
          throw new ValidationError("The note was deleted in another window.", "note-missing");
        }
        if (JSON.stringify(latest) !== JSON.stringify(noteToDelete)) {
          throw new ValidationError(
            "This note changed in another window. Close this confirmation and review it before deleting.",
            "delete-conflict",
          );
        }
        return removeNote(current, noteToDelete.id);
      }, storage);
      state = result.state;
      pendingDelete = null;
      deleteReturnFocus = null;
      closeDialog(elements.deleteDialog);
      render();
      showUndo({ note: result.note, index: result.index, stateSnapshot: JSON.stringify(state) });
      setStatus(elements.status, "Note deleted. Undo is available in this tab until the library changes.", "success");
      const nextFocus = elements.list.querySelector("[data-action='edit']") || elements.newNote;
      nextFocus.focus();
    } catch (error) {
      setStatus(elements.deleteStatus, errorMessage(error), "error");
      timerApi.setTimeout(() => elements.confirmDelete.focus(), 0);
    } finally {
      elements.confirmDelete.disabled = false;
      elements.cancelDelete.disabled = false;
    }
  }

  async function undoDelete() {
    if (!undoRecord) {
      return;
    }
    elements.undo.disabled = true;
    try {
      const record = undoRecord;
      const result = await mutateState(
        (current) => restoreNote(current, record.note, record.index),
        storage,
      );
      state = result.state;
      hideUndo();
      render();
      setStatus(elements.status, "Note restored.", "success");
      [...elements.list.querySelectorAll("[data-note-id]")]
        .find((card) => card.dataset.noteId === record.note.id)
        ?.querySelector("[data-action='edit']")
        ?.focus();
    } catch (error) {
      setStatus(elements.status, errorMessage(error), "error");
    } finally {
      elements.undo.disabled = false;
    }
  }

  async function copyNote(note, button) {
    try {
      await navigatorValue.clipboard.writeText(noteToPlainText(note));
      button.textContent = "Copied";
      timerApi.setTimeout(() => {
        if (button.isConnected) {
          button.textContent = "Copy";
        }
      }, 1_500);
      setStatusWithValue(elements.status, "Copied “", note.title, "”.", "success");
    } catch {
      setStatus(elements.status, "Chrome could not copy the note. Select its text in the editor instead.", "error");
    }
  }

  async function exportJson() {
    if (!state) {
      setStatus(elements.status, "The library is not available yet.", "error");
      return;
    }
    try {
      const text = serializeBackup(state);
      downloadText(text, backupFilename("json"), "application/json", documentValue, urlApi);
      setStatus(elements.status, "Backup exported.", "success");
    } catch (error) {
      setStatus(elements.status, errorMessage(error), "error");
    }
  }

  async function exportMarkdown() {
    if (!state) {
      setStatus(elements.status, "The library is not available yet.", "error");
      return;
    }
    try {
      const notes = selectedNotes();
      if (notes.length === 0) {
        setStatus(elements.status, "No notes match the current view.", "warning");
        return;
      }
      const text = notesToMarkdown(notes);
      downloadText(text, backupFilename("md"), "text/markdown", documentValue, urlApi);
      setStatus(
        elements.status,
        `Exported ${numberFormatter.format(notes.length)} ${noteWord(notes.length)} from the current view as Markdown.`,
        "success",
      );
    } catch (error) {
      setStatus(elements.status, errorMessage(error), "error");
    }
  }

  async function readImportFile(file) {
    if (!file || !state) {
      return;
    }
    if (file.size > LIMITS.importBytes) {
      setStatus(elements.status, "The backup file is too large.", "error");
      elements.importFile.value = "";
      return;
    }

    try {
      const parsed = parseBackup(await file.text());
      assertStateFits(replaceImportedNotes(state, parsed));
      pendingImport = parsed;
      const count = pendingImport.notes.length;
      elements.importMessage.textContent = `The backup contains ${numberFormatter.format(count)} ${noteWord(count)}.`;
      setStatus(elements.importStatus, "", "info");
      showDialog(elements.importDialog);
      elements.cancelImport.focus();
    } catch (error) {
      pendingImport = null;
      setStatus(elements.status, errorMessage(error), "error");
    } finally {
      elements.importFile.value = "";
    }
  }

  async function mergeImport() {
    if (!pendingImport) {
      return;
    }
    const importValue = pendingImport;
    elements.cancelImport.disabled = true;
    elements.mergeImport.disabled = true;
    elements.replaceImport.disabled = true;
    try {
      const result = await mutateState(
        (current) => mergeImportedNotes(current, importValue.notes),
        storage,
      );
      state = result.state;
      pendingImport = null;
      closeDialog(elements.importDialog);
      render();
      setStatus(
        elements.status,
        `Restored ${numberFormatter.format(result.added)} ${noteWord(result.added)}. Skipped ${numberFormatter.format(result.skipped)} ${result.skipped === 1 ? "note" : "notes"} already present.`,
        "success",
      );
    } catch (error) {
      setStatus(elements.importStatus, errorMessage(error), "error");
      timerApi.setTimeout(() => elements.mergeImport.focus(), 0);
    } finally {
      elements.cancelImport.disabled = false;
      elements.mergeImport.disabled = false;
      elements.replaceImport.disabled = false;
    }
  }

  async function replaceImport() {
    if (!pendingImport) {
      return;
    }
    const importValue = pendingImport;
    elements.cancelReplace.disabled = true;
    elements.confirmReplace.disabled = true;
    try {
      state = await mutateState(
        (current) => replaceImportedNotes(current, importValue),
        storage,
      );
      hideUndo();
      pendingImport = null;
      closeDialog(elements.replaceDialog);
      applyTheme(state.settings.theme, documentValue);
      render();
      setStatus(
        elements.status,
        `Library replaced with ${numberFormatter.format(state.notes.length)} ${noteWord(state.notes.length)}.`,
        "success",
      );
    } catch (error) {
      setStatus(elements.replaceStatus, errorMessage(error), "error");
      timerApi.setTimeout(() => elements.confirmReplace.focus(), 0);
    } finally {
      elements.cancelReplace.disabled = false;
      elements.confirmReplace.disabled = false;
    }
  }

  async function changeSettings(changes) {
    if (!state) {
      return;
    }
    try {
      state = await mutateState((current) => updateSettings(current, changes), storage);
      applyTheme(state.settings.theme, documentValue);
      render();
    } catch (error) {
      setStatus(elements.status, errorMessage(error), "error");
      if (state) {
        elements.sort.value = state.settings.sort;
        elements.theme.value = state.settings.theme;
      }
    }
  }

  setLibraryAvailable(false);
  elements.resumeEditorDraft.addEventListener("click", () => void resumeEditorDraft());
  elements.discardEditorDraft.addEventListener("click", () => void discardRecoveredEditorDraft());
  elements.newNote.addEventListener("click", (event) => openEditor(null, event.currentTarget));
  elements.emptyNewNote.addEventListener("click", (event) =>
    openEditor(null, event.currentTarget),
  );
  elements.search.addEventListener("input", () => {
    if (searchTimer !== null) {
      timerApi.clearTimeout(searchTimer);
    }
    visibleLimit = DISPLAY_BATCH;
    searchTimer = timerApi.setTimeout(() => {
      searchTimer = null;
      render();
    }, SEARCH_DELAY);
  });
  elements.course.addEventListener("change", () => {
    visibleLimit = DISPLAY_BATCH;
    render();
  });
  elements.sort.addEventListener("change", () => void changeSettings({ sort: elements.sort.value }));
  elements.theme.addEventListener("change", () => void changeSettings({ theme: elements.theme.value }));
  elements.clearFilters.addEventListener("click", () => {
    if (searchTimer !== null) {
      timerApi.clearTimeout(searchTimer);
      searchTimer = null;
    }
    elements.search.value = "";
    elements.course.value = "";
    visibleLimit = DISPLAY_BATCH;
    render();
    elements.search.focus();
  });
  elements.showMore.addEventListener("click", () => {
    const firstNewIndex = visibleLimit;
    visibleLimit += DISPLAY_BATCH;
    render();
    const firstNewCard = elements.list.querySelectorAll("[data-note-id]")[firstNewIndex];
    firstNewCard?.querySelector("[data-action='edit']")?.focus();
  });
  elements.list.addEventListener("click", (event) => {
    const button = event.target.closest?.("button[data-action]");
    const card = button?.closest("[data-note-id]");
    const note = state?.notes.find((candidate) => candidate.id === card?.dataset.noteId);
    if (!button || !note) {
      return;
    }
    if (button.dataset.action === "edit") {
      openEditor(note, button);
    } else if (button.dataset.action === "delete") {
      openDelete(note, button);
    } else if (button.dataset.action === "copy") {
      void copyNote(note, button);
    }
  });

  elements.editorForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!elements.saveEditor.disabled) {
      void saveEditor(false);
    }
  });
  elements.editorForm.addEventListener("input", () => {
    elements.editorDuplicate.hidden = true;
    elements.editorBody.removeAttribute("aria-invalid");
    elements.editorSourceUrl.removeAttribute("aria-invalid");
    editorDirty = JSON.stringify(editorInput()) !== editorInitialInput;
    editorDraftGeneration += 1;
    editorDraftSynced = false;
    updateEditorCount();
    if (editorDirty) {
      scheduleEditorDraftSave();
    } else {
      cancelEditorDraftTimer();
      void clearCurrentEditorDraft();
    }
  });
  elements.editorForm.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!elements.saveEditor.disabled) {
        elements.editorForm.requestSubmit();
      }
    }
  });
  elements.editorSaveDuplicate.addEventListener("click", () => void saveEditor(true));
  elements.saveEditorAsNew.addEventListener("click", () => {
    convertEditorToNewNote();
    void saveEditor(false);
  });
  elements.cancelEditor.addEventListener("click", () => void requestCloseEditor());
  elements.closeEditor.addEventListener("click", () => void requestCloseEditor());
  elements.editorDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (elements.saveEditor.disabled) {
      return;
    }
    void requestCloseEditor();
  });
  elements.editorDialog.addEventListener("close", () => {
    editingId = null;
    editingSnapshot = null;
    editingBaseNote = null;
    editingBaseRevision = 0;
    editorInitialInput = "";
    editorDirty = false;
    recoveringAsCopy = false;
    editorSessionId = "";
  });

  elements.deleteForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void deleteNote();
  });
  elements.cancelDelete.addEventListener("click", () => closeDialog(elements.deleteDialog));
  elements.deleteDialog.addEventListener("close", () => {
    deleteReturnFocus?.focus?.();
    deleteReturnFocus = null;
    pendingDelete = null;
  });
  elements.deleteDialog.addEventListener("cancel", (event) => {
    if (elements.confirmDelete.disabled) {
      event.preventDefault();
    }
  });
  elements.undo.addEventListener("click", () => void undoDelete());
  elements.dismissUndo.addEventListener("click", hideUndo);

  elements.exportJson.addEventListener("click", () => void exportJson());
  elements.exportMarkdown.addEventListener("click", () => void exportMarkdown());
  elements.importButton.addEventListener("click", () => elements.importFile.click());
  elements.importFile.addEventListener("change", () => void readImportFile(elements.importFile.files[0]));
  elements.cancelImport.addEventListener("click", () => {
    pendingImport = null;
    closeDialog(elements.importDialog);
  });
  elements.importDialog.addEventListener("cancel", (event) => {
    if (elements.mergeImport.disabled) {
      event.preventDefault();
      return;
    }
    pendingImport = null;
  });
  elements.importDialog.addEventListener("close", () => {
    if (!elements.replaceDialog.open) {
      elements.importButton.focus();
    }
  });
  elements.mergeImport.addEventListener("click", () => void mergeImport());
  elements.replaceImport.addEventListener("click", () => {
    if (!pendingImport) {
      return;
    }
    closeDialog(elements.importDialog);
    elements.replaceMessage.textContent = `This will remove ${numberFormatter.format(state.notes.length)} current ${noteWord(state.notes.length)} and restore ${numberFormatter.format(pendingImport.notes.length)} ${noteWord(pendingImport.notes.length)}.`;
    setStatus(elements.replaceStatus, "", "info");
    showDialog(elements.replaceDialog);
    elements.cancelReplace.focus();
  });
  elements.replaceForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void replaceImport();
  });
  elements.cancelReplace.addEventListener("click", () => {
    pendingImport = null;
    closeDialog(elements.replaceDialog);
  });
  elements.replaceDialog.addEventListener("cancel", (event) => {
    if (elements.confirmReplace.disabled) {
      event.preventDefault();
      return;
    }
    pendingImport = null;
  });
  elements.replaceDialog.addEventListener("close", () => elements.importButton.focus());

  const keyHandler = (event) => {
    if (
      !ready ||
      documentValue.querySelector("dialog[open]") !== null ||
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      isEditableTarget(event.target)
    ) {
      return;
    }
    if (event.key === "/") {
      event.preventDefault();
      elements.search.focus();
    } else if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      openEditor(null, elements.newNote);
    }
  };
  documentValue.addEventListener("keydown", keyHandler);

  const beforeUnloadHandler = (event) => {
    if (editorDirty && !editorDraftSynced) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  documentValue.defaultView?.addEventListener("beforeunload", beforeUnloadHandler);

  const pageHideHandler = () => {
    cancelEditorDraftTimer();
    if (!elements.editorDialog.open || !editorDirty || editorDraftSynced || editorDraftBlocked) {
      return;
    }
    const draft = formEditorDraft();
    const options = {
      sessionId: editorSessionId,
      expectedOwnerSessionId: editorDraftRecord.ownerSessionId,
      expectedGeneration: editorDraftRecord.generation,
      contentGeneration: editorDraftGeneration,
    };
    const saveDirectly = async () => {
      const result = await saveEditorDraft(draft, storage, options);
      if (
        (result.saved || result.record.ownerSessionId === editorSessionId) &&
        result.record.contentGeneration === editorDraftGeneration &&
        result.record.draft
      ) {
        adoptEditorDraftRecord(result.record);
        editorDraftSynced = true;
      }
      return result;
    };
    if (typeof chromeApi.runtime?.sendMessage === "function") {
      void chromeApi.runtime
        .sendMessage({ type: MESSAGE_TYPES.saveEditorDraft, draft, ...options })
        .then((response) => {
          if (response?.ok !== true) {
            throw new Error(response?.error || "Draft handoff failed.");
          }
          if (response.saved !== true) {
            return saveDirectly();
          }
          if (
            response.cursor?.ownerSessionId === editorSessionId &&
            response.cursor.contentGeneration === editorDraftGeneration &&
            response.cursor.hasDraft
          ) {
            editorDraftSynced = true;
          }
          return undefined;
        })
        .catch(() => saveDirectly())
        .catch(() => undefined);
    } else {
      void saveDirectly().catch(() => undefined);
    }
  };
  documentValue.defaultView?.addEventListener("pagehide", pageHideHandler);

  const visibilityHandler = () => {
    if (documentValue.visibilityState === "hidden" && elements.editorDialog.open && editorDirty) {
      void flushEditorDraft();
    }
  };
  documentValue.addEventListener("visibilitychange", visibilityHandler);

  function focusedCardAction() {
    const button = documentValue.activeElement?.closest?.("button[data-action]");
    const card = button?.closest("[data-note-id]");
    if (!button || !card) {
      return null;
    }
    return { noteId: card.dataset.noteId, action: button.dataset.action };
  }

  function restoreCardFocus(target) {
    if (!target) {
      return;
    }
    const card = [...elements.list.querySelectorAll("[data-note-id]")].find(
      (candidate) => candidate.dataset.noteId === target.noteId,
    );
    card?.querySelector(`[data-action='${target.action}']`)?.focus();
  }

  const storageChangeHandler = async (changes, areaName) => {
    const stateChanged = Boolean(changes[STORAGE_KEYS.state]);
    const editorDraftChanged = Boolean(changes[STORAGE_KEYS.editorDraft]);
    if (destroyed || areaName !== "local" || (!stateChanged && !editorDraftChanged)) {
      return;
    }
    try {
      if (stateChanged) {
        const focusTarget = focusedCardAction();
        const nextState = await loadState(storage);
        if (undoRecord && JSON.stringify(nextState) !== undoRecord.stateSnapshot) {
          hideUndo();
        }
        state = nextState;
        applyTheme(state.settings.theme, documentValue);
        render();
        restoreCardFocus(focusTarget);
        if (elements.editorDialog.open) {
          const currentEditedNote = editingId
            ? state.notes.find((note) => note.id === editingId)
            : null;
          const hasConflict = Boolean(
            editingId && (!currentEditedNote || JSON.stringify(currentEditedNote) !== editingSnapshot),
          );
          elements.editorConflict.hidden = !hasConflict;
          if (hasConflict) {
            if (!editorDraftBlocked) {
              setStatus(elements.editorStatus, "", "info");
            }
          } else if (!editorDraftBlocked) {
            setStatus(elements.editorStatus, "The library changed in another window. Your form was not replaced.", "warning");
          }
        }
      }

      if (editorDraftChanged) {
        const record = await loadEditorDraft(storage);
        editorDraftUnavailable = false;
        if (elements.editorDialog.open) {
          if (record.ownerSessionId === editorSessionId) {
            if (adoptEditorDraftRecord(record)) {
              if (record.contentGeneration === editorDraftGeneration) {
                editorDraftSynced = editorDirty ? Boolean(record.draft) : !record.draft;
              }
            }
          } else if (
            record.ownerSessionId !== editorDraftRecord.ownerSessionId ||
            record.generation !== editorDraftRecord.generation
          ) {
            if (!record.draft) {
              adoptEditorDraftRecord(record);
              externalEditorDraftRecord = null;
              editorDraftBlocked = false;
              editorDraftSynced = !editorDirty;
              if (editorDirty) {
                void persistEditorDraft(true);
              }
            } else {
              blockEditorDraft(record);
            }
          }
        } else {
          if (adoptEditorDraftRecord(record)) {
            externalEditorDraftRecord = null;
            renderEditorDraftRecovery();
          }
        }
      }
    } catch (error) {
      if (error instanceof ValidationError && error.code === "editor-draft-version") {
        editorDraftUnavailable = true;
        editorDraftBlocked = elements.editorDialog.open;
        editorDraftSynced = false;
        setStatus(
          elements.status,
          "An unfinished draft was saved by a newer extension version. Update the extension before editing notes.",
          "warning",
        );
      } else {
        setStatus(elements.status, errorMessage(error), "error");
      }
    }
  };
  chromeApi.storage.onChanged?.addListener(storageChangeHandler);

  async function loadLibrary() {
    setLibraryAvailable(false);
    elements.retryLoad.hidden = true;
    elements.summary.textContent = "Loading notes...";
    setStatus(elements.status, "", "info");
    try {
      state = await loadState(storage);
      try {
        editorDraftRecord = await loadEditorDraft(storage);
        editorDraftUnavailable = false;
      } catch (error) {
        if (!(error instanceof ValidationError) || error.code !== "editor-draft-version") {
          throw error;
        }
        editorDraftRecord = {
          ownerSessionId: "",
          generation: 0,
          contentGeneration: 0,
          draft: null,
        };
        editorDraftUnavailable = true;
      }
      externalEditorDraftRecord = null;
      applyTheme(state.settings.theme, documentValue);
      elements.sort.value = state.settings.sort;
      elements.theme.value = state.settings.theme;
      visibleLimit = DISPLAY_BATCH;
      render();
      renderEditorDraftRecovery();
      setLibraryAvailable(true);
      const recovery = await loadRecoveryInfo(storage);
      if (editorDraftUnavailable) {
        setStatus(
          elements.status,
          "An unfinished draft was saved by a newer extension version. Update the extension before editing notes.",
          "warning",
        );
      } else if (recovery.rejectedNotes || recovery.rejectedDrafts) {
        setStatus(
          elements.status,
          "Some damaged saved data was discarded while the library was repaired.",
          "warning",
        );
      }

      if (!hashHandled) {
        hashHandled = true;
        const hash = documentValue.defaultView?.location.hash || "";
        const identifier = new URLSearchParams(hash.replace(/^#/u, "")).get("note");
        const requested = state.notes.find((note) => note.id === identifier);
        if (requested) {
          openEditor(requested, elements.newNote);
        }
      }
    } catch (error) {
      state = undefined;
      setLibraryAvailable(false);
      setStatus(elements.status, `Notes could not be loaded: ${errorMessage(error)}`, "error");
      elements.summary.textContent = "Library unavailable";
      elements.retryLoad.hidden = false;
    }
  }
  elements.retryLoad.addEventListener("click", () => void loadLibrary());
  await loadLibrary();

  return {
    getState: () => state,
    getEditorDraftRecord: () => editorDraftRecord,
    flushEditorDraft,
    render,
    openEditor,
    destroy() {
      destroyed = true;
      if (searchTimer !== null) {
        timerApi.clearTimeout(searchTimer);
      }
      cancelEditorDraftTimer();
      chromeApi.storage.onChanged?.removeListener(storageChangeHandler);
      documentValue.removeEventListener("keydown", keyHandler);
      documentValue.removeEventListener("visibilitychange", visibilityHandler);
      documentValue.defaultView?.removeEventListener("beforeunload", beforeUnloadHandler);
      documentValue.defaultView?.removeEventListener("pagehide", pageHideHandler);
    },
  };
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  void initLibrary();
}
