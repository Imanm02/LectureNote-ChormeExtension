export function applyTheme(theme, documentValue = document) {
  const value = ["light", "dark"].includes(theme) ? theme : "system";
  documentValue.documentElement.dataset.theme = value;
}

export function setStatus(element, message, kind = "info") {
  element.textContent = message;
  element.dataset.kind = kind;
  element.setAttribute("role", kind === "error" ? "alert" : "status");
  element.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  element.setAttribute("aria-atomic", "true");
}

export function formatDate(value, locale) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "Unknown time";
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

export function noteToPlainText(note) {
  const sections = [note.title];
  if (note.course) {
    sections.push(`Course: ${note.course}`);
  }
  if (note.source.url) {
    sections.push(`Source: ${note.source.url}`);
  } else if (note.source.title) {
    sections.push(`Source: ${note.source.title}`);
  }
  sections.push(note.body);
  return sections.join("\n\n");
}

export function downloadText(
  text,
  filename,
  type,
  documentValue = document,
  urlApi = URL,
) {
  const blob = new Blob([text], { type });
  const url = urlApi.createObjectURL(blob);
  const link = documentValue.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  documentValue.body.append(link);
  link.click();
  link.remove();
  urlApi.revokeObjectURL(url);
}

export function backupFilename(extension, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return `lecture-notes-${day}.${extension}`;
}
