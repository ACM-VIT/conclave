import * as Y from "yjs";
import { APP_DOCUMENT_UPDATE_MAX_BYTES, APP_DOCUMENT_UPLOAD_INTERVAL_MS, APP_DOCUMENT_UPLOAD_LIST_MAX } from "../limits";
import type { AppsUpdatePart } from "../types/index";

type Item = { update: Uint8Array; part?: AppsUpdatePart; whole?: Uint8Array };
type Pending = { appId: string; replicaId: string | undefined; items: Item[] };
type Sent = { changes: Uint8Array[]; bytes: number; partId?: string };

export type Upload = { update: Uint8Array; part?: AppsUpdatePart } | { updates: Uint8Array[] };

export type SendUpload = (appId: string, replicaId: string | undefined, upload: Upload, settled?: () => void) => boolean;

export type UploadQueueOptions = {
  stagesParts?: () => boolean | null;
  takesLists?: () => boolean;
  onProgress?: () => void;
};

export type UploadQueue = {
  add: (appId: string, replicaId: string | undefined, update: Uint8Array) => void;
  hasPending: (appId: string) => boolean;
  take: (appId: string) => Uint8Array[];
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
    whole: update,
  }));
};

const takeBatch = (items: Item[], roomForChanges: number, roomForBytes: number): number => {
  let bytes = 0;
  let count = 0;
  while (
    count < items.length &&
    count < roomForChanges &&
    !items[count].part &&
    bytes + items[count].update.length <= roomForBytes
  ) {
    bytes += items[count].update.length;
    count += 1;
  }
  return count;
};

const uploadOf = (batch: Item[], takesLists: boolean): Upload => {
  if (batch.length === 1) return batch[0].part ? { update: batch[0].update, part: batch[0].part } : { update: batch[0].update };
  if (takesLists) return { updates: batch.map((item) => item.update) };
  return { update: Y.mergeUpdates(batch.map((item) => item.update)) };
};

export const createUploadQueue = (
  send: SendUpload,
  { stagesParts = () => false, takesLists = () => false, onProgress }: UploadQueueOptions = {},
): UploadQueue => {
  const pending = new Map<string, Pending>();
  const unsettled = new Map<string, Sent[]>();
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushQueued = false;

  const settle = (appId: string, record: Sent) => () => {
    const records = unsettled.get(appId);
    const at = records?.indexOf(record) ?? -1;
    if (!records || at < 0) return;
    records.splice(at, 1);
    if (records.length === 0) unsettled.delete(appId);
    schedule();
    onProgress?.();
  };

  const flush = (): void => {
    const next = pending.entries().next();
    if (next.done) return;
    const [key, entry] = next.value;
    const stages = stagesParts();
    if (stages === null) return;
    const lists = takesLists();
    const [first] = entry.items;
    if (stages && !first.part && first.update.length > APP_DOCUMENT_UPDATE_MAX_BYTES) {
      entry.items.splice(0, 1, ...partsOf(first.update));
    }
    const head = entry.items[0];
    const inFlight = lists ? (unsettled.get(entry.appId) ?? []) : [];
    let batch: Item[];
    if (head.part) {
      if (head.part.index === 0 && inFlight.length > 0) return;
      batch = [head];
    } else {
      const changes = inFlight.reduce((total, record) => total + record.changes.length, 0);
      const bytes = inFlight.reduce((total, record) => total + record.bytes, 0);
      const count = takeBatch(entry.items, APP_DOCUMENT_UPLOAD_LIST_MAX - changes, APP_DOCUMENT_UPDATE_MAX_BYTES - bytes);
      if (count === 0 && inFlight.length > 0) return;
      batch = entry.items.slice(0, Math.max(1, count));
    }
    let record: Sent | null = null;
    let settled: (() => void) | undefined;
    if (lists && head.part) {
      const whole = head.whole ?? head.update;
      record = head.part.index === 0 ? { changes: [whole], bytes: whole.length, partId: head.part.id } : null;
      const part = head.part;
      settled = part.index === part.count - 1 ? () => settleStaged(entry.appId, part.id) : undefined;
    } else if (lists) {
      record = { changes: batch.map((item) => item.update), bytes: batch.reduce((total, item) => total + item.update.length, 0) };
      settled = settle(entry.appId, record);
    }
    if (!send(entry.appId, entry.replicaId, uploadOf(batch, lists), settled)) return;
    if (record) unsettled.set(entry.appId, [...(unsettled.get(entry.appId) ?? []), record]);
    entry.items.splice(0, batch.length);
    if (entry.items.length === 0) pending.delete(key);
    lastSentAt = Date.now();
    schedule();
    onProgress?.();
  };

  const settleStaged = (appId: string, partId: string): void => {
    const record = unsettled.get(appId)?.find((sent) => sent.partId === partId);
    if (record) settle(appId, record)();
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

  const drop = (appId: string): void => {
    unsettled.delete(appId);
    for (const [key, entry] of pending) {
      if (entry.appId === appId) pending.delete(key);
    }
  };

  return {
    hasPending: (appId) => unsettled.has(appId) || [...pending.values()].some((entry) => entry.appId === appId),
    add: (appId, replicaId, update) => {
      const key = `${appId}\u0000${replicaId ?? ""}`;
      const entry = pending.get(key);
      if (entry) entry.items.push({ update });
      else pending.set(key, { appId, replicaId, items: [{ update }] });
      schedule();
    },
    take: (appId) => {
      const records = unsettled.get(appId) ?? [];
      const changes = records.flatMap((record) => record.changes);
      const staged = new Set(records.flatMap((record) => (record.partId ? [record.partId] : [])));
      for (const entry of pending.values()) {
        if (entry.appId !== appId) continue;
        for (const item of entry.items) {
          if (!item.part) changes.push(item.update);
          else if (!staged.has(item.part.id)) {
            staged.add(item.part.id);
            changes.push(item.whole ?? item.update);
          }
        }
      }
      drop(appId);
      return changes;
    },
    drop,
    wake: schedule,
    clear: () => {
      pending.clear();
      unsettled.clear();
      clearTimeout(timer);
      timer = undefined;
    },
  };
};
