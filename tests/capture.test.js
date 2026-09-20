import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import { captureActivePage, CaptureError, readPageSelection } from "../src/capture.js";

test("captures the active tab with the expected script target", async () => {
  let request;
  const chromeApi = {
    tabs: { async query() { return [{ id: 42 }]; } },
    scripting: {
      async executeScript(value) {
        request = value;
        return [
          {
            result: {
              text: "Selected text",
              title: "Lecture",
              url: "https://example.com/lecture",
              wasTruncated: false,
            },
          },
        ];
      },
    },
  };

  const result = await captureActivePage(chromeApi, 500);
  assert.equal(request.target.tabId, 42);
  assert.deepEqual(request.args, [500]);
  assert.equal(result.text, "Selected text");
});

test("reports a missing tab and restricted page", async () => {
  await assert.rejects(
    () => captureActivePage({ tabs: { async query() { return []; } } }),
    (error) => error instanceof CaptureError && error.code === "tab-missing",
  );

  const chromeApi = {
    tabs: { async query() { return [{ id: 2 }]; } },
    scripting: { async executeScript() { throw new Error("Cannot access chrome:// page"); } },
  };
  await assert.rejects(
    () => captureActivePage(chromeApi),
    (error) => error instanceof CaptureError && error.code === "restricted-page",
  );
});

test("reads document selections and keeps Unicode text", () => {
  const dom = new JSDOM("<!doctype html><title>درس</title><p id='text'>English و فارسی 🎓</p>", {
    url: "https://example.com/course?token=secret",
    runScripts: "outside-only",
  });
  const textNode = dom.window.document.getElementById("text").firstChild;
  const range = dom.window.document.createRange();
  range.selectNodeContents(textNode);
  const selection = dom.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  const result = dom.window.eval(`(${readPageSelection.toString()})(100)`);
  assert.equal(result.text, "English و فارسی 🎓");
  assert.equal(result.title, "درس");
  assert.equal(result.wasTruncated, false);
});

test("reads input selections and enforces the capture limit", () => {
  const dom = new JSDOM("<!doctype html><input id='input' value='abcdefghij'>", {
    url: "https://example.com",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const input = dom.window.document.getElementById("input");
  input.focus();
  input.setSelectionRange(2, 9);

  const result = dom.window.eval(`(${readPageSelection.toString()})(4)`);
  assert.equal(result.text, "cdef");
  assert.equal(result.wasTruncated, true);
});
