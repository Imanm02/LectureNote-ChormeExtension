import {
  LIMITS,
  normalizeNote,
  normalizeState,
  normalizeTrashEntry,
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
    trash: state.trash,
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
  if (![1, SCHEMA_VERSION].includes(value.schemaVersion)) {
    throw new ValidationError("This backup version is not supported.", "schema-version");
  }
  if (value.schemaVersion >= 2 && !Array.isArray(value.trash)) {
    throw new ValidationError("The backup Trash entries must be a list.", "import-trash-type");
  }

  const normalized = normalizeState(
    {
      schemaVersion: value.schemaVersion,
      notes: value.notes,
      trash: value.schemaVersion >= 2 ? value.trash : [],
      settings: value.settings,
    },
    { idFactory, now },
  );
  return {
    notes: normalized.notes,
    trash: normalized.trash,
    settings: normalized.settings,
    schemaVersion: value.schemaVersion,
    exportedAt: validTimestamp(value.exportedAt, null),
  };
}

function prepareImportedMerge(stateValue, importedValue, options = {}) {
  const state = normalizeState(stateValue, options);
  if (!isRecord(importedValue) || !Array.isArray(importedValue.notes)) {
    throw new ValidationError("Imported notes must be a list.", "import-notes-type");
  }
  if (importedValue.trash !== undefined && !Array.isArray(importedValue.trash)) {
    throw new ValidationError("Imported Trash entries must be a list.", "import-trash-type");
  }

  const imported = importedValue.notes.map((note) => normalizeNote(note, options));
  const importedTrash = (importedValue.trash || []).map((entry) =>
    normalizeTrashEntry(entry, options),
  );
  const notesByIdentifier = new Map([
    ...state.notes.map((note) => [note.id, note]),
    ...state.trash.map((entry) => [entry.note.id, entry.note]),
  ]);
  const addedNotes = [];
  const addedTrash = [];
  let skipped = 0;
  let rekeyed = 0;

  function prepareCandidate(candidate) {
    const fingerprint = noteFingerprint(candidate);
    let note = candidate;
    const existing = notesByIdentifier.get(note.id);
    if (existing) {
      if (noteFingerprint(existing) === fingerprint) {
        skipped += 1;
        return null;
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
        return null;
      }
      if (!replacementId) {
        throw new ValidationError("A unique imported note ID could not be created.", "id-collision");
      }
      note = { ...note, id: replacementId };
      rekeyed += 1;
    }
    notesByIdentifier.set(note.id, note);
    return note;
  }

  for (const candidate of imported) {
    const note = prepareCandidate(candidate);
    if (!note) {
      continue;
    }
    addedNotes.push(note);
  }

  for (const candidateEntry of importedTrash) {
    const note = prepareCandidate(candidateEntry.note);
    if (!note) {
      continue;
    }
    addedTrash.push({ ...candidateEntry, note });
  }

  return {
    state,
    imported,
    importedTrash,
    addedNotes,
    addedTrash,
    skipped,
    rekeyed,
  };
}

export function mergeImportedBackup(stateValue, importedValue, options = {}) {
  const plan = prepareImportedMerge(stateValue, importedValue, options);
  if (plan.state.notes.length + plan.addedNotes.length > LIMITS.notes) {
    throw new ValidationError("The imported notes would exceed the library limit.", "notes-limit");
  }
  if (plan.state.trash.length + plan.addedTrash.length > LIMITS.trash) {
    throw new ValidationError("The imported Trash entries would exceed the Trash limit.", "trash-limit");
  }

  return {
    state: {
      ...plan.state,
      revision:
        plan.addedNotes.length + plan.addedTrash.length > 0
          ? plan.state.revision + 1
          : plan.state.revision,
      notes: [...plan.addedNotes, ...plan.state.notes],
      trash: [...plan.addedTrash, ...plan.state.trash],
    },
    added: plan.addedNotes.length,
    trashAdded: plan.addedTrash.length,
    skipped: plan.skipped,
    rekeyed: plan.rekeyed,
  };
}

export function previewImportedBackup(stateValue, importedValue, options = {}) {
  const plan = prepareImportedMerge(stateValue, importedValue, options);
  const replacement = replaceImportedNotes(plan.state, importedValue, options);
  const resultingNotes = plan.state.notes.length + plan.addedNotes.length;
  const resultingTrash = plan.state.trash.length + plan.addedTrash.length;

  return {
    backup: {
      schemaVersion: Number.isSafeInteger(importedValue.schemaVersion)
        ? importedValue.schemaVersion
        : null,
      exportedAt:
        typeof importedValue.exportedAt === "string" ? importedValue.exportedAt : null,
      notes: plan.imported.length,
      trash: plan.importedTrash.length,
    },
    merge: {
      added: plan.addedNotes.length,
      trashAdded: plan.addedTrash.length,
      skipped: plan.skipped,
      rekeyed: plan.rekeyed,
      resultingNotes,
      resultingTrash,
      withinCountLimits:
        resultingNotes <= LIMITS.notes && resultingTrash <= LIMITS.trash,
    },
    replace: {
      removedNotes: plan.state.notes.length,
      removedTrash: plan.state.trash.length,
      resultingNotes: replacement.notes.length,
      resultingTrash: replacement.trash.length,
      currentSettings: { ...plan.state.settings },
      settings: { ...replacement.settings },
      settingsChanged:
        JSON.stringify(plan.state.settings) !== JSON.stringify(replacement.settings),
    },
  };
}

export function mergeImportedNotes(stateValue, importedValue, options = {}) {
  if (!Array.isArray(importedValue)) {
    throw new ValidationError("Imported notes must be a list.", "import-notes-type");
  }
  return mergeImportedBackup(stateValue, { notes: importedValue, trash: [] }, options);
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
      trash: importedValue.trash || [],
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
