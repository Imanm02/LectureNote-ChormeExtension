export const SCHEMA_VERSION = 2;

export const LIMITS = Object.freeze({
  identifier: 100,
  title: 160,
  body: 100_000,
  course: 80,
  sourceTitle: 200,
  sourceUrl: 2_048,
  captureUrl: 100_000,
  notes: 2_000,
  trash: 2_000,
  importBytes: 8_000_000,
  localStorageBytes: 10_485_760,
  stateBytes: 7_000_000,
  popupDraftBytes: 425_000,
  editorDraftBytes: 1_500_000,
  pendingCapturesBytes: 750_000,
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

const IDENTIFIER_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_-]{0,${LIMITS.identifier - 1}}$`, "u");
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

const SENSITIVE_QUERY_PARAMETER = /^(?:(?:access|auth|id|oauth|refresh|session)_?token|api_?key|auth|authorization|client_?secret|code|credential|fbclid|gclid|jsessionid|jwt|key|msclkid|pass|password|samlresponse|secret|session|session_?id|sig|signature|state|token|utm_.+|x-(?:amz|goog)-(?:credential|security-token|signature))$/iu;

function sanitizeParsedUrl(parsed) {
  parsed.username = "";
  parsed.password = "";
  for (const name of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_PARAMETER.test(name)) {
      parsed.searchParams.delete(name);
    }
  }
  parsed.hash = "";
  return parsed.href;
}

function sanitizeUnparsedDraftUrl(rawUrl) {
  const withoutCredentials = rawUrl.replace(
    /^([a-z][a-z\d+.-]*:\/\/)[^/?#@\s]+@/iu,
    "$1",
  );
  const fragmentIndex = withoutCredentials.indexOf("#");
  const withoutFragment = fragmentIndex === -1
    ? withoutCredentials
    : withoutCredentials.slice(0, fragmentIndex);
  const queryIndex = withoutFragment.indexOf("?");
  if (queryIndex === -1) {
    return withoutFragment;
  }
  const base = withoutFragment.slice(0, queryIndex);
  const retained = withoutFragment
    .slice(queryIndex + 1)
    .split("&")
    .filter((parameter) => {
      const rawName = parameter.split("=", 1)[0];
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replace(/\+/gu, " "));
      } catch {
        // Keep malformed parameter names unless they match directly.
      }
      return !SENSITIVE_QUERY_PARAMETER.test(name);
    });
  return retained.length > 0 ? `${base}?${retained.join("&")}` : base;
}

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

  const url = sanitizeParsedUrl(parsed);
  if (url.length > LIMITS.sourceUrl) {
    if (strictUrl) {
      throw new ValidationError(
        `Source URL must be ${LIMITS.sourceUrl.toLocaleString()} characters or fewer.`,
        "source-url-length",
      );
    }
    return { title, url: "" };
  }
  return { title, url };
}

export function createEmptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    notes: [],
    trash: [],
    settings: {
      theme: "system",
      sort: "updated-desc",
      includeSourceOnShare: true,
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

export function normalizeTrashEntry(
  value,
  {
    idFactory = () => crypto.randomUUID(),
    now = new Date().toISOString(),
  } = {},
) {
  if (!isRecord(value)) {
    throw new ValidationError("Each Trash entry must be an object.", "trash-entry-type");
  }

  const note = normalizeNote(value.note, { idFactory, now });
  const deletedAt = normalizeTimestamp(value.deletedAt, normalizeTimestamp(now, new Date().toISOString()));
  const originalIndex = Number.isSafeInteger(value.originalIndex) && value.originalIndex >= 0
    ? Math.min(value.originalIndex, LIMITS.notes)
    : 0;
  return { note, deletedAt, originalIndex };
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

  const trashValue = version >= 2 ? (value.trash ?? []) : [];
  if (!Array.isArray(trashValue)) {
    throw new ValidationError("The saved Trash list is invalid.", "trash-type");
  }
  if (trashValue.length > LIMITS.trash) {
    throw new ValidationError(
      `Trash can contain at most ${LIMITS.trash.toLocaleString()} notes.`,
      "trash-limit",
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
  const trash = trashValue.map((entry) => {
    const normalized = normalizeTrashEntry(entry, { idFactory, now });
    if (identifiers.has(normalized.note.id)) {
      normalized.note.id = allocateIdentifier(identifiers, idFactory);
    }
    identifiers.add(normalized.note.id);
    return normalized;
  });

  const settings = isRecord(value.settings) ? value.settings : {};
  const theme = THEME_VALUES.includes(settings.theme) ? settings.theme : "system";
  const sort = SORT_VALUES.includes(settings.sort) ? settings.sort : "updated-desc";
  const includeSourceOnShare = settings.includeSourceOnShare !== false;
  const revision = Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0;

  return {
    schemaVersion: SCHEMA_VERSION,
    revision,
    notes,
    trash,
    settings: { theme, sort, includeSourceOnShare },
  };
}

export function measureLibraryUsage(stateValue, options = {}) {
  const state = normalizeState(stateValue, options);
  const stateBytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  const hasMeasuredStorageBytes =
    Number.isSafeInteger(options.storageBytes) && options.storageBytes >= 0;
  const bytes = hasMeasuredStorageBytes ? options.storageBytes : stateBytes;
  const ratios = [
    bytes / LIMITS.localStorageBytes,
    stateBytes / LIMITS.stateBytes,
    state.notes.length / LIMITS.notes,
    state.trash.length / LIMITS.trash,
  ];
  const highestRatio = Math.max(...ratios);

  return {
    bytes,
    byteLimit: LIMITS.localStorageBytes,
    stateBytes,
    stateByteLimit: LIMITS.stateBytes,
    hasMeasuredStorageBytes,
    notes: state.notes.length,
    noteLimit: LIMITS.notes,
    trash: state.trash.length,
    trashLimit: LIMITS.trash,
    highestRatio,
    level: highestRatio >= 0.95 ? "critical" : highestRatio >= 0.8 ? "warning" : "normal",
  };
}

export function recoverState(value, options = {}) {
  if (!isRecord(value) || !Array.isArray(value.notes)) {
    throw new ValidationError("Saved note data cannot be recovered.", "state-unrecoverable");
  }
  const version = value.schemaVersion ?? value.version ?? SCHEMA_VERSION;
  if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION) {
    throw new ValidationError("This note data version is not supported.", "schema-version");
  }

  const accepted = [];
  const acceptedTrash = [];
  const rejected = [];
  value.notes.forEach((note, index) => {
    if (accepted.length >= LIMITS.notes) {
      rejected.push({ index, note, reason: "Library note limit exceeded" });
      return;
    }
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

  const trashValue = version >= 2 ? value.trash : [];
  if (trashValue !== undefined && !Array.isArray(trashValue)) {
    rejected.push({ index: -1, note: null, reason: "Trash list is invalid" });
  } else {
    (trashValue || []).forEach((entry, index) => {
      if (acceptedTrash.length >= LIMITS.trash) {
        rejected.push({ index, note: entry, reason: "Trash note limit exceeded" });
        return;
      }
      try {
        acceptedTrash.push(normalizeTrashEntry(entry, options));
      } catch (error) {
        rejected.push({
          index,
          note: entry,
          reason: error instanceof Error ? error.message : "Invalid Trash entry",
        });
      }
    });
  }

  const state = normalizeState(
    { ...value, schemaVersion: SCHEMA_VERSION, notes: accepted, trash: acceptedTrash },
    options,
  );
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

function normalizeEditorDraftSourceUrl(value) {
  const rawUrl = normalizeDraftField(value, "Source URL", LIMITS.sourceUrl);
  if (!rawUrl) {
    return "";
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Keep incomplete input so it can be resumed and corrected.
    return sanitizeUnparsedDraftUrl(rawUrl);
  }
  const sanitizedUrl = sanitizeParsedUrl(parsed);
  if (sanitizedUrl.length > LIMITS.sourceUrl) {
    throw new ValidationError(
      `Source URL must be ${LIMITS.sourceUrl.toLocaleString()} characters or fewer.`,
      "source-url-length",
    );
  }
  return sanitizedUrl;
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

export function normalizeEditorDraft(value, options = {}) {
  if (!isRecord(value)) {
    throw new ValidationError("The saved editor draft is invalid.", "editor-draft-type");
  }

  const title = normalizeDraftField(value.title, "Title", LIMITS.title);
  const body = normalizeDraftField(value.body, "Note text", LIMITS.body, true);
  const course = normalizeDraftField(value.course, "Course", LIMITS.course);
  const sourceValue = isRecord(value.source)
    ? value.source
    : { title: value.sourceTitle, url: value.sourceUrl };
  const source = {
    title: normalizeDraftField(sourceValue.title, "Source title", LIMITS.sourceTitle),
    url: normalizeEditorDraftSourceUrl(sourceValue.url),
  };
  const hasContent = [title, body, course, source.title, source.url].some((field) => field.trim());
  const noteId = value.noteId === undefined || value.noteId === null || value.noteId === ""
    ? null
    : normalizeIdentifier(value.noteId, () => {
        throw new ValidationError("The editor draft note ID is invalid.", "editor-draft-id");
      });
  if (!hasContent && !noteId) {
    return null;
  }

  let baseNote = null;
  if (noteId) {
    if (!isRecord(value.baseNote)) {
      throw new ValidationError("The editor draft is missing its original note.", "draft-base-note");
    }
    baseNote = normalizeNote(value.baseNote, options);
    if (baseNote.id !== noteId) {
      throw new ValidationError("The editor draft does not match its original note.", "draft-base-id");
    }
  }

  if (
    baseNote &&
    JSON.stringify({ title, body, course, source }) ===
      JSON.stringify({
        title: baseNote.title,
        body: baseNote.body,
        course: baseNote.course,
        source: baseNote.source,
      })
  ) {
    return null;
  }

  return {
    noteId,
    baseRevision:
      Number.isSafeInteger(value.baseRevision) && value.baseRevision >= 0 ? value.baseRevision : 0,
    baseNote,
    title,
    body,
    course,
    source,
    updatedAt: normalizeTimestamp(
      value.updatedAt,
      normalizeTimestamp(options.now, new Date().toISOString()),
    ),
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

function operationTimestamp(options = {}) {
  const fallback = new Date().toISOString();
  return normalizeTimestamp(options.now, fallback);
}

function timestampNotBeforeNotes(timestamp, notes) {
  return notes.reduce(
    (latest, note) => (Date.parse(note.createdAt) > Date.parse(latest) ? note.createdAt : latest),
    timestamp,
  );
}

export function normalizeCourseKey(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/\u200c/gu, "")
    .replace(/[\u0649\u064a]/gu, "\u06cc")
    .replace(/\u0643/gu, "\u06a9")
    .toLowerCase();
}

function normalizeSelectedIdentifiers(values) {
  if (!Array.isArray(values)) {
    throw new ValidationError("Choose notes before continuing.", "selection-type");
  }
  if (values.length === 0) {
    throw new ValidationError("Choose at least one note.", "selection-empty");
  }

  const identifiers = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string") {
      throw new ValidationError("Each selected note ID must be text.", "selection-id-type");
    }
    const identifier = stripUnsafeControls(value).trim();
    if (!isValidIdentifier(identifier)) {
      throw new ValidationError("A selected note ID is invalid.", "selection-id-invalid");
    }
    if (seen.has(identifier)) {
      throw new ValidationError("A note was selected more than once.", "selection-id-duplicate");
    }
    seen.add(identifier);
    identifiers.push(identifier);
  }
  return identifiers;
}

function selectExistingRecords(records, identifiers, identifierOf, message, code) {
  const requested = new Set(identifiers);
  const selected = records.filter((record) => requested.has(identifierOf(record)));
  if (selected.length !== identifiers.length) {
    throw new ValidationError(message, code);
  }
  return selected;
}

function noteWithCourse(note, course, now) {
  return {
    ...note,
    course,
    updatedAt: now,
  };
}

export function addNote(stateValue, input, options = {}) {
  const state = normalizeState(stateValue, options);
  if (state.notes.length >= LIMITS.notes) {
    throw new ValidationError("The note library is full. Export a backup before removing notes.", "notes-limit");
  }

  let note = createNote(input, options);
  const identifiers = new Set([
    ...state.notes.map((candidate) => candidate.id),
    ...state.trash.map((entry) => entry.note.id),
  ]);
  if (identifiers.has(note.id)) {
    note = {
      ...note,
      id: allocateIdentifier(identifiers, options.idFactory || (() => crypto.randomUUID())),
    };
  }
  const fingerprint = noteFingerprint(note);
  const duplicate = state.notes.find((candidate) => noteFingerprint(candidate) === fingerprint) || null;
  if (duplicate && !options.allowDuplicate) {
    throw new ValidationError("A note with the same text, course, and source URL already exists.", "duplicate");
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
    throw new ValidationError("A note with the same text, course, and source URL already exists.", "duplicate");
  }

  const notes = [...state.notes];
  notes[index] = updated;
  return {
    state: { ...state, revision: nextRevision(state), notes },
    note: updated,
    duplicate,
  };
}

export function renameCourse(stateValue, courseValue, replacementValue, options = {}) {
  const now = operationTimestamp(options);
  const state = normalizeState(stateValue, { ...options, now });
  const course = normalizeSingleLine(courseValue, "Course", LIMITS.course, { required: true });
  const requestedReplacement = normalizeSingleLine(replacementValue, "Course", LIMITS.course);
  const courseKey = normalizeCourseKey(course);
  const requestedReplacementKey = normalizeCourseKey(requestedReplacement);
  const existingReplacement = requestedReplacementKey && requestedReplacementKey !== courseKey
    ? [...state.notes, ...state.trash.map((entry) => entry.note)].find(
        (note) => normalizeCourseKey(note.course) === requestedReplacementKey,
      )
    : null;
  const replacement = existingReplacement?.course || requestedReplacement;
  const matchingNotes = state.notes.filter((note) => normalizeCourseKey(note.course) === courseKey);
  const matchingEntries = state.trash.filter(
    (entry) => normalizeCourseKey(entry.note.course) === courseKey,
  );
  if (matchingNotes.length + matchingEntries.length === 0) {
    throw new ValidationError("That course no longer exists.", "course-missing");
  }

  const changedNoteIds = new Set(
    matchingNotes.filter((note) => note.course !== replacement).map((note) => note.id),
  );
  const changedTrashIds = new Set(
    matchingEntries
      .filter((entry) => entry.note.course !== replacement)
      .map((entry) => entry.note.id),
  );
  if (changedNoteIds.size + changedTrashIds.size === 0) {
    throw new ValidationError("That course already has this name.", "course-unchanged");
  }

  const updatedAt = timestampNotBeforeNotes(now, [
    ...matchingNotes.filter((note) => changedNoteIds.has(note.id)),
    ...matchingEntries
      .filter((entry) => changedTrashIds.has(entry.note.id))
      .map((entry) => entry.note),
  ]);

  const notes = state.notes.map((note) =>
    changedNoteIds.has(note.id) ? noteWithCourse(note, replacement, updatedAt) : note,
  );
  const trash = state.trash.map((entry) =>
    changedTrashIds.has(entry.note.id)
      ? { ...entry, note: noteWithCourse(entry.note, replacement, updatedAt) }
      : entry,
  );
  const changedNotes = notes.filter((note) => changedNoteIds.has(note.id));
  const changedEntries = trash.filter((entry) => changedTrashIds.has(entry.note.id));

  return {
    state: { ...state, revision: nextRevision(state), notes, trash },
    course,
    replacement,
    changed: changedNotes.length + changedEntries.length,
    activeChanged: changedNotes.length,
    trashChanged: changedEntries.length,
    notes: changedNotes,
    entries: changedEntries,
  };
}

export function assignCourseToNotes(stateValue, identifierValues, courseValue, options = {}) {
  const now = operationTimestamp(options);
  const state = normalizeState(stateValue, { ...options, now });
  const identifiers = normalizeSelectedIdentifiers(identifierValues);
  const selected = selectExistingRecords(
    state.notes,
    identifiers,
    (note) => note.id,
    "A selected note no longer exists.",
    "note-missing",
  );
  const course = normalizeSingleLine(courseValue, "Course", LIMITS.course);
  const changedIds = new Set(
    selected.filter((note) => note.course !== course).map((note) => note.id),
  );
  if (changedIds.size === 0) {
    throw new ValidationError("The selected notes already use that course.", "course-unchanged");
  }

  const updatedAt = timestampNotBeforeNotes(
    now,
    selected.filter((note) => changedIds.has(note.id)),
  );

  const notes = state.notes.map((note) =>
    changedIds.has(note.id) ? noteWithCourse(note, course, updatedAt) : note,
  );
  const selectedIds = new Set(identifiers);
  const affectedNotes = notes.filter((note) => selectedIds.has(note.id));
  const changedNotes = affectedNotes.filter((note) => changedIds.has(note.id));

  return {
    state: { ...state, revision: nextRevision(state), notes },
    course,
    assigned: changedNotes.length,
    unchanged: affectedNotes.length - changedNotes.length,
    notes: affectedNotes,
    changedNotes,
  };
}

export function moveNoteToTrash(stateValue, identifier, options = {}) {
  const state = normalizeState(stateValue, options);
  const index = state.notes.findIndex((note) => note.id === identifier);
  if (index < 0) {
    throw new ValidationError("The note no longer exists.", "note-missing");
  }
  if (state.trash.length >= LIMITS.trash) {
    throw new ValidationError(
      "Trash is full. Permanently delete a note from Trash before removing another note.",
      "trash-limit",
    );
  }

  const notes = [...state.notes];
  const [note] = notes.splice(index, 1);
  const entry = {
    note,
    deletedAt: normalizeTimestamp(options.now, new Date().toISOString()),
    originalIndex: index,
  };
  return {
    state: { ...state, revision: nextRevision(state), notes, trash: [entry, ...state.trash] },
    note,
    entry,
    index,
  };
}

export function moveNotesToTrash(stateValue, identifierValues, options = {}) {
  const now = operationTimestamp(options);
  const state = normalizeState(stateValue, { ...options, now });
  const identifiers = normalizeSelectedIdentifiers(identifierValues);
  const selected = selectExistingRecords(
    state.notes,
    identifiers,
    (note) => note.id,
    "A selected note no longer exists.",
    "note-missing",
  );
  if (state.trash.length + selected.length > LIMITS.trash) {
    throw new ValidationError(
      "Trash does not have enough room for the selected notes.",
      "trash-limit",
    );
  }

  const selectedIds = new Set(identifiers);
  const indexes = new Map(state.notes.map((note, index) => [note.id, index]));
  const deletedAt = timestampNotBeforeNotes(now, selected);
  const entries = selected.map((note) => ({
    note,
    deletedAt,
    originalIndex: indexes.get(note.id),
  }));
  const notes = state.notes.filter((note) => !selectedIds.has(note.id));

  return {
    state: {
      ...state,
      revision: nextRevision(state),
      notes,
      trash: [...entries, ...state.trash],
    },
    moved: entries.length,
    notes: selected,
    entries,
  };
}

export function restoreTrashedNote(stateValue, identifier, options = {}) {
  const state = normalizeState(stateValue, options);
  if (state.notes.length >= LIMITS.notes) {
    throw new ValidationError("The note library is full.", "notes-limit");
  }

  const trashIndex = state.trash.findIndex((entry) => entry.note.id === identifier);
  if (trashIndex < 0) {
    throw new ValidationError("The note is no longer in Trash.", "trash-note-missing");
  }
  const entry = state.trash[trashIndex];
  const note = entry.note;
  if (state.notes.some((candidate) => candidate.id === note.id)) {
    throw new ValidationError("That note has already been restored.", "duplicate-id");
  }

  const targetIndex = Math.max(0, Math.min(entry.originalIndex, state.notes.length));
  const notes = [...state.notes];
  notes.splice(targetIndex, 0, note);
  const trash = [...state.trash];
  trash.splice(trashIndex, 1);
  return {
    state: { ...state, revision: nextRevision(state), notes, trash },
    note,
    entry,
  };
}

export function restoreTrashedNotes(stateValue, identifierValues, options = {}) {
  const now = operationTimestamp(options);
  const state = normalizeState(stateValue, { ...options, now });
  const identifiers = normalizeSelectedIdentifiers(identifierValues);
  const selected = selectExistingRecords(
    state.trash,
    identifiers,
    (entry) => entry.note.id,
    "A selected note is no longer in Trash.",
    "trash-note-missing",
  );
  if (state.notes.length + selected.length > LIMITS.notes) {
    throw new ValidationError("The note library does not have enough room.", "notes-limit");
  }

  const activeIdentifiers = new Set(state.notes.map((note) => note.id));
  if (selected.some((entry) => activeIdentifiers.has(entry.note.id))) {
    throw new ValidationError("A selected note has already been restored.", "duplicate-id");
  }

  const selectedIds = new Set(identifiers);
  const reconstructed = [...state.notes];
  for (const entry of state.trash) {
    const targetIndex = Math.max(0, Math.min(entry.originalIndex, reconstructed.length));
    reconstructed.splice(targetIndex, 0, entry.note);
  }
  const notes = reconstructed.filter(
    (note) => activeIdentifiers.has(note.id) || selectedIds.has(note.id),
  );
  const trash = state.trash.filter((entry) => !selectedIds.has(entry.note.id));
  const restoredNotes = notes.filter((note) => selectedIds.has(note.id));

  return {
    state: { ...state, revision: nextRevision(state), notes, trash },
    restored: selected.length,
    notes: restoredNotes,
    entries: selected,
  };
}

export function permanentlyDeleteTrashedNote(stateValue, identifier, options = {}) {
  const state = normalizeState(stateValue, options);
  const index = state.trash.findIndex((entry) => entry.note.id === identifier);
  if (index < 0) {
    throw new ValidationError("The note is no longer in Trash.", "trash-note-missing");
  }
  const trash = [...state.trash];
  const [entry] = trash.splice(index, 1);
  return {
    state: { ...state, revision: nextRevision(state), trash },
    entry,
  };
}

export function permanentlyDeleteTrashedNotes(stateValue, identifierValues, options = {}) {
  const now = operationTimestamp(options);
  const state = normalizeState(stateValue, { ...options, now });
  const identifiers = normalizeSelectedIdentifiers(identifierValues);
  const selected = selectExistingRecords(
    state.trash,
    identifiers,
    (entry) => entry.note.id,
    "A selected note is no longer in Trash.",
    "trash-note-missing",
  );
  const selectedIds = new Set(identifiers);
  const trash = state.trash.filter((entry) => !selectedIds.has(entry.note.id));

  return {
    state: { ...state, revision: nextRevision(state), trash },
    deleted: selected.length,
    entries: selected,
  };
}

export function emptyTrash(stateValue, options = {}) {
  const state = normalizeState(stateValue, options);
  if (state.trash.length === 0) {
    return { state, deleted: 0 };
  }
  return {
    state: { ...state, revision: nextRevision(state), trash: [] },
    deleted: state.trash.length,
  };
}

export function updateSettings(stateValue, changes, options = {}) {
  const state = normalizeState(stateValue, options);
  const theme = THEME_VALUES.includes(changes?.theme) ? changes.theme : state.settings.theme;
  const sort = SORT_VALUES.includes(changes?.sort) ? changes.sort : state.settings.sort;
  const includeSourceOnShare = typeof changes?.includeSourceOnShare === "boolean"
    ? changes.includeSourceOnShare
    : state.settings.includeSourceOnShare;
  return {
    ...state,
    revision: nextRevision(state),
    settings: { theme, sort, includeSourceOnShare },
  };
}
