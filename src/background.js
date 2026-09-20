import { MESSAGE_TYPES } from "./messages.js";
import { saveDraft } from "./storage.js";

export function isAuthorizedDraftMessage(message, sender, runtimeId) {
  return (
    message?.type === MESSAGE_TYPES.saveDraft &&
    typeof runtimeId === "string" &&
    sender?.id === runtimeId
  );
}

export async function handleDraftMessage(message, sender, storage, runtimeId) {
  if (!isAuthorizedDraftMessage(message, sender, runtimeId)) {
    return { handled: false };
  }
  await saveDraft(message.draft, storage);
  return { handled: true };
}

if (typeof chrome !== "undefined") {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isAuthorizedDraftMessage(message, sender, chrome.runtime.id)) {
      return false;
    }
    void handleDraftMessage(message, sender, chrome.storage.local, chrome.runtime.id).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Draft not saved" }),
    );
    return true;
  });
}
