import assert from "node:assert/strict";
import test from "node:test";

import {
  addNote,
  assignCourseToNotes,
  createEmptyState,
  createNote,
  emptyTrash,
  LIMITS,
  measureLibraryUsage,
  moveNoteToTrash,
  moveNotesToTrash,
  normalizeDraft,
  normalizeEditorDraft,
  normalizeNote,
  normalizeSource,
  normalizeState,
  permanentlyDeleteTrashedNote,
  permanentlyDeleteTrashedNotes,
  recoverState,
  renameCourse,
  restoreTrashedNote,
  restoreTrashedNotes,
  safeTextPrefix,
  updateSettings,
  updateNote,
  ValidationError,
} from "../src/model.js";
import {
  createBackup,
  mergeImportedBackup,
  mergeImportedNotes,
  notesToMarkdown,
  parseBackup,
  previewImportedBackup,
  replaceImportedNotes,
  serializeBackup,
} from "../src/backup.js";
import { listCourses, selectNotes } from "../src/selectors.js";

const START = "2026-09-20T10:00:00.000Z";
const LATER = "2026-09-20T11:00:00.000Z";

function identifiers(...values) {
  let index = 0;
  return () => values[index++] || `generated-${index}`;
}

function sample(overrides = {}) {
  return {
    title: "Week 1",
    body: "Graph theory notes",
    course: "CS 101",
    source: { title: "Lecture page", url: "https://example.com/lecture" },
    ...overrides,
  };
}

test("creates a normalized note with stable timestamps", () => {
  const note = createNote(sample(), { idFactory: () => "note-1", now: START });

  assert.deepEqual(note, {
    id: "note-1",
    title: "Week 1",
    body: "Graph theory notes",
    course: "CS 101",
    source: { title: "Lecture page", url: "https://example.com/lecture" },
    createdAt: START,
    updatedAt: START,
  });
});

test("preserves Persian, emoji, formulas, and line breaks", () => {
  const body = "تعریف گراف\nG = (V, E)\nیادداشت 🎓";
  const note = createNote(sample({ title: "نظریه گراف", body }), {
    idFactory: () => "note-rtl",
    now: START,
  });

  assert.equal(note.title, "نظریه گراف");
  assert.equal(note.body, body);
});

test("keeps truncated and imported text well formed", () => {
  const fallback = `${"x".repeat(LIMITS.title - 1)}🎓 after`;
  const note = createNote(sample({ title: "", body: fallback }), {
    idFactory: () => "note-title-boundary",
    now: START,
  });
  const imported = normalizeNote(
    sample({
      title: "Safe\ud83cTitle\udc00",
      source: { title: "Lecture\ud83cPage\udc00", url: "https://example.com" },
    }),
    { idFactory: () => "note-imported-title", now: START },
  );

  assert.equal(note.title, "x".repeat(LIMITS.title - 1));
  assert.equal(note.title.isWellFormed(), true);
  assert.equal(imported.title, "SafeTitle");
  assert.equal(imported.source.title, "LecturePage");
  assert.equal(imported.title.isWellFormed(), true);
  assert.equal(imported.source.title.isWellFormed(), true);
  assert.equal(safeTextPrefix("a🎓b", 2), "a");
});

test("rejects empty and oversized note text", () => {
  assert.throws(
    () => createNote(sample({ body: "   " }), { idFactory: () => "empty", now: START }),
    (error) => error instanceof ValidationError && error.code === "body-required",
  );
  assert.throws(
    () =>
      createNote(sample({ body: "x".repeat(LIMITS.body + 1) }), {
        idFactory: () => "large",
        now: START,
      }),
    (error) => error instanceof ValidationError && error.code === "body-length",
  );
});

test("keeps only safe source protocols", () => {
  assert.deepEqual(normalizeSource({ title: "Safe", url: "https://example.com/a" }), {
    title: "Safe",
    url: "https://example.com/a",
  });
  assert.deepEqual(normalizeSource({ title: "Unsafe", url: "javascript:alert(1)" }), {
    title: "Unsafe",
    url: "",
  });
  assert.deepEqual(
    normalizeSource({
      title: "Private",
      url: "https://student:secret@example.com/lecture?token=value#answer",
    }),
    { title: "Private", url: "https://example.com/lecture" },
  );
  assert.equal(normalizeSource({ url: `https://example.com/${"🎓".repeat(1_000)}` }).url, "");
});

test("strips display controls from single-line fields", () => {
  const note = normalizeNote(
    sample({ title: "Safe\u202Etxt.exe", course: "CS\u0000 101" }),
    { idFactory: () => "note-control", now: START },
  );

  assert.equal(note.title, "Safetxt.exe");
  assert.equal(note.course, "CS 101");
});

test("adds, edits, moves, and restores a note from Trash", () => {
  const added = addNote(createEmptyState(), sample(), {
    idFactory: () => "note-1",
    now: START,
  });
  const updated = updateNote(added.state, "note-1", { body: "Updated content" }, { now: LATER });
  const removed = moveNoteToTrash(updated.state, "note-1", { now: LATER });
  const restored = restoreTrashedNote(removed.state, "note-1");

  assert.equal(added.state.revision, 1);
  assert.equal(updated.note.createdAt, START);
  assert.equal(updated.note.updatedAt, LATER);
  assert.equal(removed.state.notes.length, 0);
  assert.equal(removed.state.trash[0].deletedAt, LATER);
  assert.equal(removed.state.trash[0].originalIndex, 0);
  assert.deepEqual(restored.state.notes, [updated.note]);
  assert.deepEqual(restored.state.trash, []);
});

test("permanently deletes one Trash entry or empties Trash", () => {
  const first = addNote(createEmptyState(), sample({ body: "First" }), {
    idFactory: () => "first",
    now: START,
  }).state;
  const second = addNote(first, sample({ body: "Second" }), {
    idFactory: () => "second",
    now: START,
  }).state;
  const trashedFirst = moveNoteToTrash(second, "first", { now: LATER }).state;
  const trashedBoth = moveNoteToTrash(trashedFirst, "second", { now: LATER }).state;
  const deleted = permanentlyDeleteTrashedNote(trashedBoth, "first");

  assert.deepEqual(deleted.state.trash.map((entry) => entry.note.id), ["second"]);
  const emptied = emptyTrash(deleted.state);
  assert.equal(emptied.deleted, 1);
  assert.deepEqual(emptied.state.trash, []);
});

test("renames a course across active notes and Trash", () => {
  const first = createNote(sample({ title: "First", body: "First", course: "CS 101" }), {
    idFactory: () => "first",
    now: START,
  });
  const second = createNote(sample({ title: "Second", body: "Second", course: "Math" }), {
    idFactory: () => "second",
    now: START,
  });
  const deleted = createNote(sample({ title: "Deleted", body: "Deleted", course: "cs 101" }), {
    idFactory: () => "deleted",
    now: START,
  });
  const state = {
    ...createEmptyState(),
    revision: 7,
    notes: [first, second],
    trash: [{ note: deleted, deletedAt: START, originalIndex: 1 }],
  };

  const result = renameCourse(state, "  cS   101  ", " Data   Science ", { now: LATER });

  assert.equal(result.state.revision, 8);
  assert.equal(result.course, "cS 101");
  assert.equal(result.replacement, "Data Science");
  assert.equal(result.changed, 2);
  assert.equal(result.activeChanged, 1);
  assert.equal(result.trashChanged, 1);
  assert.deepEqual(result.state.notes.map((note) => note.id), ["first", "second"]);
  assert.deepEqual(result.notes.map((note) => note.id), ["first"]);
  assert.deepEqual(result.entries.map((entry) => entry.note.id), ["deleted"]);
  assert.equal(result.state.notes[0].course, "Data Science");
  assert.equal(result.state.notes[0].updatedAt, LATER);
  assert.equal(result.state.notes[1].course, "Math");
  assert.equal(result.state.notes[1].updatedAt, START);
  assert.equal(result.state.trash[0].note.course, "Data Science");
  assert.equal(result.state.trash[0].note.updatedAt, LATER);
  assert.equal(result.state.trash[0].deletedAt, START);
  assert.deepEqual(state.notes, [first, second]);
  assert.equal(state.trash[0].note.course, "cs 101");
});

test("merges course names and can clear the merged course", () => {
  const first = createNote(sample({ title: "First", body: "First", course: "CS 101" }), {
    idFactory: () => "first",
    now: START,
  });
  const second = createNote(sample({ title: "Second", body: "Second", course: "Math" }), {
    idFactory: () => "second",
    now: START,
  });
  const deleted = createNote(sample({ title: "Deleted", body: "Deleted", course: "cs 101" }), {
    idFactory: () => "deleted",
    now: START,
  });
  const state = {
    ...createEmptyState(),
    notes: [first, second],
    trash: [{ note: deleted, deletedAt: START, originalIndex: 1 }],
  };

  const merged = renameCourse(state, "CS 101", "Math", { now: LATER });
  const cleared = renameCourse(merged.state, "math", "", { now: LATER });

  assert.deepEqual(merged.state.notes.map((note) => note.course), ["Math", "Math"]);
  assert.equal(merged.state.trash[0].note.course, "Math");
  assert.equal(merged.changed, 2);
  assert.deepEqual(cleared.state.notes.map((note) => note.course), ["", ""]);
  assert.equal(cleared.state.trash[0].note.course, "");
  assert.equal(cleared.changed, 3);
  assert.equal(cleared.state.revision, state.revision + 2);
});

test("uses stored target spelling for course merges and permits case-only renames", () => {
  const source = createNote(sample({ title: "Source", body: "Source", course: "Physics" }), {
    idFactory: () => "source",
    now: START,
  });
  const target = createNote(sample({ title: "Target", body: "Target", course: "Data Science" }), {
    idFactory: () => "target",
    now: START,
  });
  const state = { ...createEmptyState(), notes: [source, target] };

  const merged = renameCourse(state, "Physics", "data science", { now: LATER });
  assert.equal(merged.replacement, "Data Science");
  assert.deepEqual(merged.state.notes.map((note) => note.course), ["Data Science", "Data Science"]);

  const renamed = renameCourse(merged.state, "data science", "DATA SCIENCE", { now: LATER });
  assert.equal(renamed.replacement, "DATA SCIENCE");
  assert.deepEqual(renamed.state.notes.map((note) => note.course), ["DATA SCIENCE", "DATA SCIENCE"]);
});

test("matches Persian course names with or without a zero-width non-joiner", () => {
  const stored = createNote(sample({ course: "روش‌های عددی" }), {
    idFactory: () => "persian-course",
    now: START,
  });
  const result = renameCourse(
    { ...createEmptyState(), notes: [stored] },
    "روشهای عددی",
    "محاسبات عددی",
    { now: LATER },
  );

  assert.equal(result.changed, 1);
  assert.equal(result.state.notes[0].course, "محاسبات عددی");
});

test("assigns a normalized course to selected active notes", () => {
  const first = createNote(sample({ title: "First", body: "First", course: "Physics" }), {
    idFactory: () => "first",
    now: START,
  });
  const second = createNote(sample({ title: "Second", body: "Second", course: "Math" }), {
    idFactory: () => "second",
    now: START,
  });
  const third = createNote(sample({ title: "Third", body: "Third", course: "CS" }), {
    idFactory: () => "third",
    now: START,
  });
  const state = { ...createEmptyState(), revision: 4, notes: [first, second, third] };

  const result = assignCourseToNotes(state, [" third ", "first"], " Physics ", { now: LATER });

  assert.equal(result.state.revision, 5);
  assert.equal(result.course, "Physics");
  assert.equal(result.assigned, 1);
  assert.equal(result.unchanged, 1);
  assert.deepEqual(result.notes.map((note) => note.id), ["first", "third"]);
  assert.deepEqual(result.changedNotes.map((note) => note.id), ["third"]);
  assert.deepEqual(result.state.notes.map((note) => note.id), ["first", "second", "third"]);
  assert.equal(result.state.notes[0].updatedAt, START);
  assert.equal(result.state.notes[1].course, "Math");
  assert.equal(result.state.notes[2].course, "Physics");
  assert.equal(result.state.notes[2].updatedAt, LATER);
});

test("uses one safe timestamp for each bulk record change", () => {
  const earlier = createNote(sample({ title: "Earlier", body: "Earlier", course: "Old" }), {
    idFactory: () => "earlier",
    now: START,
  });
  const later = createNote(sample({ title: "Later", body: "Later", course: "Old" }), {
    idFactory: () => "later",
    now: LATER,
  });
  const state = { ...createEmptyState(), notes: [earlier, later] };

  const renamed = renameCourse(state, "Old", "New", { now: START });
  const moved = moveNotesToTrash(state, ["earlier", "later"], { now: START });

  assert.deepEqual(renamed.state.notes.map((note) => note.updatedAt), [LATER, LATER]);
  assert.deepEqual(moved.entries.map((entry) => entry.deletedAt), [LATER, LATER]);
});

test("moves and restores several notes without changing their order", () => {
  const notes = ["a", "b", "c", "d"].map((identifier) =>
    createNote(
      sample({ title: identifier.toUpperCase(), body: identifier, course: "Course" }),
      { idFactory: () => identifier, now: START },
    ),
  );
  const existing = createNote(sample({ title: "Existing", body: "Existing" }), {
    idFactory: () => "existing",
    now: START,
  });
  const state = {
    ...createEmptyState(),
    revision: 9,
    notes,
    trash: [{ note: existing, deletedAt: START, originalIndex: 0 }],
  };

  const moved = moveNotesToTrash(state, ["d", "b"], { now: LATER });

  assert.equal(moved.state.revision, 10);
  assert.equal(moved.moved, 2);
  assert.deepEqual(moved.notes.map((note) => note.id), ["b", "d"]);
  assert.deepEqual(moved.state.notes.map((note) => note.id), ["a", "c"]);
  assert.deepEqual(moved.state.trash.map((entry) => entry.note.id), ["b", "d", "existing"]);
  assert.deepEqual(moved.entries.map((entry) => entry.originalIndex), [1, 3]);
  assert.deepEqual(moved.entries.map((entry) => entry.deletedAt), [LATER, LATER]);

  const restored = restoreTrashedNotes(moved.state, ["d", "b"], { now: LATER });

  assert.equal(restored.state.revision, 11);
  assert.equal(restored.restored, 2);
  assert.deepEqual(restored.state.notes.map((note) => note.id), ["a", "b", "c", "d"]);
  assert.deepEqual(restored.notes.map((note) => note.id), ["b", "d"]);
  assert.deepEqual(restored.entries.map((entry) => entry.note.id), ["b", "d"]);
  assert.deepEqual(restored.state.trash.map((entry) => entry.note.id), ["existing"]);
});

test("restores sequential deletions with equal indexes in their original order", () => {
  const notes = ["a", "b", "c", "d"].map((identifier) =>
    createNote(sample({ title: identifier.toUpperCase(), body: identifier }), {
      idFactory: () => identifier,
      now: START,
    }),
  );
  const state = { ...createEmptyState(), revision: 7, notes };
  const withoutB = moveNoteToTrash(state, "b", { now: LATER }).state;
  const withoutBOrC = moveNoteToTrash(withoutB, "c", { now: LATER }).state;

  assert.deepEqual(withoutBOrC.trash.map((entry) => entry.note.id), ["c", "b"]);
  assert.deepEqual(withoutBOrC.trash.map((entry) => entry.originalIndex), [1, 1]);

  const result = restoreTrashedNotes(withoutBOrC, ["b", "c"], { now: LATER });

  assert.equal(result.state.revision, withoutBOrC.revision + 1);
  assert.deepEqual(result.state.notes.map((note) => note.id), ["a", "b", "c", "d"]);
  assert.deepEqual(result.state.notes.map((note) => note.updatedAt), [START, START, START, START]);
  assert.deepEqual(result.notes.map((note) => note.id), ["b", "c"]);
  assert.deepEqual(result.entries.map((entry) => entry.note.id), ["c", "b"]);
});

test("restores a subset in order when missing entries clamp its indexes", () => {
  const notes = ["a", "b", "c", "d"].map((identifier) =>
    createNote(sample({ title: identifier.toUpperCase(), body: identifier }), {
      idFactory: () => identifier,
      now: START,
    }),
  );
  let state = { ...createEmptyState(), revision: 3, notes };
  for (const identifier of ["c", "d", "a", "b"]) {
    state = moveNoteToTrash(state, identifier, { now: LATER }).state;
  }
  const revision = state.revision;

  assert.deepEqual(state.trash.map((entry) => entry.note.id), ["b", "a", "d", "c"]);
  assert.deepEqual(state.trash.map((entry) => entry.originalIndex), [0, 0, 2, 2]);

  const result = restoreTrashedNotes(state, ["d", "c"], { now: LATER });

  assert.equal(result.state.revision, revision + 1);
  assert.deepEqual(result.state.notes.map((note) => note.id), ["c", "d"]);
  assert.deepEqual(result.state.notes.map((note) => note.updatedAt), [START, START]);
  assert.deepEqual(result.state.trash.map((entry) => entry.note.id), ["b", "a"]);
});

test("permanently deletes selected Trash entries in one revision", () => {
  const entries = ["a", "b", "c"].map((identifier, index) => ({
    note: createNote(sample({ title: identifier, body: identifier }), {
      idFactory: () => identifier,
      now: START,
    }),
    deletedAt: START,
    originalIndex: index,
  }));
  const state = { ...createEmptyState(), revision: 12, trash: entries };

  const result = permanentlyDeleteTrashedNotes(state, ["c", "a"], { now: LATER });

  assert.equal(result.state.revision, 13);
  assert.equal(result.deleted, 2);
  assert.deepEqual(result.entries.map((entry) => entry.note.id), ["a", "c"]);
  assert.deepEqual(result.state.trash.map((entry) => entry.note.id), ["b"]);
  assert.deepEqual(state.trash, entries);
});

test("rejects duplicate or missing bulk selections without mutation", () => {
  const active = createNote(sample({ title: "Active", body: "Active" }), {
    idFactory: () => "active",
    now: START,
  });
  const deleted = createNote(sample({ title: "Deleted", body: "Deleted" }), {
    idFactory: () => "deleted",
    now: START,
  });
  const state = {
    ...createEmptyState(),
    revision: 3,
    notes: [active],
    trash: [{ note: deleted, deletedAt: START, originalIndex: 0 }],
  };
  const snapshot = structuredClone(state);

  const cases = [
    () => assignCourseToNotes(state, ["active", "active"], "New"),
    () => moveNotesToTrash(state, ["active", "active"]),
    () => restoreTrashedNotes(state, ["deleted", "deleted"]),
    () => permanentlyDeleteTrashedNotes(state, ["deleted", "deleted"]),
  ];
  for (const run of cases) {
    assert.throws(run, { code: "selection-id-duplicate" });
  }

  assert.throws(() => assignCourseToNotes(state, ["missing"], "New"), {
    code: "note-missing",
  });
  assert.throws(() => moveNotesToTrash(state, ["missing"]), { code: "note-missing" });
  assert.throws(() => restoreTrashedNotes(state, ["missing"]), {
    code: "trash-note-missing",
  });
  assert.throws(() => permanentlyDeleteTrashedNotes(state, ["missing"]), {
    code: "trash-note-missing",
  });
  assert.deepEqual(state, snapshot);
});

test("rejects empty and invalid bulk selections", () => {
  const state = createEmptyState();

  assert.throws(() => moveNotesToTrash(state, []), { code: "selection-empty" });
  assert.throws(() => moveNotesToTrash(state, null), { code: "selection-type" });
  assert.throws(() => moveNotesToTrash(state, [12]), { code: "selection-id-type" });
  assert.throws(() => moveNotesToTrash(state, ["not valid"]), {
    code: "selection-id-invalid",
  });
});

test("checks bulk Trash and active-note capacity before changing state", () => {
  const base = createNote(sample({ title: "Base", body: "Base" }), {
    idFactory: () => "base",
    now: START,
  });
  const active = { ...base, id: "active" };
  const fullTrash = Array.from({ length: LIMITS.trash }, (_, index) => ({
    note: { ...base, id: `deleted-${index}` },
    deletedAt: START,
    originalIndex: 0,
  }));
  const moveState = { ...createEmptyState(), revision: 2, notes: [active], trash: fullTrash };

  assert.throws(() => moveNotesToTrash(moveState, ["active"], { now: LATER }), {
    code: "trash-limit",
  });
  assert.equal(moveState.revision, 2);
  assert.equal(moveState.notes.length, 1);
  assert.equal(moveState.trash.length, LIMITS.trash);

  const fullNotes = Array.from({ length: LIMITS.notes }, (_, index) => ({
    ...base,
    id: `active-${index}`,
  }));
  const restoreState = {
    ...createEmptyState(),
    revision: 5,
    notes: fullNotes,
    trash: [{ note: { ...base, id: "deleted" }, deletedAt: START, originalIndex: 0 }],
  };

  assert.throws(() => restoreTrashedNotes(restoreState, ["deleted"], { now: LATER }), {
    code: "notes-limit",
  });
  assert.equal(restoreState.revision, 5);
  assert.equal(restoreState.notes.length, LIMITS.notes);
  assert.equal(restoreState.trash.length, 1);
});

test("rejects missing or unchanged course operations", () => {
  const note = createNote(sample({ course: "CS 101" }), {
    idFactory: () => "note",
    now: START,
  });
  const state = { ...createEmptyState(), notes: [note] };

  assert.throws(() => renameCourse(state, "Math", "Physics"), { code: "course-missing" });
  assert.throws(() => renameCourse(state, "CS 101", "CS 101"), {
    code: "course-unchanged",
  });
  assert.throws(() => assignCourseToNotes(state, ["note"], "CS 101"), {
    code: "course-unchanged",
  });
  assert.equal(state.revision, 0);
  assert.equal(state.notes[0].updatedAt, START);
});

test("keeps active limits and identifiers separate from persistent Trash", () => {
  const deleted = createNote(sample({ body: "Deleted" }), {
    idFactory: () => "same-id",
    now: START,
  });
  const state = {
    ...createEmptyState(),
    trash: [{ note: deleted, deletedAt: LATER, originalIndex: 0 }],
  };
  const added = addNote(state, sample({ body: "Active" }), {
    idFactory: identifiers("same-id", "active-id"),
    now: LATER,
  });

  assert.equal(added.note.id, "active-id");
  assert.equal(added.state.notes.length, 1);
  assert.equal(added.state.trash.length, 1);
});

test("does not recover state written by a newer schema", () => {
  assert.throws(
    () => recoverState({ schemaVersion: 3, revision: 1, notes: [], trash: [] }),
    { code: "schema-version" },
  );
});

test("detects exact duplicate notes unless explicitly allowed", () => {
  const first = addNote(createEmptyState(), sample(), {
    idFactory: () => "note-1",
    now: START,
  });

  assert.throws(
    () => addNote(first.state, sample(), { idFactory: () => "note-2", now: LATER }),
    (error) => error instanceof ValidationError && error.code === "duplicate",
  );
  const allowed = addNote(first.state, sample(), {
    idFactory: () => "note-2",
    now: LATER,
    allowDuplicate: true,
  });
  assert.equal(allowed.state.notes.length, 2);
});

test("allocates a unique ID when a generator first collides", () => {
  const first = addNote(createEmptyState(), sample(), {
    idFactory: () => "same-id",
    now: START,
  });
  const nextId = identifiers("same-id", "new-id");
  const second = addNote(first.state, sample({ body: "Different note" }), {
    idFactory: nextId,
    now: LATER,
  });

  assert.equal(second.note.id, "new-id");
  assert.equal(new Set(second.state.notes.map((note) => note.id)).size, 2);
});

test("stops after repeated ID collisions", () => {
  const first = addNote(createEmptyState(), sample(), {
    idFactory: () => "same-id",
    now: START,
  });

  assert.throws(
    () =>
      addNote(first.state, sample({ body: "Different note" }), {
        idFactory: () => "same-id",
        now: LATER,
      }),
    { code: "id-collision" },
  );
});

test("uses normalized body, course, and source URL for duplicate checks", () => {
  const first = addNote(createEmptyState(), sample({ body: "Café" }), {
    idFactory: () => "note-1",
    now: START,
  });

  assert.throws(
    () =>
      addNote(
        first.state,
        sample({ title: "Renamed", body: "Cafe\u0301", course: "cs 101" }),
        { idFactory: () => "note-2", now: LATER },
      ),
    { code: "duplicate" },
  );
});

test("detects duplicates across equivalent Persian course labels", () => {
  const first = addNote(
    createEmptyState(),
    sample({ course: "ریاضی" }),
    { idFactory: () => "note-persian-course", now: START },
  );

  assert.throws(
    () =>
      addNote(
        first.state,
        sample({ title: "Renamed", course: "رياضى" }),
        { idFactory: () => "note-arabic-course", now: LATER },
      ),
    { code: "duplicate" },
  );
});

test("rejects updating one note into a duplicate", () => {
  const first = addNote(createEmptyState(), sample(), {
    idFactory: () => "note-1",
    now: START,
  });
  const second = addNote(first.state, sample({ body: "Other" }), {
    idFactory: () => "note-2",
    now: LATER,
  });

  assert.throws(
    () => updateNote(second.state, "note-2", { body: "Graph theory notes" }, { now: LATER }),
    { code: "duplicate" },
  );
});

test("searches all useful fields with Unicode normalization", () => {
  const notes = [
    createNote(sample(), { idFactory: () => "note-1", now: START }),
    createNote(
      sample({ title: "ماتریس", body: "مقادیر ویژه", course: "ریاضی", source: {} }),
      { idFactory: () => "note-2", now: LATER },
    ),
  ];

  assert.deepEqual(selectNotes(notes, { query: "GRAPH" }).map((note) => note.id), ["note-1"]);
  assert.deepEqual(selectNotes(notes, { query: "ویژه" }).map((note) => note.id), ["note-2"]);
  assert.deepEqual(selectNotes(notes, { course: "ریاضی" }).map((note) => note.id), ["note-2"]);
});

test("sorts notes and lists courses without case duplicates", () => {
  const notes = [
    createNote(sample({ course: "CS 101" }), { idFactory: () => "old", now: START }),
    createNote(sample({ title: "Algebra", course: "cs 101" }), {
      idFactory: () => "new",
      now: LATER,
    }),
  ];

  assert.deepEqual(selectNotes(notes).map((note) => note.id), ["new", "old"]);
  assert.deepEqual(selectNotes(notes, { sort: "title-asc" }).map((note) => note.id), [
    "new",
    "old",
  ]);
  assert.deepEqual(listCourses(notes), ["CS 101"]);
});

test("exports and restores a versioned backup", () => {
  const note = createNote(sample({ body: "English\nفارسی" }), {
    idFactory: () => "note-1",
    now: START,
  });
  const state = moveNoteToTrash({ ...createEmptyState(), notes: [note] }, "note-1", {
    now: LATER,
  }).state;
  const text = serializeBackup(state, { now: LATER });
  const restored = parseBackup(text, { idFactory: () => "unused", now: LATER });

  assert.equal(createBackup(state, { now: LATER }).format, "lecturenote-backup");
  assert.equal(restored.schemaVersion, 2);
  assert.equal(restored.exportedAt, LATER);
  assert.deepEqual(restored.notes, []);
  assert.deepEqual(restored.trash, state.trash);
});

test("imports version 1 backups with an empty Trash", () => {
  const note = createNote(sample(), { idFactory: () => "legacy", now: START });
  const restored = parseBackup(JSON.stringify({
    format: "lecturenote-backup",
    schemaVersion: 1,
    notes: [note],
    settings: { theme: "light", sort: "created-desc" },
  }), { now: LATER });

  assert.deepEqual(restored.notes, [note]);
  assert.deepEqual(restored.trash, []);
  assert.equal(restored.schemaVersion, 1);
  assert.equal(restored.exportedAt, null);
});

test("previews merge collisions with the same result as the real merge", () => {
  const existing = createNote(sample(), { idFactory: () => "same-id", now: START });
  const repeated = { ...existing };
  const collision = createNote(sample({ body: "Different text" }), {
    idFactory: () => "same-id",
    now: LATER,
  });
  const current = {
    ...createEmptyState(),
    notes: [existing],
    settings: { theme: "light", sort: "created-desc", includeSourceOnShare: true },
  };
  const imported = {
    notes: [repeated, collision],
    trash: [],
    settings: { theme: "dark", sort: "title-asc", includeSourceOnShare: false },
    schemaVersion: 2,
    exportedAt: LATER,
  };

  const preview = previewImportedBackup(current, imported, {
    idFactory: () => "replacement-id",
    now: LATER,
  });
  const merged = mergeImportedBackup(current, imported, { now: LATER });

  assert.deepEqual(
    {
      added: preview.merge.added,
      trashAdded: preview.merge.trashAdded,
      skipped: preview.merge.skipped,
      rekeyed: preview.merge.rekeyed,
      resultingNotes: preview.merge.resultingNotes,
      resultingTrash: preview.merge.resultingTrash,
    },
    {
      added: merged.added,
      trashAdded: merged.trashAdded,
      skipped: merged.skipped,
      rekeyed: merged.rekeyed,
      resultingNotes: merged.state.notes.length,
      resultingTrash: merged.state.trash.length,
    },
  );
  assert.equal(merged.state.notes[0].id, "same-id_import_1");
  assert.equal(preview.replace.removedNotes, 1);
  assert.equal(preview.replace.resultingNotes, 2);
  assert.deepEqual(preview.replace.currentSettings, current.settings);
  assert.deepEqual(preview.replace.settings, imported.settings);
  assert.equal(preview.replace.settingsChanged, true);
  assert.deepEqual(preview.backup, {
    schemaVersion: 2,
    exportedAt: LATER,
    notes: 2,
    trash: 0,
  });
});

test("previews an over-limit merge while keeping Replace available", () => {
  const base = createNote(sample(), { idFactory: () => "current-0", now: START });
  const current = {
    ...createEmptyState(),
    notes: Array.from({ length: LIMITS.notes }, (_, index) => ({
      ...base,
      id: `current-${index}`,
    })),
  };
  const imported = {
    notes: [{ ...base, id: "extra", body: "An extra note" }],
    trash: [],
    settings: { theme: "system", sort: "updated-desc" },
  };
  const preview = previewImportedBackup(current, imported, { now: LATER });

  assert.equal(preview.merge.added, 1);
  assert.equal(preview.merge.resultingNotes, LIMITS.notes + 1);
  assert.equal(preview.merge.withinCountLimits, false);
  assert.equal(preview.replace.resultingNotes, 1);
  assert.throws(() => mergeImportedBackup(current, imported, { now: LATER }), {
    code: "notes-limit",
  });
});

test("measures serialized storage and warns near configured limits", () => {
  const base = createNote(sample(), { idFactory: () => "note-0", now: START });
  const normalState = { ...createEmptyState(), notes: [base] };
  const normal = measureLibraryUsage(normalState);

  assert.equal(normal.bytes, new TextEncoder().encode(JSON.stringify(normalState)).byteLength);
  assert.equal(normal.byteLimit, LIMITS.localStorageBytes);
  assert.equal(normal.stateBytes, normal.bytes);
  assert.equal(normal.stateByteLimit, LIMITS.stateBytes);
  assert.equal(normal.hasMeasuredStorageBytes, false);
  assert.equal(normal.notes, 1);
  assert.equal(normal.noteLimit, LIMITS.notes);
  assert.equal(normal.level, "normal");

  const warning = measureLibraryUsage({
    ...createEmptyState(),
    notes: Array.from({ length: 1_600 }, (_, index) => ({
      ...base,
      id: `note-${index}`,
    })),
  });
  const critical = measureLibraryUsage({
    ...createEmptyState(),
    notes: Array.from({ length: 1_900 }, (_, index) => ({
      ...base,
      id: `note-${index}`,
    })),
  });

  assert.equal(warning.level, "warning");
  assert.equal(critical.level, "critical");

  const measured = measureLibraryUsage(normalState, { storageBytes: 2_621_440 });
  assert.equal(measured.bytes, 2_621_440);
  assert.equal(measured.stateBytes, normal.bytes);
  assert.equal(measured.byteLimit, LIMITS.localStorageBytes);
  assert.equal(measured.hasMeasuredStorageBytes, true);

  const storageWarning = measureLibraryUsage(normalState, {
    storageBytes: LIMITS.localStorageBytes * 0.8,
  });
  const storageCritical = measureLibraryUsage(normalState, {
    storageBytes: LIMITS.localStorageBytes * 0.95,
  });
  assert.equal(storageWarning.level, "warning");
  assert.equal(storageCritical.level, "critical");
});

test("keeps record budgets below the Chrome local storage quota", () => {
  const reservedBytes =
    LIMITS.stateBytes +
    LIMITS.popupDraftBytes +
    LIMITS.editorDraftBytes +
    LIMITS.pendingCapturesBytes;

  assert.ok(reservedBytes < LIMITS.localStorageBytes);
  assert.ok(LIMITS.localStorageBytes - reservedBytes >= 500_000);
});

test("replaces imported notes and advances the revision", () => {
  const current = addNote(createEmptyState(), sample(), {
    idFactory: () => "old",
    now: START,
  }).state;
  const replacement = createNote(sample({ body: "Restored" }), {
    idFactory: () => "new",
    now: LATER,
  });
  const state = replaceImportedNotes(
    current,
    { notes: [replacement], settings: { theme: "dark", sort: "title-asc" } },
    { now: LATER },
  );

  assert.equal(state.revision, current.revision + 1);
  assert.deepEqual(state.notes, [replacement]);
  assert.deepEqual(state.trash, []);
  assert.equal(state.settings.theme, "dark");
});

test("merges and replaces Trash entries from backups", () => {
  const active = createNote(sample({ body: "Active" }), { idFactory: () => "active", now: START });
  const deleted = createNote(sample({ body: "Deleted" }), { idFactory: () => "deleted", now: START });
  const trash = [{ note: deleted, deletedAt: LATER, originalIndex: 1 }];
  const merged = mergeImportedBackup(createEmptyState(), { notes: [active], trash }, { now: LATER });

  assert.equal(merged.added, 1);
  assert.equal(merged.trashAdded, 1);
  assert.deepEqual(merged.state.trash, trash);

  const repeated = mergeImportedBackup(merged.state, { notes: [active], trash }, { now: LATER });
  assert.equal(repeated.added, 0);
  assert.equal(repeated.trashAdded, 0);
  assert.equal(repeated.skipped, 2);

  const replaced = replaceImportedNotes(merged.state, {
    notes: [],
    trash,
    settings: { theme: "system", sort: "updated-desc" },
  });
  assert.deepEqual(replaced.notes, []);
  assert.deepEqual(replaced.trash, trash);
});

test("rejects malformed, wrong-format, and oversized backups", () => {
  assert.throws(() => parseBackup("{"), { code: "import-json" });
  assert.throws(() => parseBackup('{"notes":[]}'), { code: "import-format" });
  assert.throws(
    () => parseBackup(`{"format":"lecturenote-backup","schemaVersion":3,"notes":[]}`),
    { code: "schema-version" },
  );
  assert.throws(
    () => parseBackup(`{"format":"lecturenote-backup","schemaVersion":2,"notes":[]}`),
    { code: "import-trash-type" },
  );
  assert.throws(() => parseBackup("x".repeat(LIMITS.importBytes + 1)), { code: "import-size" });
});

test("ignores imported prototype keys and rebuilds allowed fields", () => {
  const text = `{
    "format": "lecturenote-backup",
    "schemaVersion": 1,
    "notes": [{
      "id": "note-1",
      "title": "Safe",
      "body": "Text",
      "__proto__": {"polluted": true}
    }]
  }`;
  const restored = parseBackup(text, { idFactory: () => "unused", now: START });

  assert.equal(restored.notes[0].title, "Safe");
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal("polluted" in restored.notes[0], false);
});

test("merges imports without overwriting IDs or dropping intentional copies", () => {
  const existing = createNote(sample(), { idFactory: () => "same-id", now: START });
  const duplicate = createNote(sample(), { idFactory: () => "duplicate-id", now: LATER });
  const collision = createNote(sample({ body: "Different" }), {
    idFactory: () => "same-id",
    now: LATER,
  });
  const merged = mergeImportedNotes(
    { ...createEmptyState(), notes: [existing] },
    [duplicate, collision],
    { now: LATER },
  );

  assert.equal(merged.added, 2);
  assert.equal(merged.skipped, 0);
  assert.equal(merged.rekeyed, 1);
  assert.deepEqual(
    merged.state.notes.slice(0, 2).map((note) => note.id),
    ["duplicate-id", "same-id_import_1"],
  );

  const repeated = mergeImportedNotes(merged.state, [duplicate, collision], { now: LATER });
  assert.equal(repeated.added, 0);
  assert.equal(repeated.skipped, 2);
  assert.equal(repeated.state.notes.length, 3);
});

test("rejects a non-list import instead of reporting an empty merge", () => {
  assert.throws(() => mergeImportedNotes(createEmptyState(), null), {
    code: "import-notes-type",
  });
});

test("normalizes drafts without silently truncating them", () => {
  const draft = normalizeDraft({ body: "Persian فارسی", noteId: "note-1", baseRevision: 3 }, { now: START });
  assert.equal(draft.noteId, "note-1");
  assert.equal(draft.baseRevision, 3);
  assert.throws(() => normalizeDraft({ body: "x".repeat(LIMITS.body + 1) }, { now: START }), {
    code: "note-text-length",
  });
});

test("normalizes editor drafts without losing unfinished source fields", () => {
  const baseNote = createNote(sample(), { idFactory: () => "note-1", now: START });
  const draft = normalizeEditorDraft(
    {
      noteId: baseNote.id,
      baseRevision: 4,
      baseNote: { ...baseNote, ignored: "drop this" },
      title: baseNote.title,
      body: `${baseNote.body}\nیادداشت`,
      course: baseNote.course,
      source: { title: "Course page", url: "https://" },
      ignored: "drop this",
    },
    { now: LATER },
  );

  assert.equal(draft.source.url, "https://");
  assert.equal(draft.body, `${baseNote.body}\nیادداشت`);
  assert.equal(draft.baseNote.id, baseNote.id);
  assert.equal(Object.hasOwn(draft, "ignored"), false);
  assert.equal(Object.hasOwn(draft.baseNote, "ignored"), false);
});

test("removes secrets from valid editor draft source URLs", () => {
  const draft = normalizeEditorDraft(
    {
      body: "Pending note",
      source: {
        url: "https://student:password@example.com/lesson?chapter=2&token=secret&utm_source=mail#answers",
      },
    },
    { now: START },
  );

  assert.equal(draft.source.url, "https://example.com/lesson?chapter=2");

  const unsupported = normalizeEditorDraft(
    {
      body: "Pending note",
      source: {
        url: "ftp://student:password@example.com/lesson?chapter=2&token=secret#answers",
      },
    },
    { now: START },
  );
  assert.equal(unsupported.source.url, "ftp://example.com/lesson?chapter=2");

  const incomplete = normalizeEditorDraft(
    {
      body: "Pending note",
      source: {
        url: "https://student:password@?chapter=2&token=secret#answers",
      },
    },
    { now: START },
  );
  assert.equal(incomplete.source.url, "https://?chapter=2");
});

test("drops blank and unchanged editor drafts but keeps cleared edits", () => {
  const baseNote = createNote(sample(), { idFactory: () => "note-1", now: START });
  assert.equal(normalizeEditorDraft({}, { now: START }), null);
  assert.equal(
    normalizeEditorDraft(
      {
        noteId: baseNote.id,
        baseNote,
        title: baseNote.title,
        body: baseNote.body,
        course: baseNote.course,
        source: baseNote.source,
      },
      { now: START },
    ),
    null,
  );

  const cleared = normalizeEditorDraft(
    {
      noteId: baseNote.id,
      baseNote,
      title: "",
      body: "",
      course: "",
      source: {},
    },
    { now: START },
  );
  assert.equal(cleared.noteId, baseNote.id);
  assert.equal(cleared.body, "");
});

test("rejects invalid editor draft identity and field limits", () => {
  const baseNote = createNote(sample(), { idFactory: () => "note-1", now: START });
  assert.throws(
    () => normalizeEditorDraft({ noteId: "note-1", body: "Changed" }, { now: START }),
    { code: "draft-base-note" },
  );
  assert.throws(
    () => normalizeEditorDraft({ noteId: "different", baseNote, body: "Changed" }, { now: START }),
    { code: "draft-base-id" },
  );
  assert.throws(
    () => normalizeEditorDraft({ body: "x".repeat(LIMITS.body + 1) }, { now: START }),
    { code: "note-text-length" },
  );
});

test("updates settings through the revision contract", () => {
  const state = updateSettings(createEmptyState(), {
    theme: "dark",
    sort: "title-asc",
    includeSourceOnShare: false,
  });
  assert.equal(state.revision, 1);
  assert.deepEqual(state.settings, {
    theme: "dark",
    sort: "title-asc",
    includeSourceOnShare: false,
  });

  const restoredDefault = normalizeState({
    ...createEmptyState(),
    settings: { theme: "light", sort: "created-desc" },
  });
  assert.equal(restoredDefault.settings.includeSourceOnShare, true);
});

test("creates readable Markdown while escaping active markup", () => {
  const note = createNote(
    sample({ title: "<script>*test*</script>", body: "Plain <b>body</b>" }),
    { idFactory: () => "note-1", now: START },
  );
  const markdown = notesToMarkdown([note]);

  assert.match(markdown, /## &lt;script&gt;\\\*test\\\*&lt;\/script&gt;/u);
  assert.match(markdown, /Plain &lt;b&gt;body&lt;\/b&gt;/u);
  assert.doesNotMatch(markdown, /<script>|<b>/u);
});
