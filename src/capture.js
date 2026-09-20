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
  return {
    text: boundedText,
    title: document.title || "",
    url: location.href,
    wasTruncated,
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
      target: { tabId: tab.id },
      func: readPageSelection,
      args: [maximumLength],
    });
    const result = results[0]?.result;
    if (!result || typeof result !== "object") {
      throw new CaptureError("The page did not return selection details.");
    }
    return {
      text: typeof result.text === "string" ? result.text : "",
      title: typeof result.title === "string" ? result.title : "",
      url: typeof result.url === "string" ? result.url : "",
      wasTruncated: result.wasTruncated === true,
    };
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
