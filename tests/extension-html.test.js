import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import { validateHtmlAccessibility } from "../scripts/extension-html.mjs";

function documentFrom(body) {
  return new JSDOM(`<!doctype html><html><body>${body}</body></html>`).window.document;
}

test("accessibility validation accepts associated labels and safe links", () => {
  const documentValue = documentFrom(`
    <p id="hint">Use a short title.</p>
    <label for="title">Title</label>
    <input id="title" aria-describedby="hint">
    <button type="button" aria-label="Save"></button>
    <a href="page.html" target="_blank" rel="noreferrer">Open</a>
  `);

  assert.doesNotThrow(() => validateHtmlAccessibility(documentValue, "test.html"));
});

test("accessibility validation rejects duplicate IDs", () => {
  const documentValue = documentFrom('<p id="same"></p><p id="same"></p>');

  assert.throws(
    () => validateHtmlAccessibility(documentValue, "test.html"),
    /duplicate ID: same/u,
  );
});

test("accessibility validation rejects missing ARIA references", () => {
  const documentValue = documentFrom('<section aria-labelledby="missing"></section>');

  assert.throws(
    () => validateHtmlAccessibility(documentValue, "test.html"),
    /missing aria-labelledby target: missing/u,
  );
});

test("accessibility validation rejects unlabeled controls", () => {
  const documentValue = documentFrom('<input id="title">');

  assert.throws(
    () => validateHtmlAccessibility(documentValue, "test.html"),
    /input#title needs an accessible label/u,
  );
});

test("accessibility validation rejects unnamed buttons", () => {
  const documentValue = documentFrom('<button type="button"></button>');

  assert.throws(
    () => validateHtmlAccessibility(documentValue, "test.html"),
    /button needs an accessible name/u,
  );
});

test("accessibility validation rejects unsafe new-tab links", () => {
  const documentValue = documentFrom('<a href="page.html" target="_blank">Open</a>');

  assert.throws(
    () => validateHtmlAccessibility(documentValue, "test.html"),
    /opens a tab without a safe rel value/u,
  );
});
