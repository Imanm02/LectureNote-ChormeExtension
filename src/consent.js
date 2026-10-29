import { MESSAGE_TYPES } from "./messages.js";
import {
  clearStoredDataBeforeConsent,
  loadDataConsent,
  saveDataConsent,
  STORAGE_KEYS,
} from "./storage.js";
import { setStatus } from "./ui.js";

function requiredElement(documentValue, identifier) {
  const element = documentValue.getElementById(identifier);
  if (!element) {
    throw new Error(`Missing consent element: ${identifier}`);
  }
  return element;
}

function consentElements(documentValue) {
  return {
    dialog: requiredElement(documentValue, "dataConsentDialog"),
    heading: requiredElement(documentValue, "dataConsentHeading"),
    form: requiredElement(documentValue, "dataConsentForm"),
    accept: requiredElement(documentValue, "dataConsentAcceptButton"),
    clear: requiredElement(documentValue, "dataConsentClearButton"),
    clearPanel: requiredElement(documentValue, "dataConsentClearPanel"),
    keep: requiredElement(documentValue, "dataConsentKeepButton"),
    confirmClear: requiredElement(documentValue, "dataConsentConfirmClearButton"),
    status: requiredElement(documentValue, "dataConsentStatus"),
  };
}

function errorMessage(error) {
  return error instanceof Error && error.message
    ? error.message
    : "Chrome storage is not available.";
}

function showDialog(dialog) {
  if (dialog.open) {
    return;
  }
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function closeDialog(dialog) {
  if (!dialog.open) {
    return;
  }
  if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}

async function notifyConsentChanged(chromeApi) {
  if (typeof chromeApi.runtime?.sendMessage !== "function") {
    return;
  }
  try {
    const result = chromeApi.runtime.sendMessage({
      type: MESSAGE_TYPES.dataConsentChanged,
    });
    if (result && typeof result.then === "function") {
      await result;
    }
  } catch {
    // The storage event also updates the service worker when it is available.
  }
}

export async function requireDataConsent({
  documentValue = document,
  chromeApi = chrome,
  contextMessage = "",
} = {}) {
  const elements = consentElements(documentValue);
  const storage = chromeApi.storage.local;
  let actionInFlight = false;
  let settled = false;
  let resolveConsent;
  const consentPromise = new Promise((resolve) => {
    resolveConsent = resolve;
  });

  function setBusy(busy) {
    actionInFlight = busy;
    elements.form.setAttribute("aria-busy", String(busy));
    elements.accept.disabled = busy;
    elements.clear.disabled = busy;
    elements.keep.disabled = busy;
    elements.confirmClear.disabled = busy;
  }

  function finish(epoch) {
    if (settled) {
      return;
    }
    settled = true;
    chromeApi.storage.onChanged?.removeListener(storageChangeHandler);
    elements.form.removeEventListener("submit", submitHandler);
    elements.clear.removeEventListener("click", reviewClear);
    elements.keep.removeEventListener("click", cancelClear);
    elements.confirmClear.removeEventListener("click", confirmClearHandler);
    elements.dialog.removeEventListener("cancel", cancelDialogHandler);
    closeDialog(elements.dialog);
    resolveConsent(epoch);
  }

  async function acceptConsent() {
    if (actionInFlight || settled) {
      return;
    }
    setBusy(true);
    setStatus(elements.status, "Saving your choice...", "info");
    try {
      const epoch = await saveDataConsent(storage);
      await notifyConsentChanged(chromeApi);
      const currentEpoch = await loadDataConsent(storage, { expectedEpoch: epoch });
      if (currentEpoch !== epoch) {
        throw new Error("The saved choice was cleared before this page could start.");
      }
      finish(epoch);
    } catch (error) {
      setStatus(
        elements.status,
        `Your choice could not be saved: ${errorMessage(error)}`,
        "error",
      );
      setBusy(false);
      elements.heading.focus();
    }
  }

  function reviewClear() {
    if (actionInFlight || settled) {
      return;
    }
    elements.clearPanel.hidden = false;
    setStatus(elements.status, "", "info");
    elements.keep.focus();
  }

  function cancelClear() {
    if (actionInFlight || settled) {
      return;
    }
    elements.clearPanel.hidden = true;
    setStatus(elements.status, contextMessage, contextMessage ? "warning" : "info");
    elements.clear.focus();
  }

  async function clearStoredData() {
    if (actionInFlight || settled) {
      return;
    }
    setBusy(true);
    setStatus(elements.status, "Clearing stored extension data...", "info");
    try {
      await clearStoredDataBeforeConsent(storage);
      await notifyConsentChanged(chromeApi);
      const acceptedEpoch = await loadDataConsent(storage);
      if (acceptedEpoch) {
        finish(acceptedEpoch);
        return;
      }
      elements.clearPanel.hidden = true;
      setStatus(
        elements.status,
        "Stored extension data was cleared. You can close this page or allow local note capture.",
        "success",
      );
      setBusy(false);
      elements.heading.focus();
    } catch (error) {
      setStatus(
        elements.status,
        `Stored data was not cleared: ${errorMessage(error)}`,
        "error",
      );
      setBusy(false);
      elements.confirmClear.focus();
    }
  }

  const storageChangeHandler = (changes, areaName) => {
    if (
      settled ||
      actionInFlight ||
      areaName !== "local" ||
      (!changes[STORAGE_KEYS.dataConsent] && !changes[STORAGE_KEYS.dataEpoch])
    ) {
      return;
    }
    void loadDataConsent(storage).then((epoch) => {
      if (epoch) {
        finish(epoch);
      }
    }).catch(() => undefined);
  };

  const submitHandler = (event) => {
    event.preventDefault();
    void acceptConsent();
  };
  const confirmClearHandler = () => void clearStoredData();
  const cancelDialogHandler = (event) => {
    event.preventDefault();
    if (actionInFlight) {
      elements.heading.focus();
    } else if (!elements.clearPanel.hidden) {
      cancelClear();
    } else {
      elements.heading.focus();
    }
  };
  elements.form.addEventListener("submit", submitHandler);
  elements.clear.addEventListener("click", reviewClear);
  elements.keep.addEventListener("click", cancelClear);
  elements.confirmClear.addEventListener("click", confirmClearHandler);
  elements.dialog.addEventListener("cancel", cancelDialogHandler);
  chromeApi.storage.onChanged?.addListener(storageChangeHandler);

  elements.clearPanel.hidden = true;
  showDialog(elements.dialog);
  elements.heading.focus();
  setBusy(true);
  setStatus(elements.status, "Checking your saved choice...", "info");
  try {
    const epoch = await loadDataConsent(storage);
    if (epoch) {
      finish(epoch);
    } else {
      setStatus(elements.status, contextMessage, contextMessage ? "warning" : "info");
      setBusy(false);
      elements.heading.focus();
    }
  } catch (error) {
    setStatus(
      elements.status,
      `Your saved choice could not be checked: ${errorMessage(error)}`,
      "error",
    );
    setBusy(false);
    elements.heading.focus();
  }

  return consentPromise;
}
