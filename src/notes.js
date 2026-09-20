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
import { listCourses, selectNotes } from "./selectors.js";
import {
  assertStateFits,
  loadRecoveryInfo,
  loadState,
  mutateState,
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
    editorSourceTitle: requiredElement(documentValue, "editorSourceTitle"),
    editorSourceUrl: requiredElement(documentValue, "editorSourceUrl"),
    editorDuplicate: requiredElement(documentValue, "editorDuplicateNotice"),
    editorSaveDuplicate: requiredElement(documentValue, "editorSaveDuplicateButton"),
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
} = {}) {
  const elements = libraryElements(documentValue);
  const storage = chromeApi.storage.local;
  const numberFormatter = new Intl.NumberFormat(documentValue.documentElement.lang || undefined);
  let state;
  let editingId = null;
  let editingSnapshot = null;
  let editorInitialInput = "";
  let editorDirty = false;
  let editorReturnFocus = null;
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
  }

  function updateEditorCount() {
    elements.editorBodyCount.textContent = `${numberFormatter.format(elements.editorBody.value.length)} / ${numberFormatter.format(LIMITS.body)}`;
  }

  function setEditorBusy(busy) {
    elements.editorForm.setAttribute("aria-busy", String(busy));
    elements.editorForm.inert = busy;
    elements.saveEditor.disabled = busy;
    elements.cancelEditor.disabled = busy;
    elements.closeEditor.disabled = busy;
    elements.editorSaveDuplicate.disabled = busy;
  }

  function openEditor(note = null, trigger = null) {
    if (!ready) {
      return;
    }
    editingId = note?.id || null;
    editingSnapshot = note ? JSON.stringify(note) : null;
    editorReturnFocus = trigger || documentValue.activeElement;
    elements.editorHeading.textContent = note ? "Edit note" : "New note";
    elements.editorTitle.value = note?.title || "";
    elements.editorCourse.value = note?.course || "";
    elements.editorBody.value = note?.body || "";
    elements.editorSourceTitle.value = note?.source.title || "";
    elements.editorSourceUrl.value = note?.source.url || "";
    elements.editorDuplicate.hidden = true;
    elements.editorBody.removeAttribute("aria-invalid");
    elements.editorSourceUrl.removeAttribute("aria-invalid");
    setStatus(elements.editorStatus, "", "info");
    updateEditorCount();
    editorInitialInput = JSON.stringify(editorInput());
    editorDirty = false;
    showDialog(elements.editorDialog);
    elements.editorTitle.focus();
  }

  function finishCloseEditor() {
    editorDirty = false;
    closeDialog(elements.editorDialog);
  }

  function requestCloseEditor() {
    if (
      editorDirty &&
      documentValue.defaultView?.confirm("Discard the unsaved changes to this note?") !== true
    ) {
      return;
    }
    finishCloseEditor();
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

  async function saveEditor(allowDuplicate = false) {
    if (elements.saveEditor.disabled) {
      return;
    }
    const editingIdentifier = editingId;
    const originalSnapshot = editingSnapshot;
    const input = editorInput();
    let focusTarget = null;
    elements.editorDuplicate.hidden = true;
    elements.editorBody.removeAttribute("aria-invalid");
    elements.editorSourceUrl.removeAttribute("aria-invalid");
    setEditorBusy(true);
    try {
      const result = await mutateState(
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
      );
      state = result.state;
      const savedId = result.note.id;
      editorDirty = false;
      finishCloseEditor();
      render();
      setStatus(elements.status, "Note saved.", "success");
      [...elements.list.querySelectorAll("[data-note-id]")]
        .find((card) => card.dataset.noteId === savedId)
        ?.querySelector("[data-action='edit']")
        ?.focus();
    } catch (error) {
      if (error instanceof ValidationError && error.code === "duplicate") {
        elements.editorDuplicate.hidden = false;
        setStatus(elements.editorStatus, "Review the duplicate warning before saving.", "warning");
        timerApi.setTimeout(() => elements.editorSaveDuplicate.focus(), 0);
      } else {
        if (error instanceof ValidationError && error.code === "body-required") {
          elements.editorBody.setAttribute("aria-invalid", "true");
          focusTarget = elements.editorBody;
        }
        if (error instanceof ValidationError && error.code.startsWith("source-url")) {
          elements.editorSourceUrl.setAttribute("aria-invalid", "true");
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
    updateEditorCount();
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
  elements.cancelEditor.addEventListener("click", requestCloseEditor);
  elements.closeEditor.addEventListener("click", requestCloseEditor);
  elements.editorDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (elements.saveEditor.disabled) {
      return;
    }
    requestCloseEditor();
  });
  elements.editorDialog.addEventListener("close", () => {
    editorReturnFocus?.focus?.();
    editorReturnFocus = null;
    editingId = null;
    editingSnapshot = null;
    editorInitialInput = "";
    editorDirty = false;
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
    if (editorDirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  documentValue.defaultView?.addEventListener("beforeunload", beforeUnloadHandler);

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
    if (destroyed || areaName !== "local" || !changes[STORAGE_KEYS.state]) {
      return;
    }
    try {
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
        setStatus(elements.editorStatus, "The library changed in another window. Your form was not replaced.", "warning");
      }
    } catch (error) {
      setStatus(elements.status, errorMessage(error), "error");
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
      applyTheme(state.settings.theme, documentValue);
      elements.sort.value = state.settings.sort;
      elements.theme.value = state.settings.theme;
      visibleLimit = DISPLAY_BATCH;
      render();
      setLibraryAvailable(true);
      const recovery = await loadRecoveryInfo(storage);
      if (recovery.rejectedNotes || recovery.rejectedDrafts) {
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
    render,
    openEditor,
    destroy() {
      destroyed = true;
      if (searchTimer !== null) {
        timerApi.clearTimeout(searchTimer);
      }
      chromeApi.storage.onChanged?.removeListener(storageChangeHandler);
      documentValue.removeEventListener("keydown", keyHandler);
      documentValue.defaultView?.removeEventListener("beforeunload", beforeUnloadHandler);
    },
  };
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  void initLibrary();
}
