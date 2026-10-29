import {
  mergeImportedBackup,
  notesToMarkdown,
  parseBackup,
  previewImportedBackup,
  replaceImportedNotes,
  serializeBackup,
} from "./backup.js";
import {
  addNote,
  assignCourseToNotes,
  emptyTrash,
  LIMITS,
  measureLibraryUsage,
  moveNoteToTrash,
  moveNotesToTrash,
  permanentlyDeleteTrashedNote,
  permanentlyDeleteTrashedNotes,
  restoreTrashedNote,
  restoreTrashedNotes,
  updateNote,
  updateSettings,
  ValidationError,
} from "./model.js";
import { MESSAGE_TYPES } from "./messages.js";
import { listCourses, selectNotes } from "./selectors.js";
import {
  acknowledgeRecovery,
  assertStateFits,
  clearEditorDraft,
  loadDataEpoch,
  loadEditorDraft,
  loadRecoveryNotice,
  loadState,
  mutateState,
  mutateStateAndClearEditorDraft,
  resetAllData,
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
    notesView: requiredElement(documentValue, "notesViewButton"),
    trashView: requiredElement(documentValue, "trashViewButton"),
    activeNoteCount: requiredElement(documentValue, "activeNoteCount"),
    trashNoteCount: requiredElement(documentValue, "trashNoteCount"),
    emptyTrash: requiredElement(documentValue, "emptyTrashButton"),
    selectionMode: requiredElement(documentValue, "selectionModeButton"),
    selectionToolbar: requiredElement(documentValue, "selectionToolbar"),
    selectionCount: requiredElement(documentValue, "selectionCount"),
    selectAllFiltered: requiredElement(documentValue, "selectAllFilteredButton"),
    clearSelection: requiredElement(documentValue, "clearSelectionButton"),
    cancelSelection: requiredElement(documentValue, "cancelSelectionButton"),
    activeSelectionActions: requiredElement(documentValue, "activeSelectionActions"),
    trashSelectionActions: requiredElement(documentValue, "trashSelectionActions"),
    bulkCourse: requiredElement(documentValue, "bulkCourseButton"),
    bulkExport: requiredElement(documentValue, "bulkExportButton"),
    bulkTrash: requiredElement(documentValue, "bulkTrashButton"),
    bulkRestore: requiredElement(documentValue, "bulkRestoreButton"),
    bulkPermanentDelete: requiredElement(documentValue, "bulkPermanentDeleteButton"),
    exportJson: requiredElement(documentValue, "exportJsonButton"),
    exportMarkdown: requiredElement(documentValue, "exportMarkdownButton"),
    importButton: requiredElement(documentValue, "importButton"),
    importFile: requiredElement(documentValue, "importFileInput"),
    storageUsage: requiredElement(documentValue, "storageUsage"),
    storageUsageText: requiredElement(documentValue, "storageUsageText"),
    storageUsageMeter: requiredElement(documentValue, "storageUsageMeter"),
    storageUsageWarning: requiredElement(documentValue, "storageUsageWarning"),
    includeSourceOnShare: requiredElement(documentValue, "includeSourceOnShare"),
    clearLocalData: requiredElement(documentValue, "clearLocalDataButton"),
    summary: requiredElement(documentValue, "resultSummary"),
    status: requiredElement(documentValue, "libraryStatus"),
    retryLoad: requiredElement(documentValue, "retryLoadButton"),
    editorDraftRecovery: requiredElement(documentValue, "editorDraftRecovery"),
    editorDraftMessage: requiredElement(documentValue, "editorDraftMessage"),
    editorDraftStatus: requiredElement(documentValue, "editorDraftStatus"),
    resumeEditorDraft: requiredElement(documentValue, "resumeEditorDraftButton"),
    discardEditorDraft: requiredElement(documentValue, "discardEditorDraftButton"),
    recoveryNotice: requiredElement(documentValue, "recoveryNotice"),
    recoveryMessage: requiredElement(documentValue, "recoveryMessage"),
    recoveryStatus: requiredElement(documentValue, "recoveryStatus"),
    acknowledgeRecovery: requiredElement(documentValue, "acknowledgeRecoveryButton"),
    empty: requiredElement(documentValue, "emptyState"),
    emptyHeading: requiredElement(documentValue, "emptyStateHeading"),
    emptyMessage: requiredElement(documentValue, "emptyStateMessage"),
    noResults: requiredElement(documentValue, "noResultsState"),
    clearFilters: requiredElement(documentValue, "clearFiltersButton"),
    list: requiredElement(documentValue, "notesList"),
    showMore: requiredElement(documentValue, "showMoreButton"),
    template: requiredElement(documentValue, "noteCardTemplate"),
    detailDialog: requiredElement(documentValue, "detailDialog"),
    detailHeading: requiredElement(documentValue, "detailHeading"),
    detailCourseRow: requiredElement(documentValue, "detailCourseRow"),
    detailCourse: requiredElement(documentValue, "detailCourse"),
    detailSourceTitleRow: requiredElement(documentValue, "detailSourceTitleRow"),
    detailSourceTitle: requiredElement(documentValue, "detailSourceTitle"),
    detailSourceUrlRow: requiredElement(documentValue, "detailSourceUrlRow"),
    detailSourceUrl: requiredElement(documentValue, "detailSourceUrl"),
    detailCreated: requiredElement(documentValue, "detailCreated"),
    detailUpdated: requiredElement(documentValue, "detailUpdated"),
    detailDeletedRow: requiredElement(documentValue, "detailDeletedRow"),
    detailDeleted: requiredElement(documentValue, "detailDeleted"),
    detailBody: requiredElement(documentValue, "detailBody"),
    detailStatus: requiredElement(documentValue, "detailStatus"),
    detailActiveActions: requiredElement(documentValue, "detailActiveActions"),
    detailTrashActions: requiredElement(documentValue, "detailTrashActions"),
    detailCopy: requiredElement(documentValue, "detailCopyButton"),
    detailEdit: requiredElement(documentValue, "detailEditButton"),
    detailDelete: requiredElement(documentValue, "detailDeleteButton"),
    detailRestore: requiredElement(documentValue, "detailRestoreButton"),
    detailPermanentDelete: requiredElement(documentValue, "detailPermanentDeleteButton"),
    closeDetail: requiredElement(documentValue, "closeDetailButton"),
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
    permanentDeleteDialog: requiredElement(documentValue, "permanentDeleteDialog"),
    permanentDeleteForm: requiredElement(documentValue, "permanentDeleteForm"),
    permanentDeleteMessage: requiredElement(documentValue, "permanentDeleteMessage"),
    permanentDeleteStatus: requiredElement(documentValue, "permanentDeleteStatus"),
    cancelPermanentDelete: requiredElement(documentValue, "cancelPermanentDeleteButton"),
    confirmPermanentDelete: requiredElement(documentValue, "confirmPermanentDeleteButton"),
    emptyTrashDialog: requiredElement(documentValue, "emptyTrashDialog"),
    emptyTrashForm: requiredElement(documentValue, "emptyTrashForm"),
    emptyTrashMessage: requiredElement(documentValue, "emptyTrashMessage"),
    emptyTrashStatus: requiredElement(documentValue, "emptyTrashStatus"),
    cancelEmptyTrash: requiredElement(documentValue, "cancelEmptyTrashButton"),
    confirmEmptyTrash: requiredElement(documentValue, "confirmEmptyTrashButton"),
    bulkCourseDialog: requiredElement(documentValue, "bulkCourseDialog"),
    bulkCourseForm: requiredElement(documentValue, "bulkCourseForm"),
    bulkCourseMessage: requiredElement(documentValue, "bulkCourseMessage"),
    bulkCourseInput: requiredElement(documentValue, "bulkCourseInput"),
    bulkCourseStatus: requiredElement(documentValue, "bulkCourseStatus"),
    cancelBulkCourse: requiredElement(documentValue, "cancelBulkCourseButton"),
    clearBulkCourse: requiredElement(documentValue, "clearBulkCourseButton"),
    applyBulkCourse: requiredElement(documentValue, "applyBulkCourseButton"),
    bulkConfirmDialog: requiredElement(documentValue, "bulkConfirmDialog"),
    bulkConfirmForm: requiredElement(documentValue, "bulkConfirmForm"),
    bulkConfirmEyebrow: requiredElement(documentValue, "bulkConfirmEyebrow"),
    bulkConfirmHeading: requiredElement(documentValue, "bulkConfirmHeading"),
    bulkConfirmMessage: requiredElement(documentValue, "bulkConfirmMessage"),
    bulkConfirmWarning: requiredElement(documentValue, "bulkConfirmWarning"),
    bulkConfirmStatus: requiredElement(documentValue, "bulkConfirmStatus"),
    cancelBulkConfirm: requiredElement(documentValue, "cancelBulkConfirmButton"),
    confirmBulkAction: requiredElement(documentValue, "confirmBulkActionButton"),
    resetDialog: requiredElement(documentValue, "resetDialog"),
    resetForm: requiredElement(documentValue, "resetForm"),
    resetMessage: requiredElement(documentValue, "resetMessage"),
    resetExport: requiredElement(documentValue, "resetExportButton"),
    resetConfirmation: requiredElement(documentValue, "resetConfirmationInput"),
    resetStatus: requiredElement(documentValue, "resetStatus"),
    cancelReset: requiredElement(documentValue, "cancelResetButton"),
    confirmReset: requiredElement(documentValue, "confirmResetButton"),
    importDialog: requiredElement(documentValue, "importDialog"),
    importMessage: requiredElement(documentValue, "importMessage"),
    importExportedAt: requiredElement(documentValue, "importExportedAt"),
    importSchemaVersion: requiredElement(documentValue, "importSchemaVersion"),
    mergePreviewMessage: requiredElement(documentValue, "mergePreviewMessage"),
    mergePreviewWarning: requiredElement(documentValue, "mergePreviewWarning"),
    replacePreviewMessage: requiredElement(documentValue, "replacePreviewMessage"),
    replaceSettingsMessage: requiredElement(documentValue, "replaceSettingsMessage"),
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
  let dataEpoch = "";
  let dataResetConflict = false;
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
  let detailNoteId = null;
  let detailReturnFocus = null;
  let pendingDelete = null;
  let deleteReturnFocus = null;
  let pendingPermanentDelete = null;
  let permanentDeleteReturnFocus = null;
  let emptyTrashSnapshot = null;
  let pendingImport = null;
  let pendingImportPreview = null;
  let importReadGeneration = 0;
  let pendingReplaceStateSnapshot = null;
  let replaceInFlight = false;
  let recoveryInfo = { createdAt: "", rejectedNotes: 0, rejectedDrafts: 0 };
  let measuredUsageState = null;
  let measuredUsage = null;
  let storageUsageRequestGeneration = 0;
  const copyResetTimers = new WeakMap();
  let undoRecord = null;
  let searchTimer = null;
  let visibleLimit = DISPLAY_BATCH;
  let viewMode = "notes";
  let selectionMode = false;
  let selectedIds = new Set();
  let selectionReturnFocus = null;
  let pendingBulkCourse = null;
  let pendingBulkAction = null;
  let resetSnapshot = null;
  let resetInFlight = false;
  let resetExportInFlight = false;
  let resetEventsSuppressed = false;
  let resetOutcomeUnknown = false;
  let resetReturnFocus = null;
  let courseSignature = "";
  let ready = false;
  let hashHandled = false;
  let destroyed = false;

  function noteWord(count) {
    return count === 1 ? "note" : "notes";
  }

  function trashWord(count) {
    return count === 1 ? "Trash entry" : "Trash entries";
  }

  function expectedEpochOptions(options = {}) {
    return { ...options, expectedEpoch: dataEpoch };
  }

  function isDataResetError(error) {
    return error instanceof ValidationError && error.code === "data-reset";
  }

  async function assertCurrentDataEpoch() {
    const currentEpoch = await loadDataEpoch(storage);
    if (dataEpoch && currentEpoch !== dataEpoch) {
      throw new ValidationError(
        "The note data was reset in another window. This older page cannot read or save changes.",
        "data-reset",
      );
    }
  }

  async function readStateForPage() {
    await assertCurrentDataEpoch();
    const value = await loadState(storage, expectedEpochOptions());
    await assertCurrentDataEpoch();
    return value;
  }

  async function readEditorDraftForPage() {
    await assertCurrentDataEpoch();
    const value = await loadEditorDraft(storage, expectedEpochOptions());
    await assertCurrentDataEpoch();
    return value;
  }

  async function readRecoveryForPage() {
    await assertCurrentDataEpoch();
    const value = await loadRecoveryNotice(storage, expectedEpochOptions());
    await assertCurrentDataEpoch();
    return value;
  }

  function markDataResetConflict(statusElement = elements.status) {
    dataResetConflict = true;
    editorDraftBlocked = elements.editorDialog.open;
    if (elements.editorDialog.open) {
      if (editorDirty) {
        editorDraftSynced = false;
      }
      setStatus(
        elements.editorStatus,
        editorDirty
          ? "Saved data was reset in another window. This editor text is still here, but this older page cannot save it. Copy the text, then reload the library."
          : "Saved data was reset in another window. This editor can no longer save from this older page. Reload the library before editing.",
        "error",
      );
      setEditorBusy(false);
    }
    setLibraryAvailable(false);
    elements.retryLoad.textContent = "Reload page";
    elements.retryLoad.hidden = false;
    elements.summary.textContent = "Reload required";
    setStatus(
      elements.status,
      "Saved data was reset in another window. Reload this page before making more changes.",
      "error",
    );
    if (statusElement !== elements.status && statusElement !== elements.editorStatus) {
      setStatus(
        statusElement,
        "Saved data was reset in another window. Reload this page before trying again.",
        "error",
      );
    }
  }

  function reportActionError(error, statusElement = elements.status) {
    if (isDataResetError(error)) {
      markDataResetConflict(statusElement);
      return;
    }
    setStatus(statusElement, errorMessage(error), "error");
  }

  function formatStorageSize(bytes) {
    if (bytes < 1_024) {
      return `${numberFormatter.format(bytes)} B`;
    }
    if (bytes < 1_048_576) {
      return `${numberFormatter.format(Number((bytes / 1_024).toFixed(1)))} KB`;
    }
    return `${numberFormatter.format(Number((bytes / 1_048_576).toFixed(2)))} MB`;
  }

  function themeLabel(value) {
    return { system: "System", light: "Light", dark: "Dark" }[value] || value;
  }

  function sortLabel(value) {
    return {
      "updated-desc": "Recently updated",
      "created-desc": "Newest created",
      "created-asc": "Oldest created",
      "title-asc": "Title",
    }[value] || value;
  }

  function paintStorageUsage(usage) {
    elements.storageUsage.dataset.level = usage.level;
    elements.storageUsageMeter.max = usage.byteLimit;
    elements.storageUsageMeter.value = usage.bytes;
    elements.storageUsageMeter.textContent = `${formatStorageSize(usage.bytes)} of ${formatStorageSize(usage.byteLimit)}`;
    const storagePrefix = usage.hasMeasuredStorageBytes ? "" : "At least ";
    elements.storageUsageText.textContent = `${storagePrefix}${formatStorageSize(usage.bytes)} of ${formatStorageSize(usage.byteLimit)} used. The note library record uses ${formatStorageSize(usage.stateBytes)} of ${formatStorageSize(usage.stateByteLimit)}. ${numberFormatter.format(usage.notes)} of ${numberFormatter.format(usage.noteLimit)} active notes, ${numberFormatter.format(usage.trash)} of ${numberFormatter.format(usage.trashLimit)} Trash entries.`;
    elements.storageUsageWarning.hidden = usage.level === "normal";
    elements.storageUsageWarning.textContent = usage.level === "critical"
      ? "The library is very close to a storage or note-count limit. Export a backup, then permanently remove notes you no longer need."
      : usage.level === "warning"
        ? "The library is nearing a storage or note-count limit. Export a backup before removing notes."
        : "";
  }

  async function refreshStorageUsage() {
    const requestedState = state;
    const requestGeneration = ++storageUsageRequestGeneration;
    if (!requestedState) {
      return;
    }

    let storageBytes;
    if (typeof storage.getBytesInUse === "function") {
      try {
        storageBytes = await storage.getBytesInUse(null);
      } catch {
        storageBytes = undefined;
      }
    }

    if (
      destroyed ||
      requestGeneration !== storageUsageRequestGeneration ||
      state !== requestedState
    ) {
      return;
    }
    measuredUsageState = requestedState;
    measuredUsage = measureLibraryUsage(requestedState, { storageBytes });
    paintStorageUsage(measuredUsage);
  }

  function renderStorageUsage() {
    if (!state) {
      return;
    }
    if (measuredUsageState !== state) {
      measuredUsageState = state;
      measuredUsage = measureLibraryUsage(state);
      paintStorageUsage(measuredUsage);
      void refreshStorageUsage();
      return;
    }
    paintStorageUsage(measuredUsage);
  }

  function renderRecoveryNotice() {
    const rejectedNotes = recoveryInfo.rejectedNotes || 0;
    const rejectedDrafts = recoveryInfo.rejectedDrafts || 0;
    const hasRecovery = rejectedNotes > 0 || rejectedDrafts > 0;
    elements.recoveryNotice.hidden = !hasRecovery;
    elements.acknowledgeRecovery.disabled = !ready || !hasRecovery;
    elements.recoveryMessage.textContent = hasRecovery
      ? `The repair discarded ${numberFormatter.format(rejectedNotes)} invalid ${noteWord(rejectedNotes)} and ${numberFormatter.format(rejectedDrafts)} invalid ${rejectedDrafts === 1 ? "draft" : "drafts"}. Valid saved data was kept.`
      : "";
    if (!hasRecovery) {
      setStatus(elements.recoveryStatus, "", "info");
    }
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
      elements.notesView,
      elements.trashView,
      elements.selectionMode,
      elements.selectAllFiltered,
      elements.clearSelection,
      elements.cancelSelection,
      elements.bulkCourse,
      elements.bulkExport,
      elements.bulkTrash,
      elements.bulkRestore,
      elements.bulkPermanentDelete,
      elements.exportJson,
      elements.exportMarkdown,
      elements.importButton,
      elements.includeSourceOnShare,
      elements.clearLocalData,
      elements.showMore,
      elements.resumeEditorDraft,
      elements.discardEditorDraft,
      elements.acknowledgeRecovery,
    ]) {
      control.disabled = !available;
    }
    elements.emptyTrash.disabled = !available || !state || state.trash.length === 0;
    const viewTotal = !state ? 0 : viewMode === "trash" ? state.trash.length : state.notes.length;
    elements.selectionMode.disabled = !available || viewTotal === 0;
    elements.list.inert = !available;
    if (state) {
      updateSelectionControls();
    }
  }

  function currentViewOptions() {
    return {
      view: viewMode,
      query: elements.search.value,
      course: elements.course.value,
      sort: elements.sort.value,
    };
  }

  function notesForView(stateValue, options = currentViewOptions()) {
    if (options.view !== "trash") {
      return selectNotes(stateValue.notes, options);
    }

    const notesById = new Map(stateValue.trash.map((entry) => [entry.note.id, entry.note]));
    const sorted = selectNotes(
      stateValue.trash.map((entry) => ({ ...entry.note, updatedAt: entry.deletedAt })),
      options,
    );
    return sorted.map((note) => notesById.get(note.id));
  }

  function selectedNotes() {
    return notesForView(state);
  }

  function currentViewRecord(identifier, stateValue = state, mode = viewMode) {
    if (mode === "trash") {
      return stateValue?.trash.find((entry) => entry.note.id === identifier) || null;
    }
    return stateValue?.notes.find((note) => note.id === identifier) || null;
  }

  function selectedRecordSnapshot() {
    updateSelectionControls(selectedNotes());
    const identifiers = [...selectedIds];
    if (identifiers.length === 0) {
      throw new ValidationError("Choose at least one note.", "selection-empty");
    }
    const records = identifiers.map((identifier) => currentViewRecord(identifier));
    if (records.some((record) => !record)) {
      throw new ValidationError("A selected note changed in another window.", "selection-conflict");
    }
    return {
      view: viewMode,
      identifiers,
      records: structuredClone(records),
    };
  }

  function assertSelectedRecords(current, snapshot) {
    const currentRecords = snapshot.identifiers.map((identifier) =>
      currentViewRecord(identifier, current, snapshot.view),
    );
    if (
      currentRecords.some((record) => !record) ||
      JSON.stringify(currentRecords) !== JSON.stringify(snapshot.records)
    ) {
      throw new ValidationError(
        "A selected note changed in another window. Review the selection before trying again.",
        "selection-conflict",
      );
    }
  }

  function selectedCountLabel(count) {
    return `${numberFormatter.format(count)} ${noteWord(count)} selected`;
  }

  function updateSelectionControls(notes = selectedNotes()) {
    const eligible = new Set(notes.map((note) => note.id));
    for (const identifier of selectedIds) {
      if (!eligible.has(identifier)) {
        selectedIds.delete(identifier);
      }
    }
    const selectedCount = selectedIds.size;
    elements.selectionToolbar.hidden = !selectionMode;
    elements.selectionMode.setAttribute("aria-pressed", String(selectionMode));
    elements.selectionMode.textContent = selectionMode ? "Selecting notes" : "Select notes";
    elements.selectionCount.textContent = selectedCountLabel(selectedCount);
    elements.selectAllFiltered.disabled = !ready || notes.length === 0 || selectedCount === notes.length;
    elements.clearSelection.disabled = !ready || selectedCount === 0;
    elements.activeSelectionActions.hidden = viewMode !== "notes";
    elements.trashSelectionActions.hidden = viewMode !== "trash";
    const bulkControls = [
      elements.bulkCourse,
      elements.bulkExport,
      elements.bulkTrash,
      elements.bulkRestore,
      elements.bulkPermanentDelete,
    ];
    const activeBulkControl = bulkControls.includes(documentValue.activeElement);
    for (const control of bulkControls) {
      control.disabled = !ready || selectedCount === 0;
    }
    for (const card of elements.list.querySelectorAll("[data-note-id]")) {
      const selected = selectedIds.has(card.dataset.noteId);
      card.dataset.selected = String(selected);
      const checkbox = card.querySelector(".note-select-checkbox");
      const selection = card.querySelector(".note-selection");
      if (checkbox) {
        checkbox.checked = selected;
      }
      if (selection) {
        selection.hidden = !selectionMode;
      }
      const actions = card.querySelector(".note-actions");
      if (actions) {
        actions.hidden = selectionMode;
      }
    }
    if (ready && selectionMode && activeBulkControl && selectedCount === 0) {
      (!elements.selectAllFiltered.disabled
        ? elements.selectAllFiltered
        : elements.cancelSelection).focus();
    }
  }

  function finishSelection(focusTarget = elements.selectionMode) {
    selectionMode = false;
    selectedIds.clear();
    pendingBulkCourse = null;
    pendingBulkAction = null;
    render();
    focusTarget?.focus?.();
    selectionReturnFocus = null;
  }

  function renderCourseOptions() {
    const notes = viewMode === "trash" ? state.trash.map((entry) => entry.note) : state.notes;
    const courses = listCourses(notes);
    const signature = JSON.stringify([viewMode, courses]);
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
    card.dataset.selected = String(selectedIds.has(note.id));

    const selection = fragment.querySelector(".note-selection");
    selection.hidden = !selectionMode;
    const checkbox = fragment.querySelector(".note-select-checkbox");
    checkbox.value = note.id;
    checkbox.checked = selectedIds.has(note.id);
    checkbox.setAttribute("aria-label", `Select ${note.title}`);

    const course = fragment.querySelector(".note-course");
    course.textContent = note.course;
    course.hidden = !note.course;
    const title = fragment.querySelector(".note-title-button");
    title.textContent = note.title;
    const time = fragment.querySelector(".note-time");
    const trashEntry = viewMode === "trash"
      ? state.trash.find((entry) => entry.note.id === note.id)
      : null;
    const showCreated = state.settings.sort.startsWith("created-");
    const dateValue = trashEntry?.deletedAt || (showCreated ? note.createdAt : note.updatedAt);
    const dateLabel = trashEntry ? "Deleted" : showCreated ? "Created" : "Updated";
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

    fragment.querySelector(".active-note-actions").hidden = Boolean(trashEntry);
    fragment.querySelector(".trash-note-actions").hidden = !trashEntry;
    fragment.querySelector(".note-actions").hidden = selectionMode;
    for (const button of fragment.querySelectorAll("button[data-action]")) {
      const action = button.dataset.action;
      const labels = {
        view: "View details for",
        copy: "Copy",
        edit: "Edit",
        delete: "Move to Trash",
        restore: "Restore",
        "permanent-delete": "Delete permanently",
      };
      const label = labels[action] || "Open";
      button.setAttribute("aria-label", `${label} ${note.title}`);
    }

    return fragment;
  }

  function findNoteRecord(identifier) {
    const note = state?.notes.find((candidate) => candidate.id === identifier);
    if (note) {
      return { note, trashEntry: null };
    }
    const trashEntry = state?.trash.find((entry) => entry.note.id === identifier);
    return trashEntry ? { note: trashEntry.note, trashEntry } : null;
  }

  function setDetailTime(element, value) {
    element.dateTime = value;
    element.textContent = formatDate(value);
    element.title = value;
  }

  function renderDetail() {
    if (!detailNoteId || !elements.detailDialog.open) {
      return;
    }
    const record = findNoteRecord(detailNoteId);
    if (!record) {
      detailNoteId = null;
      closeDialog(elements.detailDialog);
      setStatus(elements.status, "This note is no longer in the library.", "warning");
      return;
    }

    const { note, trashEntry } = record;
    elements.detailHeading.textContent = note.title;
    elements.detailCourse.textContent = note.course;
    elements.detailCourseRow.hidden = !note.course;
    elements.detailSourceTitle.textContent = note.source.title;
    elements.detailSourceTitleRow.hidden = !note.source.title;
    elements.detailSourceUrl.href = note.source.url || "";
    elements.detailSourceUrl.textContent = note.source.url;
    elements.detailSourceUrlRow.hidden = !note.source.url;
    setDetailTime(elements.detailCreated, note.createdAt);
    setDetailTime(elements.detailUpdated, note.updatedAt);
    elements.detailDeletedRow.hidden = !trashEntry;
    if (trashEntry) {
      setDetailTime(elements.detailDeleted, trashEntry.deletedAt);
    } else {
      elements.detailDeleted.removeAttribute("datetime");
      elements.detailDeleted.removeAttribute("title");
      elements.detailDeleted.textContent = "";
    }
    elements.detailBody.textContent = note.body;
    elements.detailActiveActions.hidden = Boolean(trashEntry);
    elements.detailTrashActions.hidden = !trashEntry;
    for (const [button, label] of [
      [elements.detailCopy, "Copy note"],
      [elements.detailEdit, "Edit note"],
      [elements.detailDelete, "Move note to Trash"],
      [elements.detailRestore, "Restore note"],
      [elements.detailPermanentDelete, "Delete note permanently"],
    ]) {
      button.setAttribute("aria-label", `${label}: ${note.title}`);
    }
  }

  function openDetail(note, trigger) {
    const card = trigger?.closest?.("[data-note-id]");
    detailReturnFocus = card?.querySelector("[data-action='view']") || trigger || elements.newNote;
    detailNoteId = note.id;
    setStatus(elements.detailStatus, "", "info");
    showDialog(elements.detailDialog);
    renderDetail();
    elements.closeDetail.focus();
  }

  function closeDetailForAction() {
    const target = refreshReturnFocus(detailReturnFocus);
    detailReturnFocus = null;
    detailNoteId = null;
    closeDialog(elements.detailDialog);
    return target;
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
    const viewTotal = viewMode === "trash" ? state.trash.length : state.notes.length;
    if (selectionMode && viewTotal === 0) {
      selectionMode = false;
      selectedIds.clear();
      selectionReturnFocus = null;
    }
    renderCourseOptions();
    elements.sort.value = state.settings.sort;
    elements.sort.options[0].textContent = viewMode === "trash" ? "Recently deleted" : "Recently updated";
    elements.theme.value = state.settings.theme;
    elements.includeSourceOnShare.checked = state.settings.includeSourceOnShare;
    const notes = selectedNotes();
    const shownNotes = notes.slice(0, visibleLimit);
    elements.list.replaceChildren(...shownNotes.map(createNoteCard));
    updateSelectionControls(notes);
    editorReturnFocus = refreshReturnFocus(editorReturnFocus);
    detailReturnFocus = refreshReturnFocus(detailReturnFocus);
    deleteReturnFocus = refreshReturnFocus(deleteReturnFocus);
    permanentDeleteReturnFocus = refreshReturnFocus(permanentDeleteReturnFocus);

    const total = viewMode === "trash" ? state.trash.length : state.notes.length;
    const hasNotes = total > 0;
    const hasFilters = Boolean(elements.search.value.trim() || elements.course.value);
    elements.notesView.setAttribute("aria-pressed", String(viewMode === "notes"));
    elements.trashView.setAttribute("aria-pressed", String(viewMode === "trash"));
    elements.notesView.classList.toggle("button-secondary", viewMode === "notes");
    elements.notesView.classList.toggle("button-quiet", viewMode !== "notes");
    elements.trashView.classList.toggle("button-secondary", viewMode === "trash");
    elements.trashView.classList.toggle("button-quiet", viewMode !== "trash");
    elements.activeNoteCount.textContent = numberFormatter.format(state.notes.length);
    elements.trashNoteCount.textContent = numberFormatter.format(state.trash.length);
    elements.notesView.setAttribute("aria-label", `Notes, ${numberFormatter.format(state.notes.length)}`);
    elements.trashView.setAttribute("aria-label", `Trash, ${numberFormatter.format(state.trash.length)}`);
    elements.emptyTrash.hidden = viewMode !== "trash";
    elements.emptyTrash.disabled = !ready || state.trash.length === 0;
    elements.selectionMode.disabled = !ready || total === 0;
    elements.emptyNewNote.hidden = viewMode === "trash";
    elements.emptyHeading.textContent = viewMode === "trash" ? "Trash is empty" : "No saved notes yet";
    elements.emptyMessage.textContent = viewMode === "trash"
      ? "Notes moved to Trash remain here until you restore or permanently delete them."
      : "Your notes stay in this Chrome profile. Create one here, or select text on a page and open the extension.";
    elements.empty.hidden = hasNotes;
    elements.noResults.hidden = !hasNotes || notes.length > 0 || !hasFilters;
    elements.list.hidden = !hasNotes || notes.length === 0;
    elements.showMore.hidden = shownNotes.length >= notes.length;
    if (!hasNotes) {
      elements.summary.textContent = viewMode === "trash" ? "Trash is empty" : "No saved notes";
    } else if (notes.length === 0) {
      elements.summary.textContent = "No matching notes";
    } else if (shownNotes.length < notes.length) {
      elements.summary.textContent = hasFilters
        ? `Showing ${numberFormatter.format(shownNotes.length)} of ${numberFormatter.format(notes.length)} matching ${noteWord(notes.length)} (${numberFormatter.format(total)} total)`
        : `Showing ${numberFormatter.format(shownNotes.length)} of ${numberFormatter.format(total)} ${noteWord(total)}`;
    } else if (hasFilters) {
      elements.summary.textContent = `${numberFormatter.format(notes.length)} matching ${noteWord(notes.length)} (${numberFormatter.format(total)} total)`;
    } else {
      elements.summary.textContent = viewMode === "trash"
        ? `${numberFormatter.format(total)} ${noteWord(total)} in Trash`
        : `${numberFormatter.format(total)} ${noteWord(total)}`;
    }
    renderStorageUsage();
    refreshResetReview();
    renderDetail();
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
          expectedEpoch: dataEpoch,
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
            expectedEpoch: dataEpoch,
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
      if (isDataResetError(error)) {
        markDataResetConflict(elements.editorStatus);
      } else {
        setStatus(
          elements.editorStatus,
          `Draft could not be saved: ${errorMessage(error)} Keep this editor open and copy your work before closing.`,
          "error",
        );
      }
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
          expectedEpoch: dataEpoch,
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
      if (isDataResetError(error)) {
        markDataResetConflict(elements.editorStatus);
      } else {
        setStatus(elements.editorStatus, `The saved draft could not be cleared: ${errorMessage(error)}`, "error");
      }
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
    const actionsBlocked = dataResetConflict && elements.editorDialog.open;
    elements.editorForm.setAttribute("aria-busy", String(busy));
    elements.editorForm.inert = busy;
    elements.saveEditor.disabled = busy || actionsBlocked;
    elements.cancelEditor.disabled = busy;
    elements.closeEditor.disabled = busy;
    elements.editorSaveDuplicate.disabled = busy || actionsBlocked;
    elements.saveEditorAsNew.disabled = busy || actionsBlocked;
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
      const nextState = await readStateForPage();
      const record = await readEditorDraftForPage();
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
        expectedEpoch: dataEpoch,
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
      if (isDataResetError(error)) {
        markDataResetConflict(elements.editorDraftStatus);
      } else {
        setStatus(elements.editorDraftStatus, `Draft could not be opened: ${errorMessage(error)}`, "error");
      }
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
        expectedEpoch: dataEpoch,
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
      if (isDataResetError(error)) {
        markDataResetConflict(elements.editorDraftStatus);
      } else {
        setStatus(elements.editorDraftStatus, `Draft could not be discarded: ${errorMessage(error)}`, "error");
      }
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
          expectedEpoch: dataEpoch,
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
      if (isDataResetError(error)) {
        markDataResetConflict(elements.editorStatus);
      } else if (error instanceof ValidationError && error.code === "duplicate") {
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
    elements.deleteMessage.replaceChildren(
      "“",
      title,
      "” will move to Trash. New JSON backups include this note as a Trash entry until it is permanently deleted. Backups you already exported do not change.",
    );
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
        return moveNoteToTrash(current, noteToDelete.id);
      }, storage, expectedEpochOptions());
      state = result.state;
      pendingDelete = null;
      deleteReturnFocus = null;
      closeDialog(elements.deleteDialog);
      render();
      showUndo({ note: result.note, index: result.index, stateSnapshot: JSON.stringify(state) });
      setStatus(elements.status, "Note moved to Trash. You can restore it now or later from Trash.", "success");
      const nextFocus = elements.list.querySelector("[data-action='view']") || elements.newNote;
      nextFocus.focus();
    } catch (error) {
      reportActionError(error, elements.deleteStatus);
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
        (current) => restoreTrashedNote(current, record.note.id),
        storage,
        expectedEpochOptions(),
      );
      state = result.state;
      hideUndo();
      render();
      setStatus(elements.status, "Note restored.", "success");
      [...elements.list.querySelectorAll("[data-note-id]")]
        .find((card) => card.dataset.noteId === record.note.id)
        ?.querySelector("[data-action='view']")
        ?.focus();
    } catch (error) {
      reportActionError(error);
    } finally {
      elements.undo.disabled = false;
    }
  }

  async function restoreFromTrash(entry, button) {
    button.disabled = true;
    try {
      const result = await mutateState((current) => {
        const latest = current.trash.find((candidate) => candidate.note.id === entry.note.id);
        if (!latest) {
          throw new ValidationError("The note was restored or deleted in another window.", "trash-note-missing");
        }
        if (JSON.stringify(latest) !== JSON.stringify(entry)) {
          throw new ValidationError("This Trash entry changed in another window. Review it before restoring.", "trash-conflict");
        }
        return restoreTrashedNote(current, entry.note.id);
      }, storage, expectedEpochOptions());
      state = result.state;
      hideUndo();
      render();
      setStatusWithValue(elements.status, "Restored “", result.note.title, "”.", "success");
      (elements.list.querySelector("[data-action='view']") || elements.trashView).focus();
    } catch (error) {
      reportActionError(error);
      refreshReturnFocus(button)?.focus?.();
    } finally {
      button.disabled = false;
    }
  }

  function openPermanentDelete(entry, trigger) {
    pendingPermanentDelete = entry;
    permanentDeleteReturnFocus = trigger;
    const title = documentValue.createElement("bdi");
    title.dir = "auto";
    title.textContent = entry.note.title;
    elements.permanentDeleteMessage.replaceChildren("“", title, "” will be removed from this Chrome profile.");
    setStatus(elements.permanentDeleteStatus, "", "info");
    showDialog(elements.permanentDeleteDialog);
    elements.cancelPermanentDelete.focus();
  }

  async function permanentlyDeleteNote() {
    if (!pendingPermanentDelete) {
      return;
    }
    const entry = pendingPermanentDelete;
    elements.confirmPermanentDelete.disabled = true;
    elements.cancelPermanentDelete.disabled = true;
    try {
      const result = await mutateState((current) => {
        const latest = current.trash.find((candidate) => candidate.note.id === entry.note.id);
        if (!latest) {
          throw new ValidationError("The note was restored or deleted in another window.", "trash-note-missing");
        }
        if (JSON.stringify(latest) !== JSON.stringify(entry)) {
          throw new ValidationError("This Trash entry changed in another window. Close this confirmation and review it.", "trash-conflict");
        }
        return permanentlyDeleteTrashedNote(current, entry.note.id);
      }, storage, expectedEpochOptions());
      state = result.state;
      pendingPermanentDelete = null;
      permanentDeleteReturnFocus = null;
      closeDialog(elements.permanentDeleteDialog);
      render();
      setStatus(elements.status, "Note permanently deleted.", "success");
      (elements.list.querySelector("[data-action='restore']") || elements.trashView).focus();
    } catch (error) {
      reportActionError(error, elements.permanentDeleteStatus);
      timerApi.setTimeout(() => elements.confirmPermanentDelete.focus(), 0);
    } finally {
      elements.confirmPermanentDelete.disabled = false;
      elements.cancelPermanentDelete.disabled = false;
    }
  }

  function openEmptyTrash() {
    if (!state?.trash.length) {
      return;
    }
    emptyTrashSnapshot = JSON.stringify(state.trash);
    const count = state.trash.length;
    elements.emptyTrashMessage.textContent = `${numberFormatter.format(count)} ${noteWord(count)} will be permanently deleted.`;
    setStatus(elements.emptyTrashStatus, "", "info");
    showDialog(elements.emptyTrashDialog);
    elements.cancelEmptyTrash.focus();
  }

  async function deleteAllTrash() {
    if (!emptyTrashSnapshot) {
      return;
    }
    const snapshot = emptyTrashSnapshot;
    elements.confirmEmptyTrash.disabled = true;
    elements.cancelEmptyTrash.disabled = true;
    try {
      const result = await mutateState((current) => {
        if (JSON.stringify(current.trash) !== snapshot) {
          throw new ValidationError(
            "Trash changed in another window. Close this confirmation and review it before trying again.",
            "trash-conflict",
          );
        }
        return emptyTrash(current);
      }, storage, expectedEpochOptions());
      state = result.state;
      emptyTrashSnapshot = null;
      closeDialog(elements.emptyTrashDialog);
      render();
      setStatus(elements.status, `${numberFormatter.format(result.deleted)} ${noteWord(result.deleted)} permanently deleted.`, "success");
      elements.trashView.focus();
    } catch (error) {
      reportActionError(error, elements.emptyTrashStatus);
      timerApi.setTimeout(() => elements.confirmEmptyTrash.focus(), 0);
    } finally {
      elements.confirmEmptyTrash.disabled = false;
      elements.cancelEmptyTrash.disabled = false;
    }
  }

  async function copyNote(note, button, statusElement = elements.status) {
    const idleLabel = button.dataset.copyIdleLabel || button.textContent;
    button.dataset.copyIdleLabel = idleLabel;
    try {
      await navigatorValue.clipboard.writeText(noteToPlainText(note, {
        includeSource: elements.includeSourceOnShare.checked,
      }));
      const pendingReset = copyResetTimers.get(button);
      if (pendingReset !== undefined) {
        timerApi.clearTimeout(pendingReset);
      }
      button.textContent = "Copied";
      const resetTimer = timerApi.setTimeout(() => {
        if (button.isConnected) {
          button.textContent = idleLabel;
        }
        copyResetTimers.delete(button);
      }, 1_500);
      copyResetTimers.set(button, resetTimer);
      setStatusWithValue(statusElement, "Copied “", note.title, "”.", "success");
    } catch {
      setStatus(statusElement, "Chrome could not copy the note. Select its text in the editor instead.", "error");
    }
  }

  function adoptFreshExportState(nextState) {
    const changed = !state || JSON.stringify(nextState) !== JSON.stringify(state);
    if (!changed) {
      return;
    }
    if (undoRecord && JSON.stringify(nextState) !== undoRecord.stateSnapshot) {
      hideUndo();
    }
    state = nextState;
    applyTheme(state.settings.theme, documentValue);
    render();
    if (pendingImport) {
      renderImportPreview();
    }
  }

  async function readFreshExportState(validate) {
    const nextState = await readStateForPage();
    let validationError = null;
    try {
      validate?.(nextState);
    } catch (error) {
      validationError = error;
    }
    adoptFreshExportState(nextState);
    if (validationError) {
      throw validationError;
    }
    return nextState;
  }

  async function exportJson(statusElement = elements.status) {
    if (!state) {
      setStatus(statusElement, "The library is not available yet.", "error");
      return false;
    }
    try {
      const latestState = await readFreshExportState();
      const text = serializeBackup(latestState);
      downloadText(text, backupFilename("json"), "application/json", documentValue, urlApi);
      setStatus(statusElement, "Backup exported.", "success");
      return true;
    } catch (error) {
      reportActionError(error, statusElement);
      return false;
    }
  }

  async function exportMarkdown() {
    if (!state) {
      setStatus(elements.status, "The library is not available yet.", "error");
      return;
    }
    const viewOptions = currentViewOptions();
    const includeSource = elements.includeSourceOnShare.checked;
    try {
      const latestState = await readFreshExportState();
      const notes = notesForView(latestState, viewOptions);
      if (notes.length === 0) {
        setStatus(elements.status, "No notes match the current view.", "warning");
        return;
      }
      const text = notesToMarkdown(notes, {
        includeSource,
      });
      downloadText(text, backupFilename("md"), "text/markdown", documentValue, urlApi);
      setStatus(
        elements.status,
        `Exported ${numberFormatter.format(notes.length)} ${noteWord(notes.length)} from the current view as Markdown.`,
        "success",
      );
    } catch (error) {
      reportActionError(error);
    }
  }

  function resetStateSignature() {
    return JSON.stringify(state);
  }

  function renderResetMessage() {
    if (!state) {
      elements.resetMessage.textContent = "The library is not available.";
      return;
    }
    const activeCount = state.notes.length;
    const trashCount = state.trash.length;
    elements.resetMessage.textContent = `This will clear ${numberFormatter.format(activeCount)} active ${noteWord(activeCount)} and ${numberFormatter.format(trashCount)} ${trashWord(trashCount)} from this Chrome profile.`;
  }

  function updateResetControls() {
    const confirmed = elements.resetConfirmation.value === "DELETE";
    const busy = resetInFlight || resetExportInFlight;
    elements.confirmReset.disabled = busy || !confirmed;
    elements.cancelReset.disabled = busy;
    elements.resetExport.disabled = busy;
    elements.resetConfirmation.disabled = busy;
    elements.resetForm.setAttribute("aria-busy", String(busy));
  }

  function setResetSnapshot() {
    resetSnapshot = state
      ? {
          epoch: dataEpoch,
          revision: state.revision,
          state: resetStateSignature(),
        }
      : null;
    renderResetMessage();
  }

  function refreshResetReview() {
    if (!elements.resetDialog.open || !state) {
      return;
    }
    renderResetMessage();
    const signature = resetStateSignature();
    if (resetSnapshot && signature !== resetSnapshot.state) {
      setResetSnapshot();
      elements.resetConfirmation.value = "";
      setStatus(
        elements.resetStatus,
        "The library changed in another window. Review the updated counts and type DELETE again.",
        "warning",
      );
    }
    updateResetControls();
  }

  function openResetDialog(trigger) {
    if (!ready || !state) {
      return;
    }
    resetReturnFocus = trigger || elements.clearLocalData;
    elements.resetConfirmation.value = "";
    setStatus(elements.resetStatus, "", "info");
    setResetSnapshot();
    updateResetControls();
    showDialog(elements.resetDialog);
    elements.cancelReset.focus();
  }

  function resetLocalPage(result) {
    cancelEditorDraftTimer();
    if (searchTimer !== null) {
      timerApi.clearTimeout(searchTimer);
      searchTimer = null;
    }
    dataEpoch = result.epoch;
    state = result.state;
    dataResetConflict = false;
    resetOutcomeUnknown = false;
    resetEventsSuppressed = false;
    editorDraftRecord = result.editorDraftRecord;
    externalEditorDraftRecord = null;
    editorDraftGeneration = result.editorDraftRecord?.contentGeneration || 0;
    editorDraftSynced = true;
    editorDraftBlocked = false;
    editorDraftUnavailable = false;
    editorDraftSaveAnnounced = false;
    editingId = null;
    editingSnapshot = null;
    editingBaseNote = null;
    editingBaseRevision = 0;
    editorInitialInput = "";
    editorDirty = false;
    recoveringAsCopy = false;
    editorReturnFocus = null;
    editorSessionId = "";
    detailNoteId = null;
    detailReturnFocus = null;
    pendingDelete = null;
    deleteReturnFocus = null;
    pendingPermanentDelete = null;
    permanentDeleteReturnFocus = null;
    emptyTrashSnapshot = null;
    pendingBulkCourse = null;
    pendingBulkAction = null;
    importReadGeneration += 1;
    pendingImport = null;
    pendingImportPreview = null;
    pendingReplaceStateSnapshot = null;
    replaceInFlight = false;
    recoveryInfo = { createdAt: "", rejectedNotes: 0, rejectedDrafts: 0 };
    measuredUsageState = null;
    measuredUsage = null;
    selectionMode = false;
    selectedIds.clear();
    selectionReturnFocus = null;
    viewMode = "notes";
    visibleLimit = DISPLAY_BATCH;
    courseSignature = "";
    undoRecord = null;
    elements.undoBar.hidden = true;
    elements.search.value = "";
    elements.course.value = "";
    elements.importFile.value = "";
    elements.editorTitle.value = "";
    elements.editorCourse.value = "";
    elements.editorBody.value = "";
    elements.editorSourceTitle.value = "";
    elements.editorSourceUrl.value = "";
    elements.editorSourceDetails.open = false;
    elements.editorDuplicate.hidden = true;
    elements.editorConflict.hidden = true;
    elements.editorDraftRecovery.hidden = true;
    elements.recoveryNotice.hidden = true;
    resetSnapshot = null;
    resetReturnFocus = null;
    for (const dialog of documentValue.querySelectorAll("dialog[open]")) {
      closeDialog(dialog);
    }
    applyTheme(state.settings.theme, documentValue);
    render();
  }

  async function inspectResetOutcome(previousEpoch) {
    try {
      const stored = await storage.get([
        STORAGE_KEYS.dataEpoch,
        STORAGE_KEYS.state,
        STORAGE_KEYS.editorDraft,
      ]);
      const epoch = stored[STORAGE_KEYS.dataEpoch];
      const resetState = stored[STORAGE_KEYS.state];
      const editorRecord = stored[STORAGE_KEYS.editorDraft];
      if (
        typeof epoch === "string" &&
        epoch !== previousEpoch &&
        Array.isArray(resetState?.notes) &&
        resetState.notes.length === 0 &&
        Array.isArray(resetState?.trash) &&
        resetState.trash.length === 0 &&
        editorRecord?.draft === null
      ) {
        return {
          status: "completed",
          result: { epoch, state: resetState, editorDraftRecord: editorRecord },
        };
      }
      return { status: epoch === previousEpoch ? "not-completed" : "unknown" };
    } catch {
      return { status: "unknown" };
    }
  }

  async function reconcileAfterFailedReset() {
    const hadSuppressedChanges = resetEventsSuppressed;
    const nextState = await readStateForPage();
    const nextEditorDraft = await readEditorDraftForPage();
    const nextRecovery = await readRecoveryForPage();
    if (undoRecord && JSON.stringify(nextState) !== undoRecord.stateSnapshot) {
      hideUndo();
    }
    state = nextState;
    editorDraftRecord = nextEditorDraft;
    externalEditorDraftRecord = null;
    editorDraftUnavailable = false;
    recoveryInfo = nextRecovery;
    resetEventsSuppressed = false;
    applyTheme(state.settings.theme, documentValue);
    render();
    renderEditorDraftRecovery();
    renderRecoveryNotice();
    elements.resetConfirmation.value = "";
    setResetSnapshot();
    updateResetControls();
    return hadSuppressedChanges;
  }

  function markResetOutcomeUnknown() {
    resetOutcomeUnknown = true;
    resetEventsSuppressed = false;
    setLibraryAvailable(false);
    elements.retryLoad.textContent = "Reload page";
    elements.retryLoad.hidden = false;
    elements.summary.textContent = "Reload required";
    setStatus(
      elements.status,
      "Chrome could not confirm whether local data was cleared. Reload this page before making more changes.",
      "error",
    );
  }

  async function confirmDataReset() {
    if (
      resetInFlight ||
      resetExportInFlight ||
      !resetSnapshot ||
      elements.resetConfirmation.value !== "DELETE"
    ) {
      return;
    }
    const reviewed = resetSnapshot;
    let focusAfterReset = null;
    resetInFlight = true;
    resetEventsSuppressed = false;
    updateResetControls();
    setStatus(elements.resetStatus, "Clearing local data...", "info");
    try {
      const result = await resetAllData(storage, {
        expectedEpoch: reviewed.epoch,
        expectedRevision: reviewed.revision,
      });
      resetLocalPage(result);
      setLibraryAvailable(true);
      render();
      setStatus(
        elements.status,
        "Local notes, drafts, settings, pending captures, and recovery data were cleared.",
        "success",
      );
      elements.newNote.focus();
    } catch (error) {
      if (isDataResetError(error)) {
        resetReturnFocus = null;
        closeDialog(elements.resetDialog);
        markDataResetConflict();
        focusAfterReset = elements.retryLoad;
      } else if (error instanceof ValidationError && error.code === "state-conflict") {
        try {
          await reconcileAfterFailedReset();
          setStatus(
            elements.resetStatus,
            "The library changed in another window. Review the updated counts and type DELETE again.",
            "warning",
          );
          focusAfterReset = elements.resetConfirmation;
        } catch (readError) {
          resetReturnFocus = null;
          closeDialog(elements.resetDialog);
          if (isDataResetError(readError)) {
            markDataResetConflict();
          } else {
            markResetOutcomeUnknown();
          }
          focusAfterReset = elements.retryLoad;
        }
      } else {
        const outcome = await inspectResetOutcome(reviewed.epoch);
        if (outcome.status === "completed") {
          resetLocalPage(outcome.result);
          setLibraryAvailable(false);
          elements.retryLoad.textContent = "Retry cleanup";
          elements.retryLoad.hidden = false;
          elements.summary.textContent = "Local data cleared";
          setStatus(
            elements.status,
            "Local data was cleared, but Chrome could not finish removing supporting data. Reload the library or retry cleanup before creating new notes.",
            "error",
          );
          focusAfterReset = elements.retryLoad;
        } else if (outcome.status === "not-completed") {
          try {
            const restoredSuppressedChanges = await reconcileAfterFailedReset();
            const restoredMessage = restoredSuppressedChanges
              ? " Changes from another window were loaded."
              : "";
            setStatus(
              elements.resetStatus,
              `Local data was not cleared: ${errorMessage(error)}${restoredMessage}`,
              "error",
            );
            focusAfterReset = elements.resetConfirmation;
          } catch (readError) {
            resetReturnFocus = null;
            closeDialog(elements.resetDialog);
            if (isDataResetError(readError)) {
              markDataResetConflict();
            } else {
              markResetOutcomeUnknown();
            }
            focusAfterReset = elements.retryLoad;
          }
        } else {
          resetReturnFocus = null;
          closeDialog(elements.resetDialog);
          markResetOutcomeUnknown();
          focusAfterReset = elements.retryLoad;
        }
      }
    } finally {
      resetInFlight = false;
      if (elements.resetDialog.open) {
        updateResetControls();
      }
      focusAfterReset?.focus();
    }
  }

  function openBulkCourseDialog() {
    try {
      const snapshot = selectedRecordSnapshot();
      if (snapshot.view !== "notes") {
        return;
      }
      pendingBulkCourse = snapshot;
      const courses = new Set(snapshot.records.map((note) => note.course));
      elements.bulkCourseInput.value = courses.size === 1 ? snapshot.records[0].course : "";
      elements.bulkCourseMessage.textContent = `${selectedCountLabel(snapshot.identifiers.length)}. Enter one course for all of them, or clear their course.`;
      setStatus(elements.bulkCourseStatus, "", "info");
      showDialog(elements.bulkCourseDialog);
      elements.bulkCourseInput.focus();
      elements.bulkCourseInput.select();
    } catch (error) {
      reportActionError(error);
    }
  }

  function setBulkCourseBusy(busy) {
    elements.bulkCourseForm.setAttribute("aria-busy", String(busy));
    elements.bulkCourseInput.disabled = busy;
    elements.cancelBulkCourse.disabled = busy;
    elements.clearBulkCourse.disabled = busy;
    elements.applyBulkCourse.disabled = busy;
  }

  async function applyBulkCourse(course) {
    if (!pendingBulkCourse) {
      return;
    }
    if (!course.trim() && course !== "") {
      return;
    }
    const snapshot = pendingBulkCourse;
    setBulkCourseBusy(true);
    setStatus(elements.bulkCourseStatus, "", "info");
    try {
      const result = await mutateState(
        (current) => {
          assertSelectedRecords(current, snapshot);
          return assignCourseToNotes(current, snapshot.identifiers, course);
        },
        storage,
        expectedEpochOptions(),
      );
      state = result.state;
      pendingBulkCourse = null;
      closeDialog(elements.bulkCourseDialog);
      render();
      const courseMessage = result.course
        ? `Set the course to “${result.course}” for ${numberFormatter.format(result.assigned)} ${noteWord(result.assigned)}.`
        : `Cleared the course from ${numberFormatter.format(result.assigned)} ${noteWord(result.assigned)}.`;
      setStatus(elements.status, courseMessage, "success");
      const focusTarget = !elements.bulkCourse.disabled
        ? elements.bulkCourse
        : !elements.selectAllFiltered.disabled
          ? elements.selectAllFiltered
          : selectionMode
            ? elements.cancelSelection
            : elements.selectionMode;
      focusTarget.focus();
    } catch (error) {
      reportActionError(error, elements.bulkCourseStatus);
      timerApi.setTimeout(() => elements.bulkCourseInput.focus(), 0);
    } finally {
      setBulkCourseBusy(false);
    }
  }

  function openBulkConfirmation(kind) {
    try {
      const snapshot = selectedRecordSnapshot();
      if (
        (kind === "move" && snapshot.view !== "notes") ||
        (kind === "permanent-delete" && snapshot.view !== "trash")
      ) {
        return;
      }
      pendingBulkAction = { kind, snapshot };
      const count = snapshot.identifiers.length;
      elements.bulkConfirmEyebrow.textContent = kind === "move" ? "Move selected notes" : "Permanent deletion";
      elements.bulkConfirmHeading.textContent = kind === "move"
        ? "Move selected notes to Trash?"
        : "Delete selected notes permanently?";
      elements.bulkConfirmMessage.textContent = kind === "move"
        ? `${numberFormatter.format(count)} ${noteWord(count)} will move to Trash.`
        : `${numberFormatter.format(count)} ${noteWord(count)} will be removed from this Chrome profile.`;
      elements.bulkConfirmWarning.textContent = kind === "move"
        ? "Backups you already exported do not change. New JSON backups include these notes as Trash entries until they are permanently deleted."
        : "This cannot be undone. These notes will also be absent from future backups.";
      elements.confirmBulkAction.textContent = kind === "move" ? "Move to Trash" : "Delete permanently";
      setStatus(elements.bulkConfirmStatus, "", "info");
      showDialog(elements.bulkConfirmDialog);
      elements.cancelBulkConfirm.focus();
    } catch (error) {
      reportActionError(error);
    }
  }

  async function confirmBulkAction() {
    if (!pendingBulkAction) {
      return;
    }
    const pending = pendingBulkAction;
    elements.cancelBulkConfirm.disabled = true;
    elements.confirmBulkAction.disabled = true;
    try {
      const result = await mutateState(
        (current) => {
          assertSelectedRecords(current, pending.snapshot);
          return pending.kind === "move"
            ? moveNotesToTrash(current, pending.snapshot.identifiers)
            : permanentlyDeleteTrashedNotes(current, pending.snapshot.identifiers);
        },
        storage,
        expectedEpochOptions(),
      );
      state = result.state;
      hideUndo();
      pendingBulkAction = null;
      closeDialog(elements.bulkConfirmDialog);
      const count = pending.snapshot.identifiers.length;
      const message = pending.kind === "move"
        ? `${numberFormatter.format(count)} ${noteWord(count)} moved to Trash.`
        : `${numberFormatter.format(count)} ${noteWord(count)} permanently deleted.`;
      const focusTarget = pending.kind === "move" && state.notes.length > 0
        ? elements.selectionMode
        : pending.kind === "move"
          ? elements.notesView
          : elements.trashView;
      finishSelection(focusTarget);
      setStatus(elements.status, message, "success");
    } catch (error) {
      reportActionError(error, elements.bulkConfirmStatus);
      timerApi.setTimeout(() => elements.confirmBulkAction.focus(), 0);
    } finally {
      elements.cancelBulkConfirm.disabled = false;
      elements.confirmBulkAction.disabled = false;
    }
  }

  async function restoreBulkSelection() {
    let snapshot;
    try {
      snapshot = selectedRecordSnapshot();
      if (snapshot.view !== "trash") {
        return;
      }
      elements.bulkRestore.disabled = true;
      const result = await mutateState(
        (current) => {
          assertSelectedRecords(current, snapshot);
          return restoreTrashedNotes(current, snapshot.identifiers);
        },
        storage,
        expectedEpochOptions(),
      );
      state = result.state;
      hideUndo();
      finishSelection(elements.trashView);
      setStatus(
        elements.status,
        `${numberFormatter.format(result.restored)} ${noteWord(result.restored)} restored.`,
        "success",
      );
    } catch (error) {
      reportActionError(error);
    } finally {
      elements.bulkRestore.disabled = false;
    }
  }

  async function exportBulkSelection() {
    try {
      const snapshot = selectedRecordSnapshot();
      if (snapshot.view !== "notes") {
        return;
      }
      const includeSource = elements.includeSourceOnShare.checked;
      const latestState = await readFreshExportState((current) =>
        assertSelectedRecords(current, snapshot),
      );
      const selected = snapshot.identifiers.map((identifier) =>
        currentViewRecord(identifier, latestState, snapshot.view),
      );
      const text = notesToMarkdown(selected, {
        includeSource,
      });
      downloadText(text, backupFilename("md"), "text/markdown", documentValue, urlApi);
      setStatus(
        elements.status,
        `Exported ${numberFormatter.format(snapshot.identifiers.length)} selected ${noteWord(snapshot.identifiers.length)} as Markdown.`,
        "success",
      );
    } catch (error) {
      reportActionError(error);
    }
  }

  function renderReplaceConfirmation(preview) {
    elements.replaceMessage.textContent = `This will remove ${numberFormatter.format(preview.replace.removedNotes)} active ${noteWord(preview.replace.removedNotes)} and ${numberFormatter.format(preview.replace.removedTrash)} current ${trashWord(preview.replace.removedTrash)}. It will restore ${numberFormatter.format(preview.replace.resultingNotes)} active ${noteWord(preview.replace.resultingNotes)} and ${numberFormatter.format(preview.replace.resultingTrash)} ${trashWord(preview.replace.resultingTrash)}, then apply the backup theme and sorting.`;
  }

  function reopenImportPreview(message) {
    if (!pendingImport) {
      return;
    }
    pendingReplaceStateSnapshot = null;
    closeDialog(elements.replaceDialog);
    renderImportPreview();
    setStatus(elements.importStatus, message, "warning");
    showDialog(elements.importDialog);
    elements.replaceImport.focus();
  }

  function renderImportPreview() {
    if (!state || !pendingImport) {
      pendingImportPreview = null;
      return;
    }

    const preview = previewImportedBackup(state, pendingImport);
    pendingImportPreview = preview;
    elements.importExportedAt.textContent = preview.backup.exportedAt
      ? formatDate(preview.backup.exportedAt)
      : "Not recorded";
    elements.importExportedAt.title = preview.backup.exportedAt || "";
    elements.importSchemaVersion.textContent = preview.backup.schemaVersion === null
      ? "Not recorded"
      : numberFormatter.format(preview.backup.schemaVersion);
    elements.importMessage.textContent = `This backup contains ${numberFormatter.format(preview.backup.notes)} active ${noteWord(preview.backup.notes)} and ${numberFormatter.format(preview.backup.trash)} ${trashWord(preview.backup.trash)}.`;
    const skipMessage = preview.merge.skipped === 0
      ? "No entries will be skipped."
      : `${numberFormatter.format(preview.merge.skipped)} ${preview.merge.skipped === 1 ? "entry" : "entries"} already present will be skipped.`;
    const rekeyMessage = preview.merge.rekeyed === 0
      ? "No note IDs need to change."
      : `${numberFormatter.format(preview.merge.rekeyed)} colliding note ${preview.merge.rekeyed === 1 ? "ID" : "IDs"} will be changed.`;
    elements.mergePreviewMessage.textContent = `Merge will add ${numberFormatter.format(preview.merge.added)} active ${noteWord(preview.merge.added)} and ${numberFormatter.format(preview.merge.trashAdded)} ${trashWord(preview.merge.trashAdded)}. ${skipMessage} ${rekeyMessage} The result will have ${numberFormatter.format(preview.merge.resultingNotes)} active ${noteWord(preview.merge.resultingNotes)} and ${numberFormatter.format(preview.merge.resultingTrash)} ${trashWord(preview.merge.resultingTrash)}.`;
    elements.replacePreviewMessage.textContent = `Replace will remove ${numberFormatter.format(preview.replace.removedNotes)} current active ${noteWord(preview.replace.removedNotes)} and ${numberFormatter.format(preview.replace.removedTrash)} current ${trashWord(preview.replace.removedTrash)}. The result will have ${numberFormatter.format(preview.replace.resultingNotes)} active ${noteWord(preview.replace.resultingNotes)} and ${numberFormatter.format(preview.replace.resultingTrash)} ${trashWord(preview.replace.resultingTrash)}.`;
    const displaySettingsChanged =
      preview.replace.currentSettings.theme !== preview.replace.settings.theme ||
      preview.replace.currentSettings.sort !== preview.replace.settings.sort;
    const displaySettingsMessage = displaySettingsChanged
      ? `Replace will change the theme from ${themeLabel(preview.replace.currentSettings.theme)} to ${themeLabel(preview.replace.settings.theme)} and sorting from ${sortLabel(preview.replace.currentSettings.sort)} to ${sortLabel(preview.replace.settings.sort)}.`
      : `Replace will keep the ${themeLabel(preview.replace.settings.theme)} theme and ${sortLabel(preview.replace.settings.sort)} sorting.`;
    const sourceSettingChanged =
      preview.replace.currentSettings.includeSourceOnShare !==
      preview.replace.settings.includeSourceOnShare;
    const sourceAction = preview.replace.settings.includeSourceOnShare ? "include" : "exclude";
    const sourceSettingsMessage = sourceSettingChanged
      ? `Copied notes and Markdown will change to ${sourceAction} source details.`
      : `Copied notes and Markdown will continue to ${sourceAction} source details.`;
    elements.replaceSettingsMessage.textContent = `${displaySettingsMessage} ${sourceSettingsMessage}`;
    if (elements.replaceDialog.open) {
      renderReplaceConfirmation(preview);
    }

    let mergeIssue = "";
    if (!preview.merge.withinCountLimits) {
      mergeIssue = "Merge is unavailable because the result would exceed a note-count limit. Replace is still available.";
    } else {
      try {
        assertStateFits(mergeImportedBackup(state, pendingImport).state);
      } catch (error) {
        mergeIssue = `${errorMessage(error)} Replace is still available.`;
      }
    }
    elements.mergeImport.disabled = Boolean(mergeIssue);
    setStatus(elements.mergePreviewWarning, mergeIssue, mergeIssue ? "warning" : "info");
  }

  async function readImportFile(file) {
    if (!file || !state) {
      return;
    }
    const generation = importReadGeneration + 1;
    importReadGeneration = generation;
    const expectedEpoch = dataEpoch;
    if (file.size > LIMITS.importBytes) {
      setStatus(elements.status, "The backup file is too large.", "error");
      elements.importFile.value = "";
      return;
    }

    try {
      const contents = await file.text();
      if (
        destroyed ||
        generation !== importReadGeneration ||
        expectedEpoch !== dataEpoch ||
        dataResetConflict ||
        resetOutcomeUnknown
      ) {
        return;
      }
      await assertCurrentDataEpoch();
      if (generation !== importReadGeneration || expectedEpoch !== dataEpoch) {
        return;
      }
      const parsed = parseBackup(contents);
      assertStateFits(replaceImportedNotes(state, parsed));
      pendingImport = parsed;
      pendingReplaceStateSnapshot = null;
      renderImportPreview();
      setStatus(elements.importStatus, "", "info");
      showDialog(elements.importDialog);
      elements.cancelImport.focus();
    } catch (error) {
      if (generation !== importReadGeneration || expectedEpoch !== dataEpoch) {
        return;
      }
      pendingImport = null;
      pendingImportPreview = null;
      pendingReplaceStateSnapshot = null;
      reportActionError(error);
    } finally {
      if (generation === importReadGeneration) {
        elements.importFile.value = "";
      }
    }
  }

  async function mergeImport() {
    if (!pendingImport) {
      return;
    }
    renderImportPreview();
    if (elements.mergeImport.disabled) {
      return;
    }
    const importValue = pendingImport;
    elements.cancelImport.disabled = true;
    elements.mergeImport.disabled = true;
    elements.replaceImport.disabled = true;
    try {
      const result = await mutateState(
        (current) => mergeImportedBackup(current, importValue),
        storage,
        expectedEpochOptions(),
      );
      state = result.state;
      pendingImport = null;
      pendingImportPreview = null;
      pendingReplaceStateSnapshot = null;
      closeDialog(elements.importDialog);
      render();
      setStatus(
        elements.status,
        `Restored ${numberFormatter.format(result.added)} active ${noteWord(result.added)} and ${numberFormatter.format(result.trashAdded)} ${result.trashAdded === 1 ? "Trash entry" : "Trash entries"}. Skipped ${numberFormatter.format(result.skipped)} ${result.skipped === 1 ? "note" : "notes"} already present.`,
        "success",
      );
    } catch (error) {
      reportActionError(error, elements.importStatus);
      timerApi.setTimeout(() => elements.mergeImport.focus(), 0);
    } finally {
      elements.cancelImport.disabled = false;
      elements.replaceImport.disabled = false;
      if (pendingImport) {
        renderImportPreview();
      } else {
        elements.mergeImport.disabled = false;
      }
    }
  }

  async function replaceImport() {
    if (!pendingImport || pendingReplaceStateSnapshot === null) {
      return;
    }
    const importValue = pendingImport;
    const confirmedStateSnapshot = pendingReplaceStateSnapshot;
    replaceInFlight = true;
    elements.cancelReplace.disabled = true;
    elements.confirmReplace.disabled = true;
    try {
      state = await mutateState(
        (current) => {
          if (JSON.stringify(current) !== confirmedStateSnapshot) {
            throw new ValidationError(
              "The library changed after this replacement was confirmed.",
              "replace-conflict",
            );
          }
          return replaceImportedNotes(current, importValue);
        },
        storage,
        expectedEpochOptions(),
      );
      hideUndo();
      pendingImport = null;
      pendingImportPreview = null;
      pendingReplaceStateSnapshot = null;
      closeDialog(elements.replaceDialog);
      applyTheme(state.settings.theme, documentValue);
      render();
      setStatus(
        elements.status,
        `Library replaced with ${numberFormatter.format(state.notes.length)} active ${noteWord(state.notes.length)} and ${numberFormatter.format(state.trash.length)} ${state.trash.length === 1 ? "Trash entry" : "Trash entries"}.`,
        "success",
      );
    } catch (error) {
      if (isDataResetError(error)) {
        markDataResetConflict(elements.replaceStatus);
      } else if (error instanceof ValidationError && error.code === "replace-conflict") {
        try {
          state = await readStateForPage();
          applyTheme(state.settings.theme, documentValue);
          render();
          replaceInFlight = false;
          reopenImportPreview(
            "The library changed in another window. Review the updated restore preview before replacing it.",
          );
        } catch (readError) {
          reportActionError(readError, elements.replaceStatus);
        }
      } else {
        setStatus(elements.replaceStatus, errorMessage(error), "error");
        timerApi.setTimeout(() => elements.confirmReplace.focus(), 0);
      }
    } finally {
      replaceInFlight = false;
      elements.cancelReplace.disabled = false;
      elements.confirmReplace.disabled = false;
    }
  }

  async function changeSettings(changes) {
    if (!state) {
      return;
    }
    try {
      state = await mutateState(
        (current) => updateSettings(current, changes),
        storage,
        expectedEpochOptions(),
      );
      applyTheme(state.settings.theme, documentValue);
      render();
    } catch (error) {
      reportActionError(error);
      if (state) {
        elements.sort.value = state.settings.sort;
        elements.theme.value = state.settings.theme;
        elements.includeSourceOnShare.checked = state.settings.includeSourceOnShare;
      }
    }
  }

  async function acknowledgeRecoveryNotice() {
    if (!recoveryInfo.rejectedNotes && !recoveryInfo.rejectedDrafts) {
      return;
    }
    elements.acknowledgeRecovery.disabled = true;
    setStatus(elements.recoveryStatus, "", "info");
    try {
      const result = await acknowledgeRecovery(
        recoveryInfo,
        storage,
        expectedEpochOptions(),
      );
      recoveryInfo = result.recovery;
      renderRecoveryNotice();
      if (result.acknowledged) {
        setStatus(elements.status, "Recovery notice acknowledged.", "success");
      } else {
        setStatus(
          elements.recoveryStatus,
          "More recovery information arrived from another window. Review the updated counts before acknowledging it.",
          "warning",
        );
        elements.acknowledgeRecovery.focus();
      }
    } catch (error) {
      reportActionError(error, elements.recoveryStatus);
      elements.acknowledgeRecovery.disabled = false;
    }
  }

  setLibraryAvailable(false);
  elements.resumeEditorDraft.addEventListener("click", () => void resumeEditorDraft());
  elements.discardEditorDraft.addEventListener("click", () => void discardRecoveredEditorDraft());
  elements.acknowledgeRecovery.addEventListener("click", () => void acknowledgeRecoveryNotice());
  elements.newNote.addEventListener("click", (event) => openEditor(null, event.currentTarget));
  elements.emptyNewNote.addEventListener("click", (event) =>
    openEditor(null, event.currentTarget),
  );
  elements.selectionMode.addEventListener("click", (event) => {
    if (selectionMode) {
      finishSelection(selectionReturnFocus || event.currentTarget);
      return;
    }
    selectionMode = true;
    selectionReturnFocus = event.currentTarget;
    selectedIds.clear();
    render();
    const firstCheckbox = elements.list.querySelector(".note-select-checkbox");
    (firstCheckbox || elements.selectAllFiltered).focus();
  });
  elements.selectAllFiltered.addEventListener("click", () => {
    for (const note of selectedNotes()) {
      selectedIds.add(note.id);
    }
    updateSelectionControls();
    elements.clearSelection.focus();
  });
  elements.clearSelection.addEventListener("click", () => {
    selectedIds.clear();
    updateSelectionControls();
    elements.selectAllFiltered.focus();
  });
  elements.cancelSelection.addEventListener("click", () =>
    finishSelection(selectionReturnFocus || elements.selectionMode),
  );
  elements.bulkCourse.addEventListener("click", openBulkCourseDialog);
  elements.bulkExport.addEventListener("click", exportBulkSelection);
  elements.bulkTrash.addEventListener("click", () => openBulkConfirmation("move"));
  elements.bulkRestore.addEventListener("click", () => void restoreBulkSelection());
  elements.bulkPermanentDelete.addEventListener("click", () =>
    openBulkConfirmation("permanent-delete"),
  );
  elements.clearLocalData.addEventListener("click", (event) =>
    openResetDialog(event.currentTarget),
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
  function changeView(nextView) {
    if (viewMode === nextView) {
      return;
    }
    selectionMode = false;
    selectedIds.clear();
    selectionReturnFocus = null;
    viewMode = nextView;
    elements.search.value = "";
    elements.course.value = "";
    courseSignature = "";
    visibleLimit = DISPLAY_BATCH;
    render();
  }
  elements.notesView.addEventListener("click", () => changeView("notes"));
  elements.trashView.addEventListener("click", () => changeView("trash"));
  elements.emptyTrash.addEventListener("click", openEmptyTrash);
  elements.sort.addEventListener("change", () => void changeSettings({ sort: elements.sort.value }));
  elements.theme.addEventListener("change", () => void changeSettings({ theme: elements.theme.value }));
  elements.includeSourceOnShare.addEventListener("change", () =>
    void changeSettings({ includeSourceOnShare: elements.includeSourceOnShare.checked }),
  );
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
    const focusTarget = selectionMode ? ".note-select-checkbox" : "[data-action='view']";
    firstNewCard?.querySelector(focusTarget)?.focus();
  });
  elements.list.addEventListener("click", (event) => {
    const button = event.target.closest?.("button[data-action]");
    const card = event.target.closest?.("[data-note-id]");
    const note = viewMode === "trash"
      ? state?.trash.find((entry) => entry.note.id === card?.dataset.noteId)?.note
      : state?.notes.find((candidate) => candidate.id === card?.dataset.noteId);
    if (
      !note ||
      event.target.closest?.(".note-selection") ||
      (!button && event.target.closest?.("a"))
    ) {
      return;
    }
    if (!button || button.dataset.action === "view") {
      openDetail(note, button || event.target);
    } else if (button.dataset.action === "edit") {
      openEditor(note, button);
    } else if (button.dataset.action === "delete") {
      openDelete(note, button);
    } else if (button.dataset.action === "copy") {
      void copyNote(note, button);
    } else if (button.dataset.action === "restore") {
      const entry = state.trash.find((candidate) => candidate.note.id === note.id);
      if (entry) {
        void restoreFromTrash(entry, button);
      }
    } else if (button.dataset.action === "permanent-delete") {
      const entry = state.trash.find((candidate) => candidate.note.id === note.id);
      if (entry) {
        openPermanentDelete(entry, button);
      }
    }
  });
  elements.list.addEventListener("change", (event) => {
    const checkbox = event.target.closest?.(".note-select-checkbox");
    const card = checkbox?.closest?.("[data-note-id]");
    if (!selectionMode || !checkbox || !card) {
      return;
    }
    if (checkbox.checked) {
      selectedIds.add(card.dataset.noteId);
    } else {
      selectedIds.delete(card.dataset.noteId);
    }
    updateSelectionControls();
  });

  elements.closeDetail.addEventListener("click", () => closeDialog(elements.detailDialog));
  elements.detailDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog(elements.detailDialog);
  });
  elements.detailDialog.addEventListener("close", () => {
    detailNoteId = null;
    detailReturnFocus?.focus?.();
    detailReturnFocus = null;
  });
  elements.detailCopy.addEventListener("click", () => {
    const record = findNoteRecord(detailNoteId);
    if (record) {
      void copyNote(record.note, elements.detailCopy, elements.detailStatus);
    }
  });
  elements.detailEdit.addEventListener("click", () => {
    const record = findNoteRecord(detailNoteId);
    if (!record || record.trashEntry) {
      return;
    }
    const trigger = closeDetailForAction();
    openEditor(record.note, trigger);
  });
  elements.detailDelete.addEventListener("click", () => {
    const record = findNoteRecord(detailNoteId);
    if (!record || record.trashEntry) {
      return;
    }
    const trigger = closeDetailForAction();
    openDelete(record.note, trigger);
  });
  elements.detailRestore.addEventListener("click", () => {
    const record = findNoteRecord(detailNoteId);
    if (!record?.trashEntry) {
      return;
    }
    const trigger = closeDetailForAction();
    void restoreFromTrash(record.trashEntry, trigger);
  });
  elements.detailPermanentDelete.addEventListener("click", () => {
    const record = findNoteRecord(detailNoteId);
    if (!record?.trashEntry) {
      return;
    }
    const trigger = closeDetailForAction();
    openPermanentDelete(record.trashEntry, trigger);
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
    if (elements.editorForm.inert || elements.editorForm.getAttribute("aria-busy") === "true") {
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

  elements.permanentDeleteForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void permanentlyDeleteNote();
  });
  elements.cancelPermanentDelete.addEventListener("click", () => closeDialog(elements.permanentDeleteDialog));
  elements.permanentDeleteDialog.addEventListener("close", () => {
    permanentDeleteReturnFocus?.focus?.();
    permanentDeleteReturnFocus = null;
    pendingPermanentDelete = null;
  });
  elements.permanentDeleteDialog.addEventListener("cancel", (event) => {
    if (elements.confirmPermanentDelete.disabled) {
      event.preventDefault();
    }
  });

  elements.emptyTrashForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void deleteAllTrash();
  });
  elements.cancelEmptyTrash.addEventListener("click", () => closeDialog(elements.emptyTrashDialog));
  elements.emptyTrashDialog.addEventListener("close", () => {
    emptyTrashSnapshot = null;
    elements.emptyTrash.focus();
  });
  elements.emptyTrashDialog.addEventListener("cancel", (event) => {
    if (elements.confirmEmptyTrash.disabled) {
      event.preventDefault();
    }
  });

  elements.bulkCourseForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const course = elements.bulkCourseInput.value.trim();
    if (!course) {
      setStatus(
        elements.bulkCourseStatus,
        "Enter a course, or choose Clear course.",
        "warning",
      );
      elements.bulkCourseInput.focus();
      return;
    }
    void applyBulkCourse(course);
  });
  elements.clearBulkCourse.addEventListener("click", () => void applyBulkCourse(""));
  elements.cancelBulkCourse.addEventListener("click", () => closeDialog(elements.bulkCourseDialog));
  elements.bulkCourseDialog.addEventListener("close", () => {
    pendingBulkCourse = null;
    if (selectionMode) {
      elements.bulkCourse.focus();
    }
  });
  elements.bulkCourseDialog.addEventListener("cancel", (event) => {
    if (elements.applyBulkCourse.disabled) {
      event.preventDefault();
    }
  });

  elements.bulkConfirmForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void confirmBulkAction();
  });
  elements.cancelBulkConfirm.addEventListener("click", () => closeDialog(elements.bulkConfirmDialog));
  elements.bulkConfirmDialog.addEventListener("close", () => {
    const action = pendingBulkAction?.kind;
    pendingBulkAction = null;
    if (selectionMode) {
      (action === "permanent-delete" ? elements.bulkPermanentDelete : elements.bulkTrash).focus();
    }
  });
  elements.bulkConfirmDialog.addEventListener("cancel", (event) => {
    if (elements.confirmBulkAction.disabled) {
      event.preventDefault();
    }
  });

  elements.resetConfirmation.addEventListener("input", updateResetControls);
  elements.resetExport.addEventListener("click", async () => {
    if (resetInFlight || resetExportInFlight) {
      return;
    }
    const reviewedState = resetSnapshot?.state || null;
    resetExportInFlight = true;
    updateResetControls();
    try {
      const exported = await exportJson(elements.resetStatus);
      if (exported) {
        const reviewChanged = reviewedState !== null && resetSnapshot?.state !== reviewedState;
        setStatus(
          elements.resetStatus,
          reviewChanged
            ? "Backup exported from the latest saved data. Review the updated counts and type DELETE again."
            : "Backup exported. The downloaded file remains available after local data is cleared.",
          reviewChanged ? "warning" : "success",
        );
      } else if (dataResetConflict) {
        resetReturnFocus = null;
        closeDialog(elements.resetDialog);
        elements.retryLoad.focus();
      }
    } finally {
      resetExportInFlight = false;
      if (elements.resetDialog.open) {
        updateResetControls();
      }
    }
  });
  elements.resetForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void confirmDataReset();
  });
  elements.cancelReset.addEventListener("click", () => closeDialog(elements.resetDialog));
  elements.resetDialog.addEventListener("cancel", (event) => {
    if (resetInFlight || resetExportInFlight) {
      event.preventDefault();
    }
  });
  elements.resetDialog.addEventListener("close", () => {
    resetSnapshot = null;
    elements.resetConfirmation.value = "";
    setStatus(elements.resetStatus, "", "info");
    const target = resetReturnFocus;
    resetReturnFocus = null;
    target?.focus?.();
  });

  elements.exportJson.addEventListener("click", () => void exportJson());
  elements.exportMarkdown.addEventListener("click", () => void exportMarkdown());
  elements.importButton.addEventListener("click", () => elements.importFile.click());
  elements.importFile.addEventListener("change", () => void readImportFile(elements.importFile.files[0]));
  elements.cancelImport.addEventListener("click", () => {
    pendingImport = null;
    pendingImportPreview = null;
    pendingReplaceStateSnapshot = null;
    closeDialog(elements.importDialog);
  });
  elements.importDialog.addEventListener("cancel", (event) => {
    if (elements.cancelImport.disabled) {
      event.preventDefault();
      return;
    }
    pendingImport = null;
    pendingImportPreview = null;
    pendingReplaceStateSnapshot = null;
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
    renderImportPreview();
    const preview = pendingImportPreview;
    if (!preview) {
      return;
    }
    pendingReplaceStateSnapshot = JSON.stringify(state);
    closeDialog(elements.importDialog);
    renderReplaceConfirmation(preview);
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
    pendingImportPreview = null;
    pendingReplaceStateSnapshot = null;
    closeDialog(elements.replaceDialog);
  });
  elements.replaceDialog.addEventListener("cancel", (event) => {
    if (elements.confirmReplace.disabled) {
      event.preventDefault();
      return;
    }
    pendingImport = null;
    pendingImportPreview = null;
    pendingReplaceStateSnapshot = null;
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
      expectedEpoch: dataEpoch,
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
            if (typeof response?.code === "string") {
              throw new ValidationError(response?.error || "Draft handoff failed.", response.code);
            }
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
        .catch((error) => {
          if (isDataResetError(error)) {
            markDataResetConflict();
            return undefined;
          }
          return saveDirectly();
        })
        .catch((error) => {
          if (isDataResetError(error)) {
            markDataResetConflict();
          }
        });
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
    const checkbox = documentValue.activeElement?.closest?.(".note-select-checkbox");
    const selectionCard = checkbox?.closest?.("[data-note-id]");
    if (checkbox && selectionCard) {
      return { noteId: selectionCard.dataset.noteId, action: "select" };
    }
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
    const selector = target.action === "select"
      ? ".note-select-checkbox"
      : `[data-action='${target.action}']`;
    card?.querySelector(selector)?.focus();
  }

  const storageChangeHandler = async (changes, areaName) => {
    const stateChanged = Boolean(changes[STORAGE_KEYS.state]);
    const editorDraftChanged = Boolean(changes[STORAGE_KEYS.editorDraft]);
    const recoveryChanged = Boolean(changes[STORAGE_KEYS.recovery]);
    const dataEpochChanged = Boolean(changes[STORAGE_KEYS.dataEpoch]);
    const storageUsageChanged = Object.keys(changes).some((key) =>
      Object.values(STORAGE_KEYS).includes(key),
    );
    if (destroyed || areaName !== "local") {
      return;
    }
    if (resetInFlight) {
      resetEventsSuppressed = true;
      return;
    }
    if (
      dataEpochChanged &&
      dataEpoch &&
      changes[STORAGE_KEYS.dataEpoch].newValue !== dataEpoch
    ) {
      const resetDialogWasOpen = elements.resetDialog.open;
      if (resetDialogWasOpen) {
        resetReturnFocus = null;
        closeDialog(elements.resetDialog);
      }
      markDataResetConflict();
      if (resetDialogWasOpen) {
        elements.retryLoad.focus();
      }
      return;
    }
    if (dataResetConflict) {
      return;
    }
    if (storageUsageChanged) {
      void refreshStorageUsage();
    }
    if (!stateChanged && !editorDraftChanged && !recoveryChanged && !dataEpochChanged) {
      return;
    }
    try {
      if (stateChanged) {
        const focusTarget = focusedCardAction();
        const nextState = await readStateForPage();
        if (undoRecord && JSON.stringify(nextState) !== undoRecord.stateSnapshot) {
          hideUndo();
        }
        state = nextState;
        applyTheme(state.settings.theme, documentValue);
        render();
        if (pendingImport) {
          renderImportPreview();
          if (
            elements.replaceDialog.open &&
            !replaceInFlight &&
            pendingReplaceStateSnapshot !== null &&
            JSON.stringify(state) !== pendingReplaceStateSnapshot
          ) {
            reopenImportPreview(
              "The library changed in another window. Review the updated restore preview before replacing it.",
            );
          }
        }
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
        const record = await readEditorDraftForPage();
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

      if (recoveryChanged) {
        recoveryInfo = await readRecoveryForPage();
        renderRecoveryNotice();
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
      } else if (isDataResetError(error)) {
        markDataResetConflict();
      } else {
        setStatus(elements.status, errorMessage(error), "error");
      }
    }
  };
  chromeApi.storage.onChanged?.addListener(storageChangeHandler);

  async function loadLibrary() {
    setLibraryAvailable(false);
    elements.retryLoad.hidden = true;
    elements.retryLoad.textContent = "Retry";
    elements.summary.textContent = "Loading notes...";
    setStatus(elements.status, "", "info");
    try {
      if (!dataEpoch) {
        dataEpoch = await loadDataEpoch(storage);
      }
      state = await readStateForPage();
      if (dataResetConflict) {
        markDataResetConflict();
        return;
      }
      try {
        editorDraftRecord = await readEditorDraftForPage();
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
      if (dataResetConflict) {
        markDataResetConflict();
        return;
      }
      externalEditorDraftRecord = null;
      applyTheme(state.settings.theme, documentValue);
      elements.sort.value = state.settings.sort;
      elements.theme.value = state.settings.theme;
      visibleLimit = DISPLAY_BATCH;
      render();
      renderEditorDraftRecovery();
      setLibraryAvailable(true);
      recoveryInfo = await readRecoveryForPage();
      renderRecoveryNotice();
      if (editorDraftUnavailable) {
        setStatus(
          elements.status,
          "An unfinished draft was saved by a newer extension version. Update the extension before editing notes.",
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
      if (isDataResetError(error)) {
        markDataResetConflict();
      } else {
        state = undefined;
        setLibraryAvailable(false);
        setStatus(elements.status, `Notes could not be loaded: ${errorMessage(error)}`, "error");
        elements.summary.textContent = "Library unavailable";
        elements.retryLoad.hidden = false;
      }
    }
  }
  elements.retryLoad.addEventListener("click", () => {
    if (dataResetConflict || resetOutcomeUnknown) {
      documentValue.defaultView?.location.reload();
      return;
    }
    void loadLibrary();
  });
  await loadLibrary();

  return {
    getState: () => state,
    getEditorDraftRecord: () => editorDraftRecord,
    flushEditorDraft,
    render,
    openEditor,
    destroy() {
      destroyed = true;
      storageUsageRequestGeneration += 1;
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
