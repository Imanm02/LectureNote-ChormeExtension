import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import { readPageSelection } from "../src/capture.js";

function readSelection(dom, maximumLength) {
  return dom.window.eval(`(${readPageSelection.toString()})(${maximumLength})`);
}

test("does not capture selected password text", () => {
  const dom = new JSDOM(
    "<!doctype html><title>Sign in</title><input id='password' type='password' value='private-password'>",
    {
      url: "https://example.com/sign-in",
      pretendToBeVisual: true,
      runScripts: "outside-only",
    },
  );
  const password = dom.window.document.getElementById("password");
  password.focus();
  password.setSelectionRange(0, password.value.length);
  dom.window.getSelection = () => ({ toString: () => "masked-password" });

  const result = readSelection(dom, 100);

  assert.equal(result.text, "");
  assert.equal(result.wasTruncated, false);
  dom.window.close();
});

test("does not leave an unpaired surrogate when capture is truncated", () => {
  const dom = new JSDOM("<!doctype html><p id='text'>ab😀cd</p>", {
    url: "https://example.com/lecture",
    runScripts: "outside-only",
  });
  const range = dom.window.document.createRange();
  range.selectNodeContents(dom.window.document.getElementById("text"));
  const selection = dom.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  const result = readSelection(dom, 3);

  assert.equal(result.text, "ab");
  assert.equal(result.wasTruncated, true);
  assert.equal(result.text.includes("\ud83d"), false);
  dom.window.close();
});

test("marks the selected embedded frame as the focus owner", () => {
  const dom = new JSDOM("<!doctype html><title>Lecture</title><iframe id='player'></iframe>", {
    url: "https://example.com/lecture",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const frame = dom.window.document.getElementById("player");
  const frameWindow = frame.contentWindow;
  frameWindow.document.body.innerHTML = "<p id='caption'>Embedded فارسی text</p>";
  const range = frameWindow.document.createRange();
  range.selectNodeContents(frameWindow.document.getElementById("caption"));
  const selection = frameWindow.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  frame.focus();

  const topResult = readSelection(dom, 100);
  const frameResult = frameWindow.eval(`(${readPageSelection.toString()})(100)`);

  assert.equal(topResult.isFocused, false);
  assert.equal(frameResult.isFocused, true);
  assert.equal(topResult.frameDepth, 0);
  assert.equal(frameResult.frameDepth, 1);
  assert.equal(frameResult.text, "Embedded فارسی text");
  dom.window.close();
});

test("does not capture a password selected inside an embedded frame", () => {
  const dom = new JSDOM("<!doctype html><iframe id='player'></iframe>", {
    url: "https://example.com/lecture",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const frame = dom.window.document.getElementById("player");
  const frameWindow = frame.contentWindow;
  frameWindow.document.body.innerHTML =
    "<input id='password' type='password' value='embedded-private-value'>";
  const password = frameWindow.document.getElementById("password");
  password.focus();
  password.setSelectionRange(0, password.value.length);
  frame.focus();
  password.focus();
  frameWindow.getSelection = () => ({ toString: () => "exposed-password" });

  const result = frameWindow.eval(`(${readPageSelection.toString()})(100)`);

  assert.equal(result.text, "");
  assert.equal(result.wasTruncated, false);
  dom.window.close();
});
