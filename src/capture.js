import { LIMITS } from "./model.js";

export class CaptureError extends Error {
  constructor(message, code = "capture-failed") {
    super(message);
    this.name = "CaptureError";
    this.code = code;
  }
}

export function readPageSelection(maximumLength) {
  const activeElement = document.activeElement;
  let text;
  const passwordField =
    activeElement instanceof HTMLInputElement && activeElement.type.toLowerCase() === "password";

  if (passwordField) {
    text = "";
  } else if (
    (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) &&
    typeof activeElement.selectionStart === "number" &&
    typeof activeElement.selectionEnd === "number"
  ) {
    text = activeElement.value.slice(activeElement.selectionStart, activeElement.selectionEnd);
  } else {
    text = window.getSelection()?.toString() || "";
  }

  text = text.replace(/\r\n?/gu, "\n").trim();
  const wasTruncated = text.length > maximumLength;
  let boundedText = wasTruncated ? text.slice(0, maximumLength) : text;
  const lastCodeUnit = boundedText.charCodeAt(boundedText.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    boundedText = boundedText.slice(0, -1);
  }

  let isFocused = activeElement?.tagName !== "IFRAME" && activeElement?.tagName !== "FRAME";
  let frameDepth = 0;
  try {
    let frameWindow = window;
    while (frameWindow !== frameWindow.top) {
      frameDepth += 1;
      const frameElement = frameWindow.frameElement;
      if (isFocused) {
        const frameRoot = frameElement?.getRootNode();
        const rootActiveElement = frameRoot?.activeElement;
        isFocused = Boolean(frameElement && rootActiveElement === frameElement);
      }
      frameWindow = frameWindow.parent;
    }
  } catch {
    isFocused = document.hasFocus();
  }

  return {
    text: boundedText,
    title: document.title || "",
    url: location.href,
    wasTruncated,
    isFocused,
    frameDepth,
  };
}

function normalizeInjectionResults(results, tab) {
  if (!Array.isArray(results)) {
    throw new CaptureError("The page did not return selection details.");
  }

  const frames = results.flatMap((entry, index) => {
    const result = entry?.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return [];
    }

    return [
      {
        frameId:
          Number.isInteger(entry.frameId) && entry.frameId >= 0
            ? entry.frameId
            : index === 0
              ? 0
              : Number.MAX_SAFE_INTEGER,
        index,
        text: typeof result.text === "string" ? result.text : "",
        title: typeof result.title === "string" ? result.title : null,
        url: typeof result.url === "string" ? result.url : null,
        wasTruncated: result.wasTruncated === true,
        isFocused: result.isFocused === true,
        hasFocusMetadata: typeof result.isFocused === "boolean",
        frameDepth:
          Number.isSafeInteger(result.frameDepth) && result.frameDepth >= 0
            ? result.frameDepth
            : 0,
      },
    ];
  });

  if (frames.length === 0) {
    throw new CaptureError("The page did not return selection details.");
  }

  const topFrame = frames.find((frame) => frame.frameId === 0);
  const framesWithSelection = frames.filter((frame) => frame.text.length > 0);
  const hasFocusMetadata = frames.some((frame) => frame.hasFocusMetadata);
  const selectedFrame = (hasFocusMetadata
    ? framesWithSelection.filter((frame) => frame.isFocused)
    : framesWithSelection
  )
    .sort(
      (left, right) =>
        Number(right.isFocused) - Number(left.isFocused) ||
        right.frameDepth - left.frameDepth ||
        left.frameId - right.frameId ||
        left.index - right.index,
    )[0];

  return {
    text: selectedFrame?.text || "",
    title: topFrame?.title ?? (typeof tab.title === "string" ? tab.title : ""),
    url: topFrame?.url ?? (typeof tab.url === "string" ? tab.url : ""),
    wasTruncated: selectedFrame?.wasTruncated === true,
  };
}

export async function captureActivePage(chromeApi = chrome, maximumLength = LIMITS.body) {
  let tabs;
  try {
    tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
  } catch (error) {
    throw new CaptureError(error instanceof Error ? error.message : "The active tab could not be read.");
  }

  const tab = tabs[0];
  if (!Number.isInteger(tab?.id)) {
    throw new CaptureError("No active browser tab was found.", "tab-missing");
  }

  try {
    const results = await chromeApi.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: readPageSelection,
      args: [maximumLength],
    });
    return normalizeInjectionResults(results, tab);
  } catch (error) {
    if (error instanceof CaptureError) {
      throw error;
    }
    throw new CaptureError(
      "Chrome does not allow selection capture on this page. You can still type a note.",
      "restricted-page",
    );
  }
}
