export const SCHEMA_VERSION = 1;

export const LIMITS = Object.freeze({
  title: 160,
  body: 100_000,
  course: 80,
  sourceTitle: 200,
  sourceUrl: 2_048,
  captureUrl: 100_000,
  notes: 2_000,
  importBytes: 8_000_000,
  stateBytes: 7_000_000,
});

export const SORT_VALUES = Object.freeze([
  "updated-desc",
  "created-desc",
  "created-asc",
  "title-asc",
]);

export const THEME_VALUES = Object.freeze(["system", "light", "dark"]);

export class ValidationError extends Error {
  constructor(message, code = "invalid") {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
const IDENTIFIER_ATTEMPTS = 25;

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stripUnsafeControls(value, allowNewlines = false) {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      const allowedWhitespace = allowNewlines && (codePoint === 9 || codePoint === 10);
      const control = (codePoint <= 31 && !allowedWhitespace) || (codePoint >= 127 && codePoint <= 159);
      const bidirectionalOverride =
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069);
      return !control && !bidirectionalOverride;
    })
    .join("");
}

function normalizeSingleLine(value, label, maximum, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) {
      throw new ValidationError(`${label} is required.`, `${label.toLowerCase()}-required`);
    }
    return "";
  }

  if (typeof value !== "string") {
    throw new ValidationError(`${label} must be text.`, `${label.toLowerCase()}-type`);
  }

  const normalized = stripUnsafeControls(value).replace(/\s+/gu, " ").trim();
  if (required && normalized.length === 0) {
    throw new ValidationError(`${label} is required.`, `${label.toLowerCase()}-required`);
  }
  if (normalized.length > maximum) {
    throw new ValidationError(
      `${label} must be ${maximum.toLocaleString()} characters or fewer.`,
      `${label.toLowerCase()}-length`,
    );
  }
  return normalized;
}

function normalizeBody(value) {
  if (typeof value !== "string") {
    throw new ValidationError("Note text must be text.", "body-type");
  }

  const normalized = stripUnsafeControls(value.replace(/\r\n?/gu, "\n"), true).trim();
  if (normalized.length === 0) {
    throw new ValidationError("Add note text before saving.", "body-required");
  }
  if (normalized.length > LIMITS.body) {
    throw new ValidationError(
      `Note text must be ${LIMITS.body.toLocaleString()} characters or fewer.`,
      "body-length",
    );
  }
  return normalized;
}

export function isValidIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function generateIdentifier(idFactory) {
  const identifier = idFactory();
  if (!isValidIdentifier(identifier)) {
    throw new ValidationError("A valid note ID could not be created.", "id-invalid");
  }
  return identifier;
}

function allocateIdentifier(identifiers, idFactory, preferred) {
  if (isValidIdentifier(preferred) && !identifiers.has(preferred)) {
    return preferred;
  }

  for (let attempt = 0; attempt < IDENTIFIER_ATTEMPTS; attempt += 1) {
    const identifier = generateIdentifier(idFactory);
    if (!identifiers.has(identifier)) {
      return identifier;
    }
  }
  throw new ValidationError("A unique note ID could not be created.", "id-collision");
}

export function createUniqueIdentifier(
  existingIdentifiers,
  idFactory = () => crypto.randomUUID(),
  preferred,
) {
  return allocateIdentifier(new Set(existingIdentifiers), idFactory, preferred);
}

function normalizeIdentifier(value, idFactory) {
  if (isValidIdentifier(value)) {
    return value;
  }
  return generateIdentifier(idFactory);
}

function normalizeTimestamp(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

const SENSITIVE_QUERY_PARAMETER = /^(?:(?:access|id|oauth|refresh)_?token|api_?key|auth|authorization|client_?secret|code|credential|fbclid|gclid|key|msclkid|pass|password|samlresponse|secret|session|session_?id|sig|signature|state|token|utm_.+|x-(?:amz|goog)-(?:credential|signature))$/iu;
export function normalizeSource(value = {}, { strictUrl = false } = {}) {
  if (!isRecord(value)) {
    throw new ValidationError("Source details are invalid.", "source-type");
  }

  const title = normalizeSingleLine(value.title, "Source title", LIMITS.sourceTitle);
  const rawUrl = normalizeSingleLine(
    value.url,
    "Source URL",
    strictUrl ? LIMITS.sourceUrl : LIMITS.captureUrl,
  );
  if (!rawUrl) {
    return { title, url: "" };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    if (strictUrl) {
      throw new ValidationError("Enter a valid HTTP or HTTPS source URL.", "source-url-invalid");
    }
    return { title, url: "" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    if (strictUrl) {
      throw new ValidationError("Enter a valid HTTP or HTTPS source URL.", "source-url-invalid");
    }
    return { title, url: "" };
  }

  parsed.username = "";
  parsed.password = "";
  for (const name of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_PARAMETER.test(name)) {
      parsed.searchParams.delete(name);
    }
  }
  parsed.hash = "";
  if (parsed.href.length > LIMITS.sourceUrl) {
    if (strictUrl) {
      throw new ValidationError(
        `Source URL must be ${LIMITS.sourceUrl.toLocaleString()} characters or fewer.`,
        "source-url-length",
      );
    }
    return { title, url: "" };
  }
  const url = parsed.href;
  return { title, url };
}

export function createEmptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    notes: [],
    settings: {
      theme: "system",
      sort: "updated-desc",
    },
  };
}

export function normalizeNote(
  value,
  {
    idFactory = () => crypto.randomUUID(),
    now = new Date().toISOString(),
    strictSourceUrl = false,
  } = {},
) {
  if (!isRecord(value)) {
    throw new ValidationError("Each note must be an object.", "note-type");
  }

  const body = normalizeBody(value.body);
  const fallbackTitle = body.split("\n").find((line) => line.trim())?.trim() || "Untitled note";
  const title = normalizeSingleLine(
    value.title || fallbackTitle.slice(0, LIMITS.title),
    "Title",
    LIMITS.title,
    { required: true },
  );
  const course = normalizeSingleLine(value.course, "Course", LIMITS.course);
  const sourceValue = isRecord(value.source)
    ? value.source
    : { title: value.sourceTitle, url: value.sourceUrl };
  const source = normalizeSource(sourceValue, { strictUrl: strictSourceUrl });
  const safeNow = normalizeTimestamp(now, new Date().toISOString());
  const createdAt = normalizeTimestamp(value.createdAt, safeNow);
  let updatedAt = normalizeTimestamp(value.updatedAt, createdAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    updatedAt = createdAt;
  }

  return {
    id: normalizeIdentifier(value.id, idFactory),
    title,
    body,
    course,
    source,
    createdAt,
    updatedAt,
  };
}

export function normalizeState(
  value,
  { idFactory = () => crypto.randomUUID(), now = new Date().toISOString() } = {},
) {
  if (value === undefined || value === null) {
    return createEmptyState();
  }
  if (!isRecord(value)) {
    throw new ValidationError("Saved note data is invalid.", "state-type");
  }

  const version = value.schemaVersion ?? value.version ?? SCHEMA_VERSION;
  if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION) {
    throw new ValidationError("This note data version is not supported.", "schema-version");
  }
  if (!Array.isArray(value.notes)) {
    throw new ValidationError("The saved notes list is invalid.", "notes-type");
  }
  if (value.notes.length > LIMITS.notes) {
    throw new ValidationError(
      `A library can contain at most ${LIMITS.notes.toLocaleString()} notes.`,
      "notes-limit",
    );
  }

  const identifiers = new Set();
  const notes = value.notes.map((note) => {
    const normalized = normalizeNote(note, { idFactory, now });
    if (identifiers.has(normalized.id)) {
      normalized.id = allocateIdentifier(identifiers, idFactory);
    }
    identifiers.add(normalized.id);
    return normalized;
  });

  const settings = isRecord(value.settings) ? value.settings : {};
  const theme = THEME_VALUES.includes(settings.theme) ? settings.theme : "system";
  const sort = SORT_VALUES.includes(settings.sort) ? settings.sort : "updated-desc";
  const revision = Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0;

  return {
    schemaVersion: SCHEMA_VERSION,
    revision,
    notes,
    settings: { theme, sort },
  };
}

export function recoverState(value, options = {}) {
  if (!isRecord(value) || !Array.isArray(value.notes)) {
    throw new ValidationError("Saved note data cannot be recovered.", "state-unrecoverable");
  }

  const accepted = [];
  const rejected = [];
  value.notes.forEach((note, index) => {
    try {
      accepted.push(normalizeNote(note, options));
    } catch (error) {
      rejected.push({
        index,
        note,
        reason: error instanceof Error ? error.message : "Invalid note",
      });
    }
  });

  const state = normalizeState({ ...value, notes: accepted }, options);
  state.revision = Number.isSafeInteger(value.revision) ? value.revision + 1 : 1;
  return { state, rejected };
}

function normalizeDraftField(value, label, maximum, allowNewlines = false) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new ValidationError(`${label} must be text.`, `${label.toLowerCase()}-type`);
  }

  const normalized = stripUnsafeControls(
    allowNewlines ? value.replace(/\r\n?/gu, "\n") : value,
    allowNewlines,
  );
  if (normalized.length > maximum) {
    const code = label.toLowerCase().replace(/\s+/gu, "-");
    throw new ValidationError(
      `${label} must be ${maximum.toLocaleString()} characters or fewer.`,
      `${code}-length`,
    );
  }
  return normalized;
}

export function normalizeDraft(value, { now = new Date().toISOString() } = {}) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new ValidationError("The saved draft is invalid.", "draft-type");
  }

  const title = normalizeDraftField(value.title, "Title", LIMITS.title);
  const body = normalizeDraftField(value.body, "Note text", LIMITS.body, true);
  const course = normalizeDraftField(value.course, "Course", LIMITS.course);
  const source = normalizeSource(value.source || {});
  if (!title.trim() && !body.trim() && !course.trim()) {
    return null;
  }

  return {
    sessionId:
      typeof value.sessionId === "string" && isValidIdentifier(value.sessionId)
        ? value.sessionId
        : "",
    noteId: value.noteId === undefined || value.noteId === null || value.noteId === ""
      ? null
      : normalizeIdentifier(value.noteId, () => {
          throw new ValidationError("The draft note ID is invalid.", "draft-id");
        }),
    baseRevision:
      Number.isSafeInteger(value.baseRevision) && value.baseRevision >= 0 ? value.baseRevision : 0,
    baseUpdatedAt: normalizeTimestamp(value.baseUpdatedAt, ""),
    title,
    body,
    course,
    source,
    updatedAt: normalizeTimestamp(value.updatedAt, normalizeTimestamp(now, new Date().toISOString())),
  };
}

export function createNote(
  value,
  {
    idFactory = () => crypto.randomUUID(),
    now = new Date().toISOString(),
    strictSourceUrl = false,
  } = {},
) {
  return normalizeNote(
    {
      ...value,
      id: generateIdentifier(idFactory),
      createdAt: now,
      updatedAt: now,
    },
    { idFactory, now, strictSourceUrl },
  );
}

export function noteFingerprint(note) {
  const normalized = normalizeNote(note, { idFactory: () => "fingerprint", now: note.createdAt });
  return JSON.stringify([
    normalized.body.normalize("NFKC"),
    normalized.course.normalize("NFKC").toLowerCase(),
    normalized.source.url,
  ]);
}

function nextRevision(state) {
  return Number.isSafeInteger(state.revision) ? state.revision + 1 : 1;
}

export function addNote(stateValue, input, options = {}) {
  const state = normalizeState(stateValue, options);
  if (state.notes.length >= LIMITS.notes) {
    throw new ValidationError("The note library is full. Export a backup before removing notes.", "notes-limit");
  }

  let note = createNote(input, options);
  const identifiers = new Set(state.notes.map((candidate) => candidate.id));
  if (identifiers.has(note.id)) {
    note = {
      ...note,
      id: allocateIdentifier(identifiers, options.idFactory || (() => crypto.randomUUID())),
    };
  }
  const fingerprint = noteFingerprint(note);
  const duplicate = state.notes.find((candidate) => noteFingerprint(candidate) === fingerprint) || null;
  if (duplicate && !options.allowDuplicate) {
    throw new ValidationError("An identical note already exists.", "duplicate");
  }

  return {
    state: {
      ...state,
      revision: nextRevision(state),
      notes: [note, ...state.notes],
    },
    note,
    duplicate,
  };
}

export function updateNote(stateValue, identifier, changes, options = {}) {
  const state = normalizeState(stateValue, options);
  const index = state.notes.findIndex((note) => note.id === identifier);
  if (index < 0) {
    throw new ValidationError("The note no longer exists.", "note-missing");
  }

  const existing = state.notes[index];
  const updated = normalizeNote(
    {
      ...existing,
      ...changes,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: options.now || new Date().toISOString(),
      source: changes.source ?? existing.source,
    },
    options,
  );
  const fingerprint = noteFingerprint(updated);
  const duplicate =
    state.notes.find(
      (candidate) => candidate.id !== identifier && noteFingerprint(candidate) === fingerprint,
    ) || null;
  if (duplicate && !options.allowDuplicate) {
    throw new ValidationError("An identical note already exists.", "duplicate");
  }

  const notes = [...state.notes];
  notes[index] = updated;
  return {
    state: { ...state, revision: nextRevision(state), notes },
    note: updated,
    duplicate,
  };
}

export function removeNote(stateValue, identifier, options = {}) {
  const state = normalizeState(stateValue, options);
  const index = state.notes.findIndex((note) => note.id === identifier);
  if (index < 0) {
    throw new ValidationError("The note no longer exists.", "note-missing");
  }

  const notes = [...state.notes];
  const [note] = notes.splice(index, 1);
  return {
    state: { ...state, revision: nextRevision(state), notes },
    note,
    index,
  };
}

export function restoreNote(stateValue, noteValue, index = 0, options = {}) {
  const state = normalizeState(stateValue, options);
  if (state.notes.length >= LIMITS.notes) {
    throw new ValidationError("The note library is full.", "notes-limit");
  }

  const note = normalizeNote(noteValue, options);
  if (state.notes.some((candidate) => candidate.id === note.id)) {
    throw new ValidationError("That note has already been restored.", "duplicate-id");
  }

  const targetIndex = Math.max(0, Math.min(Number.isInteger(index) ? index : 0, state.notes.length));
  const notes = [...state.notes];
  notes.splice(targetIndex, 0, note);
  return {
    state: { ...state, revision: nextRevision(state), notes },
    note,
  };
}

export function updateSettings(stateValue, changes, options = {}) {
  const state = normalizeState(stateValue, options);
  const theme = THEME_VALUES.includes(changes?.theme) ? changes.theme : state.settings.theme;
  const sort = SORT_VALUES.includes(changes?.sort) ? changes.sort : state.settings.sort;
  return {
    ...state,
    revision: nextRevision(state),
    settings: { theme, sort },
  };
}
