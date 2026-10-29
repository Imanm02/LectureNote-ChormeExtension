import assert from "node:assert/strict";
import test from "node:test";

import { requireDataConsent } from "../src/consent.js";
import {
  clearStoredDataBeforeConsent,
  loadDataConsent,
  saveDataConsent,
  savePopupDraft,
  STORAGE_KEYS,
} from "../src/storage.js";
import { chromeMock, loadPage, memoryStorage, waitFor } from "./helpers.js";

function openFreshGate(initial = {}) {
  const dom = loadPage("popup.html");
  const storage = memoryStorage(initial);
  const chromeApi = chromeMock(storage, {}, { dataConsent: false });
  const consent = requireDataConsent({
    documentValue: dom.window.document,
    chromeApi,
  });
  return { dom, storage, chromeApi, consent };
}

async function waitForGate(documentValue) {
  await waitFor(() => {
    const accept = documentValue.getElementById("dataConsentAcceptButton");
    return documentValue.getElementById("dataConsentDialog").open && !accept.disabled;
  });
}

test("consent setup fails fast when required markup is missing", async () => {
  const dom = loadPage("popup.html");
  dom.window.document.getElementById("dataConsentStatus").remove();

  await assert.rejects(
    () => requireDataConsent({
      documentValue: dom.window.document,
      chromeApi: chromeMock(memoryStorage(), {}, { dataConsent: false }),
    }),
    /Missing consent element: dataConsentStatus/u,
  );
  dom.window.close();
});

test("fresh consent gate reads only its consent record and starts on the heading", async () => {
  const stateSentinel = { private: "not-read-before-consent" };
  const dom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.state]: stateSentinel });
  const reads = [];
  const baseGet = storage.get.bind(storage);
  storage.get = async (keys) => {
    reads.push(Array.isArray(keys) ? [...keys] : [keys]);
    return baseGet(keys);
  };
  const chromeApi = chromeMock(storage, {}, { dataConsent: false });
  const consent = requireDataConsent({ documentValue: dom.window.document, chromeApi });

  await waitForGate(dom.window.document);

  const dialog = dom.window.document.getElementById("dataConsentDialog");
  const heading = dom.window.document.getElementById("dataConsentHeading");
  const cancelEvent = new dom.window.Event("cancel", { cancelable: true });
  dialog.dispatchEvent(cancelEvent);

  assert.deepEqual(reads, [[STORAGE_KEYS.dataConsent, STORAGE_KEYS.dataEpoch]]);
  assert.deepEqual(storage.values[STORAGE_KEYS.state], stateSentinel);
  assert.equal(dom.window.document.activeElement, heading);
  assert.equal(cancelEvent.defaultPrevented, true);
  assert.equal(dialog.open, true);
  assert.match(dialog.getAttribute("aria-describedby"), /dataConsentNote/u);
  assert.equal(
    dom.window.document.getElementById("dataConsentClearPanel").getAttribute("role"),
    "group",
  );
  assert.equal(
    dom.window.document.querySelector("a[href='PRIVACY.md']")?.textContent,
    "Read the privacy notice",
  );

  dom.window.document.getElementById("dataConsentAcceptButton").click();
  const epoch = await consent;
  assert.equal(storage.values[STORAGE_KEYS.dataConsent].accepted, true);
  assert.equal(storage.values[STORAGE_KEYS.dataConsent].epoch, epoch);
  dom.window.close();
});

test("Escape backs out of clear review without dismissing the gate", async () => {
  const { dom, consent } = openFreshGate();
  await waitForGate(dom.window.document);
  const dialog = dom.window.document.getElementById("dataConsentDialog");
  const clear = dom.window.document.getElementById("dataConsentClearButton");
  clear.click();

  const cancelEvent = new dom.window.Event("cancel", { cancelable: true });
  dialog.dispatchEvent(cancelEvent);

  assert.equal(cancelEvent.defaultPrevented, true);
  assert.equal(dialog.open, true);
  assert.equal(dom.window.document.getElementById("dataConsentClearPanel").hidden, true);
  assert.equal(dom.window.document.activeElement, clear);

  dom.window.document.getElementById("dataConsentAcceptButton").click();
  await consent;
  dom.window.close();
});

test("Escape keeps a clear operation visible while storage is busy", async () => {
  const { dom, storage, consent } = openFreshGate({
    [STORAGE_KEYS.state]: { private: "clear-in-progress" },
  });
  const baseClear = storage.clear.bind(storage);
  let clearStarted = false;
  let releaseClear;
  const clearBarrier = new Promise((resolve) => {
    releaseClear = resolve;
  });
  storage.clear = async () => {
    clearStarted = true;
    await clearBarrier;
    await baseClear();
  };
  await waitForGate(dom.window.document);

  const dialog = dom.window.document.getElementById("dataConsentDialog");
  const clearPanel = dom.window.document.getElementById("dataConsentClearPanel");
  const status = dom.window.document.getElementById("dataConsentStatus");
  dom.window.document.getElementById("dataConsentClearButton").click();
  dom.window.document.getElementById("dataConsentConfirmClearButton").click();
  await waitFor(() => clearStarted);

  const cancelEvent = new dom.window.Event("cancel", { cancelable: true });
  dialog.dispatchEvent(cancelEvent);

  assert.equal(cancelEvent.defaultPrevented, true);
  assert.equal(clearPanel.hidden, false);
  assert.equal(status.textContent, "Clearing stored extension data...");
  assert.equal(
    dom.window.document.activeElement,
    dom.window.document.getElementById("dataConsentHeading"),
  );

  releaseClear();
  await waitFor(() => status.textContent.includes("was cleared"));
  assert.equal(clearPanel.hidden, true);
  dom.window.document.getElementById("dataConsentAcceptButton").click();
  await consent;
  dom.window.close();
});

test("consent acceptance reports busy state and keeps the saved epoch", async () => {
  const { dom, storage, consent } = openFreshGate();
  await waitForGate(dom.window.document);

  const form = dom.window.document.getElementById("dataConsentForm");
  dom.window.document.getElementById("dataConsentAcceptButton").click();
  assert.equal(form.getAttribute("aria-busy"), "true");
  assert.equal(form.hasAttribute("inert"), false);
  assert.equal(dom.window.document.getElementById("dataConsentStatus").closest("[inert]"), null);

  const epoch = await consent;
  assert.equal(storage.values[STORAGE_KEYS.dataEpoch], epoch);
  assert.deepEqual(storage.values[STORAGE_KEYS.dataConsent], {
    version: 1,
    epoch,
    accepted: true,
  });
  assert.equal(dom.window.document.getElementById("dataConsentDialog").open, false);
  dom.window.close();
});

test("consent acceptance continues when the service worker is unavailable", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage();
  const chromeApi = chromeMock(storage, {}, { dataConsent: false });
  chromeApi.runtime = {
    async sendMessage() {
      throw new Error("Worker unavailable");
    },
  };
  const consent = requireDataConsent({ documentValue: dom.window.document, chromeApi });
  await waitForGate(dom.window.document);

  dom.window.document.getElementById("dataConsentAcceptButton").click();

  const epoch = await consent;
  assert.equal(storage.values[STORAGE_KEYS.dataConsent].epoch, epoch);
  assert.equal(dom.window.document.getElementById("dataConsentDialog").open, false);
  dom.window.close();
});

test("a consent choice cleared during acceptance keeps the page gated", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage();
  const chromeApi = chromeMock(storage, {}, { dataConsent: false });
  chromeApi.runtime = {
    async sendMessage() {
      const epoch = storage.values[STORAGE_KEYS.dataEpoch];
      storage.values[STORAGE_KEYS.dataConsent] = {
        version: 1,
        epoch,
        accepted: false,
      };
      return { ok: true, consent: false };
    },
  };
  void requireDataConsent({ documentValue: dom.window.document, chromeApi });
  await waitForGate(dom.window.document);

  dom.window.document.getElementById("dataConsentAcceptButton").click();
  await waitFor(() =>
    dom.window.document.getElementById("dataConsentStatus").textContent.includes("cleared"),
  );

  assert.equal(dom.window.document.getElementById("dataConsentDialog").open, true);
  assert.equal(dom.window.document.getElementById("dataConsentAcceptButton").disabled, false);
  assert.equal(
    dom.window.document.activeElement,
    dom.window.document.getElementById("dataConsentHeading"),
  );
  dom.window.close();
});

test("an existing current consent choice opens the page without prompting", async () => {
  const epoch = "already-accepted-epoch";
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.dataEpoch]: epoch,
    [STORAGE_KEYS.dataConsent]: { version: 1, epoch, accepted: true },
  });
  const chromeApi = chromeMock(storage, {}, { dataConsent: false });
  dom.window.document.getElementById("dataConsentDialog").setAttribute("open", "");

  assert.equal(
    await requireDataConsent({ documentValue: dom.window.document, chromeApi }),
    epoch,
  );
  assert.equal(dom.window.document.getElementById("dataConsentDialog").open, false);
  dom.window.close();
});

test("an externally closed gate still settles an existing consent check", async () => {
  const epoch = "accepted-while-checking";
  const dom = loadPage("popup.html");
  const storage = memoryStorage({
    [STORAGE_KEYS.dataEpoch]: epoch,
    [STORAGE_KEYS.dataConsent]: { version: 1, epoch, accepted: true },
  });
  const baseGet = storage.get.bind(storage);
  let releaseRead;
  const readBarrier = new Promise((resolve) => {
    releaseRead = resolve;
  });
  storage.get = async (keys) => {
    await readBarrier;
    return baseGet(keys);
  };
  const consent = requireDataConsent({
    documentValue: dom.window.document,
    chromeApi: chromeMock(storage, {}, { dataConsent: false }),
  });
  await waitFor(() => dom.window.document.getElementById("dataConsentDialog").open);

  dom.window.document.getElementById("dataConsentDialog").removeAttribute("open");
  releaseRead();

  assert.equal(await consent, epoch);
  assert.equal(dom.window.document.getElementById("dataConsentDialog").open, false);
  dom.window.close();
});

test("consent storage errors stay gated and restore heading focus", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.dataEpoch]: "existing-consent-epoch" });
  storage.set = async () => {
    throw new Error("Storage is read only");
  };
  const chromeApi = chromeMock(storage, {}, { dataConsent: false });
  void requireDataConsent({ documentValue: dom.window.document, chromeApi });
  await waitForGate(dom.window.document);

  dom.window.document.getElementById("dataConsentAcceptButton").click();
  await waitFor(() =>
    dom.window.document.getElementById("dataConsentStatus").textContent.includes("read only"),
  );

  assert.equal(dom.window.document.getElementById("dataConsentDialog").open, true);
  assert.equal(
    dom.window.document.getElementById("dataConsentForm").hasAttribute("inert"),
    false,
  );
  assert.equal(
    dom.window.document.activeElement,
    dom.window.document.getElementById("dataConsentHeading"),
  );
  dom.window.close();
});

test("a consent read failure stays gated with an announced error", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage();
  storage.get = async () => {
    throw new Error("Consent read blocked");
  };
  const chromeApi = chromeMock(storage, {}, { dataConsent: false });
  void requireDataConsent({ documentValue: dom.window.document, chromeApi });

  await waitFor(() =>
    dom.window.document.getElementById("dataConsentStatus").textContent.includes("read blocked"),
  );

  assert.equal(dom.window.document.getElementById("dataConsentDialog").open, true);
  assert.equal(dom.window.document.getElementById("dataConsentAcceptButton").disabled, false);
  assert.equal(
    dom.window.document.activeElement,
    dom.window.document.getElementById("dataConsentHeading"),
  );
  dom.window.close();
});

test("an acceptance in another window starts the waiting page once", async () => {
  const { dom, storage, chromeApi, consent } = openFreshGate();
  await waitForGate(dom.window.document);
  const epoch = "accepted-in-another-window";
  const record = { version: 1, epoch, accepted: true };
  storage.values[STORAGE_KEYS.dataEpoch] = epoch;
  storage.values[STORAGE_KEYS.dataConsent] = record;

  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.dataEpoch]: { oldValue: undefined, newValue: epoch },
    [STORAGE_KEYS.dataConsent]: { oldValue: undefined, newValue: record },
  });

  assert.equal(await consent, epoch);
  assert.equal(dom.window.document.getElementById("dataConsentDialog").open, false);
  dom.window.close();
});

test("unrelated storage changes leave the consent gate waiting", async () => {
  const { dom, chromeApi, consent } = openFreshGate();
  await waitForGate(dom.window.document);

  await chromeApi.emitStorageChange({ unrelated: { newValue: true } });
  await chromeApi.emitStorageChange({
    [STORAGE_KEYS.dataConsent]: { newValue: { accepted: true } },
  }, "sync");

  assert.equal(dom.window.document.getElementById("dataConsentDialog").open, true);
  dom.window.document.getElementById("dataConsentAcceptButton").click();
  await consent;
  dom.window.close();
});

test("a reset reason is announced inside the consent gate", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage();
  const chromeApi = chromeMock(storage, {}, { dataConsent: false });
  const consent = requireDataConsent({
    documentValue: dom.window.document,
    chromeApi,
    contextMessage: "Local data was cleared. Allow local note capture to start again.",
  });
  await waitForGate(dom.window.document);

  assert.equal(
    dom.window.document.getElementById("dataConsentStatus").textContent,
    "Local data was cleared. Allow local note capture to start again.",
  );

  dom.window.document.getElementById("dataConsentAcceptButton").click();
  await consent;
  dom.window.close();
});

test("clear review uses a safe default and removes stored data without opening it", async () => {
  const secretState = { private: "clear-without-reading" };
  const { dom, storage, consent } = openFreshGate({
    [STORAGE_KEYS.state]: secretState,
    [STORAGE_KEYS.draft]: { private: "draft" },
    [STORAGE_KEYS.helpSeen]: true,
  });
  const reads = [];
  const baseGet = storage.get.bind(storage);
  storage.get = async (keys) => {
    reads.push(Array.isArray(keys) ? [...keys] : [keys]);
    return baseGet(keys);
  };
  await waitForGate(dom.window.document);

  dom.window.document.getElementById("dataConsentClearButton").click();
  assert.equal(
    dom.window.document.activeElement,
    dom.window.document.getElementById("dataConsentKeepButton"),
  );
  dom.window.document.getElementById("dataConsentConfirmClearButton").click();
  await waitFor(() => Object.keys(storage.values).length === 0);
  await waitFor(() =>
    dom.window.document.getElementById("dataConsentStatus").textContent.includes("was cleared"),
  );

  assert.equal(
    reads.every((keys) => keys.length === 2 &&
      keys.includes(STORAGE_KEYS.dataConsent) &&
      keys.includes(STORAGE_KEYS.dataEpoch)),
    true,
  );
  assert.equal(
    dom.window.document.activeElement,
    dom.window.document.getElementById("dataConsentHeading"),
  );
  assert.equal(dom.window.document.getElementById("dataConsentDialog").open, true);

  dom.window.document.getElementById("dataConsentAcceptButton").click();
  await consent;
  dom.window.close();
});

test("a failed pre-consent clear remains open and retryable", async () => {
  const dom = loadPage("popup.html");
  const storage = memoryStorage({ [STORAGE_KEYS.state]: { private: "keep-on-error" } });
  storage.clear = async () => {
    throw new Error("Clear blocked");
  };
  const chromeApi = chromeMock(storage, {}, { dataConsent: false });
  void requireDataConsent({ documentValue: dom.window.document, chromeApi });
  await waitForGate(dom.window.document);

  dom.window.document.getElementById("dataConsentClearButton").click();
  dom.window.document.getElementById("dataConsentConfirmClearButton").click();
  await waitFor(() =>
    dom.window.document.getElementById("dataConsentStatus").textContent.includes("Clear blocked"),
  );

  assert.deepEqual(storage.values[STORAGE_KEYS.state], { private: "keep-on-error" });
  assert.equal(dom.window.document.getElementById("dataConsentClearPanel").hidden, false);
  assert.equal(
    dom.window.document.activeElement,
    dom.window.document.getElementById("dataConsentConfirmClearButton"),
  );
  assert.equal(dom.window.document.getElementById("dataConsentConfirmClearButton").disabled, false);
  dom.window.close();
});

test("malformed and mismatched consent records fail closed without rewriting storage", async () => {
  for (const consentRecord of [
    { version: 2, epoch: "stored-epoch", accepted: true },
    { version: 1, epoch: "other-epoch", accepted: true },
    { version: 1, epoch: "stored-epoch", accepted: false },
    "accepted",
  ]) {
    const storage = memoryStorage({
      [STORAGE_KEYS.dataEpoch]: "stored-epoch",
      [STORAGE_KEYS.dataConsent]: consentRecord,
    });
    const before = structuredClone(storage.values);

    assert.equal(await loadDataConsent(storage, { lockManager: null }), null);
    assert.deepEqual(storage.values, before);
  }
});

test("saving consent binds it to the current data epoch", async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.dataEpoch]: "current-data-epoch" });

  const epoch = await saveDataConsent(storage, { lockManager: null });

  assert.equal(epoch, "current-data-epoch");
  assert.deepEqual(storage.values[STORAGE_KEYS.dataConsent], {
    version: 1,
    epoch: "current-data-epoch",
    accepted: true,
  });
});

test("a stale page cannot recreate storage after consent-gate clearing", async () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.dataEpoch]: "cleared-data-epoch",
    [STORAGE_KEYS.dataConsent]: {
      version: 1,
      epoch: "cleared-data-epoch",
      accepted: true,
    },
    [STORAGE_KEYS.state]: { private: "stored-note-data" },
  });
  await clearStoredDataBeforeConsent(storage, { lockManager: null });

  await assert.rejects(
    () => savePopupDraft(
      { body: "stale draft" },
      storage,
      {
        expectedEpoch: "cleared-data-epoch",
        sessionId: "stale-popup",
        expectedOwnerSessionId: "",
        expectedGeneration: 0,
        contentGeneration: 1,
        lockManager: null,
      },
    ),
    { code: "data-reset" },
  );

  assert.deepEqual(storage.values, {});
});
