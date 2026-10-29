import assert from "node:assert/strict";
import test from "node:test";

import { notesToMarkdown } from "../src/backup.js";
import { createNote } from "../src/model.js";
import { noteToPlainText } from "../src/ui.js";

const START = "2026-09-20T10:00:00.000Z";

function sourceNote() {
  return createNote(
    {
      title: "Lecture note",
      body: "A useful explanation",
      course: "CS 101",
      source: {
        title: "Lecture page",
        url: "https://example.com/unit",
      },
    },
    { idFactory: () => "note-1", now: START },
  );
}

test("omits source details from privacy-safe sharing formats", () => {
  const note = sourceNote();
  const privateMarkdown = notesToMarkdown([note], { includeSource: false });
  const privateText = noteToPlainText(note, { includeSource: false });

  assert.doesNotMatch(privateMarkdown, /Lecture page|example\.com\/unit/u);
  assert.doesNotMatch(privateText, /Lecture page|example\.com\/unit/u);
  assert.match(privateMarkdown, /A useful explanation/u);
  assert.match(privateText, /A useful explanation/u);
  assert.match(notesToMarkdown([note]), /Lecture page/u);
  assert.match(noteToPlainText(note), /example\.com\/unit/u);
});
