import * as Y from "yjs";
import { APP_DOCUMENT_UPDATE_MAX_BYTES, APP_DOCUMENT_UPLOAD_INTERVAL_MS } from "../limits";
import { splitUpdate } from "./splitUpdate";

type Pending = { appId: string; replicaId: string | undefined; updates: Uint8Array[] };

export type SendUpload = (appId: string, replicaId: string | undefined, update: Uint8Array) => boolean;

export type UploadQueue = {
  add: (appId: string, replicaId: string | undefined, update: Uint8Array) => void;
  drop: (appId: string) => void;
  wake: () => void;
  clear: () => void;
};

const takeBatch = (updates: Uint8Array[]): number => {
  let bytes = updates[0].length;
  let count = 1;
  while (count < updates.length && bytes + updates[count].length <= APP_DOCUMENT_UPDATE_MAX_BYTES) {
    bytes += updates[count].length;
    count += 1;
  }
  return count;
};

const merge = (updates: Uint8Array[]): Uint8Array => (updates.length === 1 ? updates[0] : Y.mergeUpdates(updates));

export const createUploadQueue = (send: SendUpload): UploadQueue => {
  const pending = new Map<string, Pending>();
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushQueued = false;

  const flush = (): void => {
    const next = pending.entries().next();
    if (next.done) return;
    const [key, entry] = next.value;
    const count = takeBatch(entry.updates);
    const update = merge(entry.updates.slice(0, count));
    if (!send(entry.appId, entry.replicaId, update)) return;
    entry.updates.splice(0, count);
    if (entry.updates.length === 0) pending.delete(key);
    lastSentAt = Date.now();
    schedule();
  };

  const schedule = (): void => {
    if (timer !== undefined || flushQueued || pending.size === 0) return;
    const wait = lastSentAt + APP_DOCUMENT_UPLOAD_INTERVAL_MS - Date.now();
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = undefined;
        flush();
      }, wait);
      return;
    }
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      flush();
    });
  };

  return {
    add: (appId, replicaId, update) => {
      const key = `${appId}\u0000${replicaId ?? ""}`;
      const pieces = splitUpdate(update, APP_DOCUMENT_UPDATE_MAX_BYTES);
      const entry = pending.get(key);
      if (entry) entry.updates.push(...pieces);
      else pending.set(key, { appId, replicaId, updates: pieces });
      schedule();
    },
    drop: (appId) => {
      for (const [key, entry] of pending) {
        if (entry.appId === appId) pending.delete(key);
      }
    },
    wake: schedule,
    clear: () => {
      pending.clear();
      clearTimeout(timer);
      timer = undefined;
    },
  };
};
