import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JSDOM } from "jsdom";

export function memoryStorage(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((name) => name in values).map((name) => [name, values[name]]));
    },
    async set(update) {
      Object.assign(values, structuredClone(update));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete values[key];
      }
    },
  };
}

export function chromeMock(storage, capture = {}) {
  const listeners = new Set();
  return {
    async emitStorageChange(changes, areaName = "local") {
      await Promise.all([...listeners].map((listener) => listener(changes, areaName)));
    },
    storage: {
      local: storage,
      onChanged: {
        addListener(listener) {
          listeners.add(listener);
        },
        removeListener(listener) {
          listeners.delete(listener);
        },
      },
    },
    tabs: {
      async query() {
        return [{ id: 7 }];
      },
    },
    scripting: {
      async executeScript() {
        return [
          {
            result: {
              text: capture.text || "",
              title: capture.title || "",
              url: capture.url || "https://example.com/lecture",
              wasTruncated: capture.wasTruncated === true,
            },
          },
        ];
      },
    },
  };
}

export function loadPage(name) {
  const html = readFileSync(resolve(name), "utf8");
  return new JSDOM(html, {
    url: `https://extension.test/${name}`,
    pretendToBeVisual: true,
  });
}

export function enableDialogs(documentValue) {
  for (const dialog of documentValue.querySelectorAll("dialog")) {
    dialog.showModal = function showModal() {
      this.setAttribute("open", "");
    };
    dialog.close = function close() {
      this.removeAttribute("open");
      this.dispatchEvent(new documentValue.defaultView.Event("close"));
    };
  }
}

export async function waitFor(predicate, timeout = 1_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) {
      throw new Error("Timed out waiting for the expected state.");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}
