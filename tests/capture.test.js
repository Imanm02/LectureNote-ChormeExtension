import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import { captureActivePage, CaptureError, readPageSelection } from "../src/capture.js";

test("captures a focused frame and keeps top-level page details", async () => {
  let request;
  const chromeApi = {
    tabs: {
      async query() {
        return [{ id: 42, title: "Tab title", url: "https://example.com/from-tab" }];
      },
    },
    scripting: {
      async executeScript(value) {
        request = value;
        return [
          {
            frameId: 0,
            result: {
              text: "Old top-level selection",
              title: "Lecture",
              url: "https://example.com/lecture",
              wasTruncated: false,
              isFocused: false,
              frameDepth: 0,
            },
          },
          {
            frameId: 8,
            result: {
              text: "Selected frame text",
              title: "Embedded player",
              url: "https://example.com/player",
              wasTruncated: true,
              isFocused: true,
              frameDepth: 1,
            },
          },
        ];
      },
    },
  };

  const result = await captureActivePage(chromeApi, 500);
  assert.deepEqual(request.target, { tabId: 42, allFrames: true });
  assert.deepEqual(request.args, [500]);
  assert.deepEqual(result, {
    text: "Selected frame text",
    title: "Lecture",
    url: "https://example.com/lecture",
    wasTruncated: true,
  });
});

test("orders multiple focused frame selections by frame ID", async () => {
  const chromeApi = {
    tabs: { async query() { return [{ id: 42 }]; } },
    scripting: {
      async executeScript() {
        return [
          {
            frameId: 0,
            result: { text: "", title: "Lecture", url: "https://example.com", isFocused: false },
          },
          {
            frameId: 9,
            result: { text: "Later frame", isFocused: true },
          },
          {
            frameId: 3,
            result: { text: "Earlier frame", isFocused: true },
          },
        ];
      },
    },
  };

  const result = await captureActivePage(chromeApi);

  assert.equal(result.text, "Earlier frame");
});

test("prefers the deepest focused frame", async () => {
  const chromeApi = {
    tabs: { async query() { return [{ id: 42 }]; } },
    scripting: {
      async executeScript() {
        return [
          {
            frameId: 0,
            result: {
              text: "Parent selection",
              title: "Lecture",
              url: "https://example.com",
              isFocused: true,
              frameDepth: 0,
            },
          },
          {
            frameId: 5,
            result: { text: "Nested selection", isFocused: true, frameDepth: 2 },
          },
        ];
      },
    },
  };

  const result = await captureActivePage(chromeApi);

  assert.equal(result.text, "Nested selection");
});

test("does not use a stale selection when the focused frame is empty", async () => {
  const chromeApi = {
    tabs: { async query() { return [{ id: 42 }]; } },
    scripting: {
      async executeScript() {
        return [
          {
            frameId: 0,
            result: {
              text: "",
              title: "Lecture",
              url: "https://example.com",
              isFocused: false,
            },
          },
          { frameId: 2, result: { text: "", isFocused: true } },
          { frameId: 7, result: { text: "Available selection", isFocused: false } },
        ];
      },
    },
  };

  const result = await captureActivePage(chromeApi);

  assert.equal(result.text, "");
  assert.equal(result.wasTruncated, false);
});

test("supports a main-frame result without focus metadata", async () => {
  const chromeApi = {
    tabs: { async query() { return [{ id: 42 }]; } },
    scripting: {
      async executeScript() {
        return [
          {
            frameId: 0,
            result: {
              text: "Legacy selection",
              title: "Lecture",
              url: "https://example.com",
            },
          },
        ];
      },
    },
  };

  const result = await captureActivePage(chromeApi);

  assert.equal(result.text, "Legacy selection");
});

test("uses tab details when the main frame result is malformed", async () => {
  const chromeApi = {
    tabs: {
      async query() {
        return [{ id: 42, title: "Tab title", url: "https://example.com/top" }];
      },
    },
    scripting: {
      async executeScript() {
        return [
          { frameId: 0, result: null },
          { frameId: 4, result: { text: "Frame selection", isFocused: true } },
          { frameId: 6, result: "invalid" },
        ];
      },
    },
  };

  const result = await captureActivePage(chromeApi);

  assert.deepEqual(result, {
    text: "Frame selection",
    title: "Tab title",
    url: "https://example.com/top",
    wasTruncated: false,
  });
});

test("rejects an injection response without frame details", async () => {
  const chromeApi = {
    tabs: { async query() { return [{ id: 42 }]; } },
    scripting: { async executeScript() { return [{ frameId: 0, result: null }]; } },
  };

  await assert.rejects(
    () => captureActivePage(chromeApi),
    (error) => error instanceof CaptureError && error.code === "capture-failed",
  );
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
  assert.equal(result.isFocused, true);
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
