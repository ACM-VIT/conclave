"use client";

import { CUSTOM_BACKGROUND_MAX_DATA_URL_CHARS } from "./video-effects";

const DB_NAME = "conclave-video-effects";
const DB_VERSION = 1;
const CUSTOM_BACKGROUNDS_STORE = "custom-backgrounds";
const MAX_CUSTOM_BACKGROUNDS = 8;

export interface CustomVideoBackground {
  id: string;
  name: string;
  dataUrl: string;
  thumbnailDataUrl: string;
  createdAt: number;
  updatedAt: number;
}

export type CustomVideoBackgroundSummary = Omit<
  CustomVideoBackground,
  "dataUrl"
>;

const canUseIndexedDb = () =>
  typeof window !== "undefined" && typeof window.indexedDB !== "undefined";

const requestToPromise = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB failed."));
  });

const transactionDone = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });

const openCustomBackgroundDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    if (!canUseIndexedDb()) {
      reject(new Error("Custom background storage is unavailable."));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CUSTOM_BACKGROUNDS_STORE)) {
        const store = db.createObjectStore(CUSTOM_BACKGROUNDS_STORE, {
          keyPath: "id",
        });
        store.createIndex("updatedAt", "updatedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open custom background storage."));
  });

const withStore = async <T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => Promise<T> | T,
) => {
  const db = await openCustomBackgroundDb();
  try {
    const transaction = db.transaction(CUSTOM_BACKGROUNDS_STORE, mode);
    const store = transaction.objectStore(CUSTOM_BACKGROUNDS_STORE);
    const result = await callback(store);
    await transactionDone(transaction);
    return result;
  } finally {
    db.close();
  }
};

const normalizeCustomBackgroundName = (name: string) => {
  const normalized = name.replace(/\s+/g, " ").trim();
  return (normalized || "Uploaded image").slice(0, 80);
};

const isCustomBackgroundDataUrl = (value: string) =>
  /^data:image\/(png|jpe?g|webp);base64,/i.test(value) &&
  value.length <= CUSTOM_BACKGROUND_MAX_DATA_URL_CHARS;

const createCustomBackgroundId = () =>
  `custom-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

const toSummary = ({
  id,
  name,
  thumbnailDataUrl,
  createdAt,
  updatedAt,
}: CustomVideoBackground): CustomVideoBackgroundSummary => ({
  id,
  name,
  thumbnailDataUrl,
  createdAt,
  updatedAt,
});

const sortRecentFirst = <T extends { updatedAt: number; createdAt: number }>(
  backgrounds: T[],
) =>
  backgrounds.sort(
    (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
  );

export const listCustomVideoBackgrounds = async () => {
  if (!canUseIndexedDb()) return [];
  const backgrounds = await withStore("readonly", (store) =>
    requestToPromise<CustomVideoBackground[]>(store.getAll()),
  );
  return sortRecentFirst(backgrounds).map(toSummary);
};

export const getCustomVideoBackground = async (id: string) => {
  if (!canUseIndexedDb()) return null;
  const background = await withStore("readonly", (store) =>
    requestToPromise<CustomVideoBackground | undefined>(store.get(id)),
  );
  return background ?? null;
};

export const saveCustomVideoBackground = async ({
  name,
  dataUrl,
  thumbnailDataUrl = dataUrl,
}: {
  name: string;
  dataUrl: string;
  thumbnailDataUrl?: string;
}) => {
  if (!isCustomBackgroundDataUrl(dataUrl)) {
    throw new Error("Image upload is too large.");
  }
  if (!isCustomBackgroundDataUrl(thumbnailDataUrl)) {
    throw new Error("Image preview is too large.");
  }

  const now = Date.now();
  const background: CustomVideoBackground = {
    id: createCustomBackgroundId(),
    name: normalizeCustomBackgroundName(name),
    dataUrl,
    thumbnailDataUrl,
    createdAt: now,
    updatedAt: now,
  };

  await withStore("readwrite", (store) => {
    store.put(background);
  });
  await pruneCustomVideoBackgrounds();
  return background;
};

export const touchCustomVideoBackground = async (id: string) => {
  const background = await getCustomVideoBackground(id);
  if (!background) return null;
  const updated = { ...background, updatedAt: Date.now() };
  await withStore("readwrite", (store) => {
    store.put(updated);
  });
  return updated;
};

export const deleteCustomVideoBackground = async (id: string) => {
  if (!canUseIndexedDb()) return;
  await withStore("readwrite", (store) => {
    store.delete(id);
  });
};

const pruneCustomVideoBackgrounds = async () => {
  const backgrounds = await listCustomVideoBackgrounds();
  const stale = backgrounds.slice(MAX_CUSTOM_BACKGROUNDS);
  if (stale.length === 0) return;
  await withStore("readwrite", (store) => {
    stale.forEach((background) => store.delete(background.id));
  });
};
