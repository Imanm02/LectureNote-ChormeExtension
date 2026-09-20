import { SORT_VALUES } from "./model.js";

function searchText(value) {
  return value.normalize("NFKC").toLowerCase();
}

function compareIdentifiers(left, right) {
  return left.id.localeCompare(right.id);
}

export function selectNotes(notes, { query = "", course = "", sort = "updated-desc" } = {}) {
  const normalizedQuery = searchText(String(query).trim());
  const normalizedCourse = searchText(String(course).trim());
  const selected = notes.filter((note) => {
    const courseMatches = !normalizedCourse || searchText(note.course) === normalizedCourse;
    if (!courseMatches) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }

    return [
      note.title,
      note.body,
      note.course,
      note.source.title,
      note.source.url,
    ].some((value) => searchText(value).includes(normalizedQuery));
  });

  const chosenSort = SORT_VALUES.includes(sort) ? sort : "updated-desc";
  return [...selected].sort((left, right) => {
    if (chosenSort === "title-asc") {
      return (
        left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) ||
        compareIdentifiers(left, right)
      );
    }
    if (chosenSort === "created-asc") {
      return Date.parse(left.createdAt) - Date.parse(right.createdAt) || compareIdentifiers(left, right);
    }
    if (chosenSort === "created-desc") {
      return Date.parse(right.createdAt) - Date.parse(left.createdAt) || compareIdentifiers(left, right);
    }
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || compareIdentifiers(left, right);
  });
}

export function listCourses(notes) {
  const values = new Map();
  for (const note of notes) {
    if (!note.course) {
      continue;
    }
    const key = searchText(note.course);
    if (!values.has(key)) {
      values.set(key, note.course);
    }
  }
  return [...values.values()].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}
