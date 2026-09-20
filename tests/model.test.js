import assert from "node:assert/strict";
import test from "node:test";

import {
  addNote,
  createEmptyState,
  createNote,
  LIMITS,
  normalizeDraft,
  normalizeNote,
  normalizeSource,
  removeNote,
  restoreNote,
  updateSettings,
  updateNote,
  ValidationError,
} from "../src/model.js";
import {
  createBackup,
  mergeImportedNotes,
  notesToMarkdown,
  parseBackup,
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

test("adds, edits, removes, and restores a note", () => {
  const added = addNote(createEmptyState(), sample(), {
    idFactory: () => "note-1",
    now: START,
  });
  const updated = updateNote(added.state, "note-1", { body: "Updated content" }, { now: LATER });
  const removed = removeNote(updated.state, "note-1");
  const restored = restoreNote(removed.state, removed.note, removed.index);

  assert.equal(added.state.revision, 1);
  assert.equal(updated.note.createdAt, START);
  assert.equal(updated.note.updatedAt, LATER);
  assert.equal(removed.state.notes.length, 0);
  assert.deepEqual(restored.state.notes, [updated.note]);
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
  const state = { ...createEmptyState(), notes: [note] };
  const text = serializeBackup(state, { now: LATER });
  const restored = parseBackup(text, { idFactory: () => "unused", now: LATER });

  assert.equal(createBackup(state, { now: LATER }).format, "lecturenote-backup");
  assert.deepEqual(restored.notes, [note]);
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
  assert.equal(state.settings.theme, "dark");
});

test("rejects malformed, wrong-format, and oversized backups", () => {
  assert.throws(() => parseBackup("{"), { code: "import-json" });
  assert.throws(() => parseBackup('{"notes":[]}'), { code: "import-format" });
  assert.throws(
    () => parseBackup(`{"format":"lecturenote-backup","schemaVersion":2,"notes":[]}`),
    { code: "schema-version" },
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

test("updates settings through the revision contract", () => {
  const state = updateSettings(createEmptyState(), { theme: "dark", sort: "title-asc" });
  assert.equal(state.revision, 1);
  assert.deepEqual(state.settings, { theme: "dark", sort: "title-asc" });
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
