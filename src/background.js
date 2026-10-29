import {
  isValidIdentifier,
  LIMITS,
  normalizeSource,
  ValidationError,
} from "./model.js";
import { MESSAGE_TYPES } from "./messages.js";
import {
  enqueuePendingCapture,
  loadDataConsent,
  removePendingCapture,
  saveEditorDraft,
  savePopupDraft,
} from "./storage.js";

export const CAPTURE_CONTEXT_MENU_ID = "save-selection-to-lecture-notes";
let contextMenuRegistrationQueue = Promise.resolve();

export function isAuthorizedDraftMessage(message, sender, runtimeId) {
  return (
    [MESSAGE_TYPES.saveDraft, MESSAGE_TYPES.saveEditorDraft].includes(message?.type) &&
    isValidIdentifier(message?.expectedEpoch) &&
    typeof runtimeId === "string" &&
    sender?.id === runtimeId
  );
}

export async function handleDraftMessage(message, sender, storage, runtimeId) {
  if (!isAuthorizedDraftMessage(message, sender, runtimeId)) {
    return { handled: false };
  }
  if (!(await loadDataConsent(storage, { expectedEpoch: message.expectedEpoch }))) {
    throw new ValidationError(
      "Local note capture has not been allowed.",
      "consent-required",
    );
  }
  if (message.type === MESSAGE_TYPES.saveEditorDraft) {
    const result = await saveEditorDraft(message.draft, storage, {
      sessionId: message.sessionId,
      expectedOwnerSessionId: message.expectedOwnerSessionId,
      expectedGeneration: message.expectedGeneration,
      contentGeneration: message.contentGeneration,
      expectedEpoch: message.expectedEpoch,
    });
    return {
      handled: true,
      saved: result.saved,
      cursor: {
        ownerSessionId: result.record.ownerSessionId,
        generation: result.record.generation,
        contentGeneration: result.record.contentGeneration,
        hasDraft: Boolean(result.record.draft),
      },
    };
  }
  const result = await savePopupDraft(message.draft, storage, {
    sessionId: message.sessionId,
    expectedOwnerSessionId: message.expectedOwnerSessionId,
    expectedGeneration: message.expectedGeneration,
    contentGeneration: message.contentGeneration,
    expectedEpoch: message.expectedEpoch,
  });
  if (result.saved && message.pendingCaptureId) {
    await removePendingCapture(message.pendingCaptureId, storage, {
      expectedEpoch: message.expectedEpoch,
    });
  }
  return {
    handled: true,
    saved: result.saved,
    cursor: {
      ownerSessionId: result.record.ownerSessionId,
      generation: result.record.generation,
      contentGeneration: result.record.contentGeneration,
      hasDraft: Boolean(result.record.draft),
    },
  };
}

function runContextMenuMethod(contextMenus, method, args, runtime) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const callback = () => {
      const lastError = runtime?.lastError;
      finish(lastError ? new Error(lastError.message) : null);
    };

    try {
      const result = contextMenus[method](...args, callback);
      if (result && typeof result.then === "function") {
        result.then(() => finish(), finish);
      }
    } catch (error) {
      finish(error);
    }
  });
}

function isMissingContextMenuError(error) {
  return error instanceof Error && /cannot find|does not exist|not found/iu.test(error.message);
}

async function removeCaptureContextMenuDirect(contextMenus, runtime) {
  try {
    await runContextMenuMethod(
      contextMenus,
      "remove",
      [CAPTURE_CONTEXT_MENU_ID],
      runtime,
    );
  } catch (error) {
    if (!isMissingContextMenuError(error)) {
      throw error;
    }
  }
}

export function ensureCaptureContextMenu(
  contextMenus = chrome.contextMenus,
  runtime = chrome.runtime,
) {
  const register = async () => {
    await removeCaptureContextMenuDirect(contextMenus, runtime);
    await runContextMenuMethod(
      contextMenus,
      "create",
      [
        {
          id: CAPTURE_CONTEXT_MENU_ID,
          title: "Capture selection in Lecture Notes",
          contexts: ["selection"],
        },
      ],
      runtime,
    );
  };
  const operation = contextMenuRegistrationQueue.then(register, register);
  contextMenuRegistrationQueue = operation.catch(() => undefined);
  return operation;
}

export function removeCaptureContextMenu(
  contextMenus = chrome.contextMenus,
  runtime = chrome.runtime,
) {
  const remove = () => removeCaptureContextMenuDirect(contextMenus, runtime);
  const operation = contextMenuRegistrationQueue.then(remove, remove);
  contextMenuRegistrationQueue = operation.catch(() => undefined);
  return operation;
}

export function syncCaptureContextMenu(
  storage = chrome.storage.local,
  contextMenus = chrome.contextMenus,
  runtime = chrome.runtime,
) {
  const sync = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await removeCaptureContextMenuDirect(contextMenus, runtime);
      const acceptedEpoch = await loadDataConsent(storage);
      if (acceptedEpoch) {
        await runContextMenuMethod(
          contextMenus,
          "create",
          [
            {
              id: CAPTURE_CONTEXT_MENU_ID,
              title: "Capture selection in Lecture Notes",
              contexts: ["selection"],
            },
          ],
          runtime,
        );
      }
      const current = await loadDataConsent(storage);
      if (current === acceptedEpoch) {
        return Boolean(acceptedEpoch);
      }
    }
    await removeCaptureContextMenuDirect(contextMenus, runtime);
    return false;
  };
  const operation = contextMenuRegistrationQueue.then(sync, sync);
  contextMenuRegistrationQueue = operation.catch(() => undefined);
  return operation;
}

function stripUnsafeSelectionControls(value) {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      const allowedWhitespace = codePoint === 9 || codePoint === 10 || codePoint === 13;
      const control = (codePoint <= 31 && !allowedWhitespace) ||
        (codePoint >= 127 && codePoint <= 159);
      const bidirectionalOverride =
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069);
      return !control && !bidirectionalOverride;
    })
    .join("");
}

function safeTextPrefix(value, maximumLength) {
  let result = value.slice(0, maximumLength);
  const lastCodeUnit = result.charCodeAt(result.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    result = result.slice(0, -1);
  }
  return result;
}

export function normalizeContextSelection(value, maximumLength = LIMITS.body) {
  if (typeof value !== "string") {
    return { text: "", wasTruncated: false };
  }
  const normalized = stripUnsafeSelectionControls(value.replace(/\r\n?/gu, "\n")).trim();
  return {
    text: safeTextPrefix(normalized, maximumLength),
    wasTruncated: normalized.length > maximumLength,
  };
}

export async function captureContextSelection(
  info,
  tab,
  storage = chrome.storage.local,
  captureIdFactory = () => `context-menu-${crypto.randomUUID()}`,
  { expectedConsentEpoch } = {},
) {
  const acceptedEpoch = await loadDataConsent(
    storage,
    expectedConsentEpoch ? { expectedEpoch: expectedConsentEpoch } : {},
  );
  if (!acceptedEpoch || (expectedConsentEpoch && acceptedEpoch !== expectedConsentEpoch)) {
    throw new ValidationError(
      "Local note capture has not been allowed.",
      "consent-required",
    );
  }
  const selection = normalizeContextSelection(info?.selectionText);
  if (!selection.text) {
    return { saved: false, reason: "empty-selection", wasTruncated: false };
  }

  const title = safeTextPrefix(typeof tab?.title === "string" ? tab.title : "", LIMITS.sourceTitle);
  const rawUrl = [info?.pageUrl, info?.frameUrl, tab?.url].find(
    (value) => typeof value === "string" && value.length <= LIMITS.captureUrl,
  );
  const source = normalizeSource({ title, url: rawUrl || "" });
  const result = await enqueuePendingCapture(
    {
      id: captureIdFactory(),
      title: source.title.slice(0, LIMITS.title),
      text: selection.text,
      url: source.url,
      wasTruncated: selection.wasTruncated,
    },
    storage,
    { expectedEpoch: acceptedEpoch },
  );

  return {
    saved: true,
    reason: "queued",
    wasTruncated: selection.wasTruncated,
    capture: result.capture,
    queueLength: result.captures.length,
  };
}

export async function openCaptureSurface(
  chromeApi = chrome,
  { captureQueued = true } = {},
) {
  const popupUrl = chromeApi.runtime.getURL("popup.html");
  const failureMessage = captureQueued
    ? "The captured selection was queued, but its editor could not open."
    : "Lecture Notes could not open the consent gate.";
  let windowError = null;
  if (typeof chromeApi.windows?.create === "function") {
    try {
      await chromeApi.windows.create({
        url: popupUrl,
        type: "popup",
        width: 430,
        height: 650,
        focused: true,
      });
      return "popup-window";
    } catch (error) {
      windowError = error;
    }
  }

  if (typeof chromeApi.tabs?.create === "function") {
    try {
      await chromeApi.tabs.create({ url: popupUrl });
      return "tab";
    } catch (error) {
      const detail = windowError
        ? `${windowError instanceof Error ? windowError.message : "Popup window failed"}. ` +
          `${error instanceof Error ? error.message : "Tab failed."}`
        : error instanceof Error
          ? error.message
          : "Tab failed.";
      throw new Error(`${failureMessage} ${detail}`, {
        cause: error,
      });
    }
  }

  if (windowError) {
    throw new Error(`${failureMessage} ${windowError.message}`, { cause: windowError });
  }
  throw new Error(failureMessage);
}

export async function handleContextMenuClick(info, tab, chromeApi = chrome) {
  if (info?.menuItemId !== CAPTURE_CONTEXT_MENU_ID) {
    return { handled: false };
  }
  const acceptedEpoch = await loadDataConsent(chromeApi.storage.local);
  if (!acceptedEpoch) {
    const surface = await openCaptureSurface(chromeApi, { captureQueued: false });
    return {
      handled: true,
      capture: {
        saved: false,
        reason: "consent-required",
        wasTruncated: false,
      },
      surface,
    };
  }
  let capture;
  try {
    capture = await captureContextSelection(
      info,
      tab,
      chromeApi.storage.local,
      undefined,
      { expectedConsentEpoch: acceptedEpoch },
    );
  } catch (error) {
    if (
      error instanceof ValidationError &&
      ["consent-required", "data-reset"].includes(error.code)
    ) {
      const surface = await openCaptureSurface(chromeApi, { captureQueued: false });
      return {
        handled: true,
        capture: {
          saved: false,
          reason: "consent-required",
          wasTruncated: false,
        },
        surface,
      };
    }
    throw error;
  }
  if (!capture.saved) {
    return { handled: true, capture, surface: null };
  }
  const surface = await openCaptureSurface(chromeApi);
  return { handled: true, capture, surface };
}

if (typeof chrome !== "undefined") {
  const registerContextMenu = () => {
    void syncCaptureContextMenu(
      chrome.storage.local,
      chrome.contextMenus,
      chrome.runtime,
    ).catch((error) => {
      console.error("Lecture Notes context menu could not be updated.", error);
    });
  };

  chrome.runtime.onInstalled.addListener(registerContextMenu);
  chrome.runtime.onStartup.addListener(registerContextMenu);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      areaName === "local" &&
      (changes["lectureNoteDataConsent"] || changes["lectureNoteDataEpoch"])
    ) {
      registerContextMenu();
    }
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    void handleContextMenuClick(info, tab, chrome).catch((error) => {
      console.error("Lecture Notes could not capture the selected text.", error);
    });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      message?.type === MESSAGE_TYPES.dataConsentChanged &&
      sender?.id === chrome.runtime.id
    ) {
      void syncCaptureContextMenu(
        chrome.storage.local,
        chrome.contextMenus,
        chrome.runtime,
      ).then(
        (consent) => sendResponse({ ok: true, consent }),
        (error) => sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Consent status not checked",
        }),
      );
      return true;
    }
    if (!isAuthorizedDraftMessage(message, sender, chrome.runtime.id)) {
      return false;
    }
    void handleDraftMessage(message, sender, chrome.storage.local, chrome.runtime.id).then(
      (result) => sendResponse({ ok: true, saved: result.saved, cursor: result.cursor }),
      (error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Draft not saved",
        code: typeof error?.code === "string" ? error.code : undefined,
      }),
    );
    return true;
  });
  registerContextMenu();
}
