import assert from "node:assert/strict";
import test from "node:test";

import { selectNotes } from "../src/selectors.js";

const EARLIER = "2026-09-20T10:00:00.000Z";
const LATER = "2026-09-20T11:00:00.000Z";

function note(identifier, overrides = {}) {
  return {
    id: identifier,
    title: "Untitled",
    body: "",
    course: "",
    source: { title: "", url: "" },
    createdAt: EARLIER,
    updatedAt: EARLIER,
    ...overrides,
  };
}

test("matches every query token across separate note fields", () => {
  const notes = [
    note("graph", {
      title: "Week four",
      body: "Graph paths and trees",
      course: "CS 101",
      source: { title: "Discrete mathematics", url: "https://example.com/lecture" },
      updatedAt: LATER,
    }),
    note("calculus", {
      title: "Limits",
      body: "Continuity and derivatives",
      course: "MATH 101",
    }),
  ];

  assert.deepEqual(
    selectNotes(notes, { query: "  cs\tGRAPH discrete  " }).map((entry) => entry.id),
    ["graph"],
  );
  assert.deepEqual(selectNotes(notes, { query: "graph missing" }), []);
});

test("treats Arabic and Persian yeh and kaf forms as equivalent", () => {
  const notes = [
    note("persian", {
      title: "یادگیری ماشین",
      body: "مدل خطی",
      course: "مکانیک",
    }),
  ];

  assert.deepEqual(
    selectNotes(notes, { query: "يادگيرى مكانيك" }).map((entry) => entry.id),
    ["persian"],
  );
  assert.deepEqual(
    selectNotes(notes, { course: "مكانيك" }).map((entry) => entry.id),
    ["persian"],
  );
});

test("ignores combining marks while searching", () => {
  const notes = [
    note("accented", {
      title: "Café review",
      body: "A résumé of naïve Bayes",
    }),
    note("plain", {
      title: "Other material",
      body: "Linear regression",
      updatedAt: LATER,
    }),
  ];

  assert.deepEqual(
    selectNotes(notes, { query: "CAFE resume naive" }).map((entry) => entry.id),
    ["accented"],
  );
});

test("keeps empty queries and existing sort behavior", () => {
  const notes = [
    note("older", { title: "Zeta" }),
    note("newer", { title: "Alpha", updatedAt: LATER }),
  ];

  assert.deepEqual(selectNotes(notes, { query: " \n\t " }).map((entry) => entry.id), [
    "newer",
    "older",
  ]);
  assert.deepEqual(
    selectNotes(notes, { query: "a", sort: "title-asc" }).map((entry) => entry.id),
    ["newer", "older"],
  );
});
