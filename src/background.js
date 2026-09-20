import { MESSAGE_TYPES } from "./messages.js";
import { saveDraft, saveEditorDraft } from "./storage.js";

export function isAuthorizedDraftMessage(message, sender, runtimeId) {
  return (
    [MESSAGE_TYPES.saveDraft, MESSAGE_TYPES.saveEditorDraft].includes(message?.type) &&
    typeof runtimeId === "string" &&
    sender?.id === runtimeId
  );
}

export async function handleDraftMessage(message, sender, storage, runtimeId) {
  if (!isAuthorizedDraftMessage(message, sender, runtimeId)) {
    return { handled: false };
  }
  if (message.type === MESSAGE_TYPES.saveEditorDraft) {
    const result = await saveEditorDraft(message.draft, storage, {
      sessionId: message.sessionId,
      expectedOwnerSessionId: message.expectedOwnerSessionId,
      expectedGeneration: message.expectedGeneration,
      contentGeneration: message.contentGeneration,
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
  await saveDraft(message.draft, storage);
  return { handled: true, saved: true };
}

if (typeof chrome !== "undefined") {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isAuthorizedDraftMessage(message, sender, chrome.runtime.id)) {
      return false;
    }
    void handleDraftMessage(message, sender, chrome.storage.local, chrome.runtime.id).then(
      (result) => sendResponse({ ok: true, saved: result.saved, cursor: result.cursor }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Draft not saved" }),
    );
    return true;
  });
}
