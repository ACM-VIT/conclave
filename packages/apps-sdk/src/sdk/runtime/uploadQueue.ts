import * as Y from "yjs";
import { APP_DOCUMENT_UPDATE_MAX_BYTES, APP_DOCUMENT_UPLOAD_INTERVAL_MS } from "../limits";
import type { AppsUpdatePart } from "../types/index";

type Item = { update: Uint8Array; part?: AppsUpdatePart };
type Pending = { appId: string; replicaId: string | undefined; items: Item[] };

export type SendUpload = (appId: string, replicaId: string | undefined, update: Uint8Array, part?: AppsUpdatePart) => boolean;

export type UploadQueueOptions = { stagesParts?: () => boolean | null };

export type UploadQueue = {
  add: (appId: string, replicaId: string | undefined, update: Uint8Array) => void;
  drop: (appId: string) => void;
  wake: () => void;
  clear: () => void;
};

const newChangeId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

const partsOf = (update: Uint8Array): Item[] => {
  const id = newChangeId();
  const count = Math.ceil(update.length / APP_DOCUMENT_UPDATE_MAX_BYTES);
  return Array.from({ length: count }, (_, index) => ({
    update: update.slice(index * APP_DOCUMENT_UPDATE_MAX_BYTES, (index + 1) * APP_DOCUMENT_UPDATE_MAX_BYTES),
    part: { id, index, count },
  }));
};

const takeBatch = (items: Item[]): number => {
  if (items[0].part) return 1;
  let bytes = items[0].update.length;
  let count = 1;
  while (count < items.length && !items[count].part && bytes + items[count].update.length <= APP_DOCUMENT_UPDATE_MAX_BYTES) {
    bytes += items[count].update.length;
    count += 1;
  }
  return count;
};

const merge = (items: Item[]): Uint8Array => (items.length === 1 ? items[0].update : Y.mergeUpdates(items.map((item) => item.update)));

export const createUploadQueue = (send: SendUpload, { stagesParts = () => false }: UploadQueueOptions = {}): UploadQueue => {
  const pending = new Map<string, Pending>();
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushQueued = false;

  const flush = (): void => {
    const next = pending.entries().next();
    if (next.done) return;
    const [key, entry] = next.value;
    const stages = stagesParts();
    if (stages === null) return;
    const [first] = entry.items;
    if (stages && !first.part && first.update.length > APP_DOCUMENT_UPDATE_MAX_BYTES) {
      entry.items.splice(0, 1, ...partsOf(first.update));
    }
    const batch = entry.items.slice(0, takeBatch(entry.items));
    if (!send(entry.appId, entry.replicaId, merge(batch), batch[0].part)) return;
    entry.items.splice(0, batch.length);
    if (entry.items.length === 0) pending.delete(key);
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
      const entry = pending.get(key);
      if (entry) entry.items.push({ update });
      else pending.set(key, { appId, replicaId, items: [{ update }] });
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
