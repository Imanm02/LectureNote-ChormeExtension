import {
  LIMITS,
  normalizeNote,
  normalizeState,
  noteFingerprint,
  SCHEMA_VERSION,
  ValidationError,
} from "./model.js";

function importedIdentifier(identifier, attempt) {
  const suffix = `_import_${attempt}`;
  return `${identifier.slice(0, LIMITS.identifier - suffix.length)}${suffix}`;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validTimestamp(value, fallback) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return fallback;
  }
  return new Date(value).toISOString();
}

export function createBackup(stateValue, { now = new Date().toISOString() } = {}) {
  const state = normalizeState(stateValue, { now });
  return {
    format: "lecturenote-backup",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: validTimestamp(now, new Date().toISOString()),
    notes: state.notes,
    settings: state.settings,
  };
}

export function serializeBackup(state, options = {}) {
  const text = `${JSON.stringify(createBackup(state, options), null, 2)}\n`;
  if (new TextEncoder().encode(text).byteLength > LIMITS.importBytes) {
    throw new ValidationError("The library is too large for one backup file.", "export-size");
  }
  return text;
}

export function parseBackup(
  text,
  { idFactory = () => crypto.randomUUID(), now = new Date().toISOString() } = {},
) {
  if (typeof text !== "string") {
    throw new ValidationError("The backup must be text.", "import-type");
  }
  if (new TextEncoder().encode(text).byteLength > LIMITS.importBytes) {
    throw new ValidationError("The backup file is too large.", "import-size");
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ValidationError("The selected file is not valid JSON.", "import-json");
  }
  if (!isRecord(value) || value.format !== "lecturenote-backup") {
    throw new ValidationError("This is not a Lecture Notes backup.", "import-format");
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new ValidationError("This backup version is not supported.", "schema-version");
  }

  const normalized = normalizeState(
    {
      schemaVersion: value.schemaVersion,
      notes: value.notes,
      settings: value.settings,
    },
    { idFactory, now },
  );
  return {
    notes: normalized.notes,
    settings: normalized.settings,
  };
}

export function mergeImportedNotes(stateValue, importedValue, options = {}) {
  const state = normalizeState(stateValue, options);
  if (!Array.isArray(importedValue)) {
    throw new ValidationError("Imported notes must be a list.", "import-notes-type");
  }

  const imported = importedValue.map((note) => normalizeNote(note, options));
  const notesByIdentifier = new Map(state.notes.map((note) => [note.id, note]));
  const addedNotes = [];
  let skipped = 0;
  let rekeyed = 0;

  for (const candidate of imported) {
    const fingerprint = noteFingerprint(candidate);
    let note = candidate;
    const existing = notesByIdentifier.get(note.id);
    if (existing) {
      if (noteFingerprint(existing) === fingerprint) {
        skipped += 1;
        continue;
      }

      let replacementId = "";
      for (let attempt = 1; attempt <= LIMITS.notes; attempt += 1) {
        const candidateId = importedIdentifier(note.id, attempt);
        const priorImport = notesByIdentifier.get(candidateId);
        if (!priorImport) {
          replacementId = candidateId;
          break;
        }
        if (noteFingerprint(priorImport) === fingerprint) {
          skipped += 1;
          replacementId = null;
          break;
        }
      }
      if (replacementId === null) {
        continue;
      }
      if (!replacementId) {
        throw new ValidationError("A unique imported note ID could not be created.", "id-collision");
      }
      note = { ...note, id: replacementId };
      rekeyed += 1;
    }
    if (state.notes.length + addedNotes.length >= LIMITS.notes) {
      throw new ValidationError("The imported notes would exceed the library limit.", "notes-limit");
    }

    notesByIdentifier.set(note.id, note);
    addedNotes.push(note);
  }

  return {
    state: {
      ...state,
      revision: addedNotes.length > 0 ? state.revision + 1 : state.revision,
      notes: [...addedNotes, ...state.notes],
    },
    added: addedNotes.length,
    skipped,
    rekeyed,
  };
}

export function replaceImportedNotes(stateValue, importedValue, options = {}) {
  const state = normalizeState(stateValue, options);
  if (!isRecord(importedValue) || !Array.isArray(importedValue.notes)) {
    throw new ValidationError("Imported notes must be a list.", "import-notes-type");
  }

  const replacement = normalizeState(
    {
      schemaVersion: SCHEMA_VERSION,
      revision: state.revision + 1,
      notes: importedValue.notes,
      settings: importedValue.settings,
    },
    options,
  );
  return replacement;
}

function escapeMarkdownText(value) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/([\\`*_[\]])/gu, "\\$1");
}

function markdownUrl(value) {
  return value.replace(/</gu, "%3C").replace(/>/gu, "%3E");
}

export function notesToMarkdown(notes) {
  if (notes.length === 0) {
    return "# Lecture Notes\n\nNo saved notes.\n";
  }

  const sections = notes.map((note) => {
    const lines = [`## ${escapeMarkdownText(note.title)}`];
    if (note.course) {
      lines.push("", `Course: ${escapeMarkdownText(note.course)}`);
    }
    if (note.source.url) {
      const label = escapeMarkdownText(note.source.title || note.source.url);
      lines.push("", `Source: [${label}](<${markdownUrl(note.source.url)}>)`);
    } else if (note.source.title) {
      lines.push("", `Source: ${escapeMarkdownText(note.source.title)}`);
    }
    lines.push("", `Updated: ${note.updatedAt}`, "", escapeMarkdownText(note.body));
    return lines.join("\n");
  });

  return `# Lecture Notes\n\n${sections.join("\n\n")}\n`;
}
