import * as Y from "yjs";
import {
  createAppDoc,
  ensureAppArray,
  ensureAppMap,
  getAppRoot,
} from "../../../../sdk/doc/createAppDoc";
import type {
  PlaybackRecord,
  PlaybackState,
  QueueItem,
  WriteContext,
} from "../model/types";

// The single Yjs root for the Watch together app. Everything the app needs to
// converge on lives under this map: the current video, the playback record, and
// the queue. Nobody streams video here; this doc syncs intent only and each
// participant's own YouTube player fetches the media directly.
const ROOT_KEY = "watch";
const VIDEO_ID_KEY = "videoId";
const VIDEO_TITLE_KEY = "videoTitle";
const PLAYBACK_KEY = "playback";
const QUEUE_KEY = "queue";
const REQUEST_RESOLUTIONS_KEY = "requestResolutions";

// Playback sub-map keys.
const PB_STATE = "state";
const PB_POSITION = "positionSeconds";
const PB_UPDATED_AT = "updatedAt";
const PB_RATE = "rate";
const PB_LIVE_EDGE = "liveEdge";

const DEFAULT_RATE = 1;

type WatchRoot = Y.Map<unknown>;
type PlaybackMap = Y.Map<unknown>;
type QueueArray = Y.Array<QueueItem>;

const getRoot = (doc: Y.Doc): WatchRoot => getAppRoot(doc, ROOT_KEY);

const readPlaybackMap = (doc: Y.Doc): PlaybackMap | null => {
  const value = getRoot(doc).get(PLAYBACK_KEY);
  return value instanceof Y.Map ? (value as PlaybackMap) : null;
};

const ensurePlaybackMap = (doc: Y.Doc): PlaybackMap =>
  ensureAppMap(getRoot(doc), PLAYBACK_KEY);

const readQueueArray = (doc: Y.Doc): QueueArray | null => {
  const value = getRoot(doc).get(QUEUE_KEY);
  return value instanceof Y.Array ? (value as QueueArray) : null;
};

const ensureQueueArray = (doc: Y.Doc): QueueArray =>
  ensureAppArray(getRoot(doc), QUEUE_KEY) as QueueArray;

const readResolutionsMap = (doc: Y.Doc): Y.Map<unknown> | null => {
  const value = getRoot(doc).get(REQUEST_RESOLUTIONS_KEY);
  return value instanceof Y.Map ? (value as Y.Map<unknown>) : null;
};

const normalizeState = (value: unknown): PlaybackState =>
  value === "playing" ? "playing" : "paused";

const normalizePosition = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const normalizeRate = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_RATE;

const normalizeUpdatedAt = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

// A joining client must not author defaults before receiving the room state:
// Yjs map conflicts can otherwise let those defaults replace live content.
// Readers below normalize an empty document, and real actions create shared
// structures only when they have something to write.
export const createWatchDoc = (): Y.Doc => createAppDoc(ROOT_KEY);

/* ---- Queue requests ------------------------------------------------------
 * When the room is locked, non-admin doc writes are dropped server-side, so a
 * request cannot ride the doc. Requests travel via awareness (exempt from the
 * lock by design, and rightly ephemeral: leave the room, the request goes with
 * you). Only the HOST'S DECISION touches the doc: accept enqueues the item,
 * and either way a resolution marker is written here so the requester's client
 * knows to clear its pending state.
 * ------------------------------------------------------------------------ */

export type WatchRequestResolution = "added" | "declined";

const ensureResolutionsMap = (doc: Y.Doc): Y.Map<unknown> =>
  ensureAppMap(getRoot(doc), REQUEST_RESOLUTIONS_KEY);

/** Record the host's decision on a request (admin write). */
export const resolveWatchRequest = (
  doc: Y.Doc,
  requestId: string,
  resolution: WatchRequestResolution,
): void => {
  ensureResolutionsMap(doc).set(requestId, resolution);
};

/** Read the decision for a request id, if the host has made one. */
export const getWatchRequestResolution = (
  doc: Y.Doc,
  requestId: string,
): WatchRequestResolution | null => {
  const value = readResolutionsMap(doc)?.get(requestId);
  return value === "added" || value === "declined" ? value : null;
};

/** Expose the root map so the web layer never reaches into raw Yjs itself. */
export const getWatchRoot = (doc: Y.Doc): WatchRoot => getRoot(doc);

/** The video everyone is currently watching, or null when idle. */
export const getVideoId = (doc: Y.Doc): string | null => {
  const value = getRoot(doc).get(VIDEO_ID_KEY);
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** The current video's title (best effort, backfilled after start), or null. */
export const getVideoTitle = (doc: Y.Doc): string | null => {
  const value = getRoot(doc).get(VIDEO_TITLE_KEY);
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * Backfill the current video's title once metadata arrives. Guarded by video
 * id so a slow fetch can never label a video that is no longer playing.
 */
export const setVideoTitle = (
  doc: Y.Doc,
  videoId: string,
  title: string,
): void => {
  const root = getRoot(doc);
  doc.transact(() => {
    if (root.get(VIDEO_ID_KEY) !== videoId) return;
    root.set(VIDEO_TITLE_KEY, title);
  });
};

/** Backfill a queue item's title once metadata arrives. No-op if it is gone. */
export const setQueueItemTitle = (
  doc: Y.Doc,
  itemId: string,
  title: string,
): void => {
  const queue = readQueueArray(doc);
  if (!queue) return;
  doc.transact(() => {
    const list = queue.toArray();
    const index = list.findIndex((item) => item?.id === itemId);
    if (index === -1) return;
    const current = list[index];
    queue.delete(index, 1);
    queue.insert(index, [{ ...current, title }]);
  });
};

/**
 * Read the current playback record. Returns a fully-normalized object so callers
 * never have to defend against a partially-initialized Yjs map.
 */
export const getPlayback = (doc: Y.Doc): PlaybackRecord => {
  const playback = readPlaybackMap(doc);
  return {
    state: normalizeState(playback?.get(PB_STATE)),
    positionSeconds: normalizePosition(playback?.get(PB_POSITION)),
    updatedAt: normalizeUpdatedAt(playback?.get(PB_UPDATED_AT)),
    rate: normalizeRate(playback?.get(PB_RATE)),
    liveEdge: playback?.get(PB_LIVE_EDGE) === true,
  };
};

/** The full up-next queue, normalized to typed items. */
export const getQueue = (doc: Y.Doc): QueueItem[] => {
  return (readQueueArray(doc)?.toArray() ?? [])
    .filter(
      (item): item is QueueItem =>
        Boolean(item) &&
        typeof item.id === "string" &&
        typeof item.videoId === "string",
    );
};

/**
 * Write one playback record. This is the ONE write every acting client makes on
 * play / pause / seek / rate change. `positionSeconds` must be the player
 * position at the exact moment of the action, and `updatedAt` is stamped here so
 * every other client can extrapolate the live position.
 */
export const writePlayback = (
  doc: Y.Doc,
  next: {
    state: PlaybackState;
    positionSeconds: number;
    rate?: number;
    liveEdge?: boolean;
  },
): void => {
  doc.transact(() => {
    const playback = ensurePlaybackMap(doc);
    playback.set(PB_STATE, normalizeState(next.state));
    playback.set(PB_POSITION, normalizePosition(next.positionSeconds));
    playback.set(PB_RATE, normalizeRate(next.rate ?? DEFAULT_RATE));
    playback.set(PB_LIVE_EDGE, next.liveEdge === true);
    playback.set(PB_UPDATED_AT, Date.now());
  });
};

/**
 * Point the room at a video. Used both when starting the very first video and
 * when advancing to a queued item. Optionally seeds a fresh playback record so
 * a new video starts cleanly from the given position.
 */
export const setVideo = (
  doc: Y.Doc,
  videoId: string,
  options?: {
    play?: boolean;
    positionSeconds?: number;
    title?: string | null;
    liveEdge?: boolean;
  },
): void => {
  const root = getRoot(doc);
  doc.transact(() => {
    const playback = ensurePlaybackMap(doc);
    root.set(VIDEO_ID_KEY, videoId);
    root.set(VIDEO_TITLE_KEY, options?.title ?? null);
    playback.set(PB_STATE, options?.play === false ? "paused" : "playing");
    playback.set(PB_POSITION, normalizePosition(options?.positionSeconds ?? 0));
    playback.set(PB_RATE, DEFAULT_RATE);
    // Preserve explicit room-start intent until a real play/pause/seek write.
    // It is dormant for ordinary videos and becomes the default latest mode
    // only when metadata confirms that the source is actively live.
    playback.set(PB_LIVE_EDGE, options?.liveEdge !== false);
    playback.set(PB_UPDATED_AT, Date.now());
  });
};

/** Append an item to the up-next queue. */
export const enqueue = (
  doc: Y.Doc,
  input: { videoId: string; title?: string | null },
  ctx?: WriteContext,
): QueueItem => {
  const item: QueueItem = {
    id: createQueueId(),
    videoId: input.videoId,
    title: input.title ?? null,
    addedById: ctx?.userId ?? null,
    addedByName: ctx?.userName ?? null,
  };
  ensureQueueArray(doc).push([item]);
  return item;
};

/** Remove a queue item by its stable id. */
export const removeQueueItem = (doc: Y.Doc, itemId: string): void => {
  const queue = readQueueArray(doc);
  if (!queue) return;
  const list = queue.toArray();
  const index = list.findIndex((item) => item?.id === itemId);
  if (index === -1) return;
  queue.delete(index, 1);
};

/** Move a queue item one slot up or down. No-op at the edges or if gone. */
export const moveQueueItem = (
  doc: Y.Doc,
  itemId: string,
  direction: -1 | 1,
): void => {
  const queue = readQueueArray(doc);
  if (!queue) return;
  doc.transact(() => {
    const list = queue.toArray();
    const index = list.findIndex((item) => item?.id === itemId);
    if (index === -1) return;
    const target = index + direction;
    if (target < 0 || target >= list.length) return;
    const item = list[index];
    queue.delete(index, 1);
    queue.insert(target, [item]);
  });
};

/**
 * Jump a queued item to the screen right now, atomically: it leaves the queue
 * and becomes the current video with a fresh playing record in one transaction.
 */
export const playQueueItemNow = (doc: Y.Doc, itemId: string): void => {
  const queue = readQueueArray(doc);
  if (!queue) return;
  doc.transact(() => {
    const list = queue.toArray();
    const index = list.findIndex((item) => item?.id === itemId);
    if (index === -1) return;
    const item = list[index];
    if (!item || typeof item.videoId !== "string") return;
    queue.delete(index, 1);
    const root = getRoot(doc);
    const playback = ensurePlaybackMap(doc);
    root.set(VIDEO_ID_KEY, item.videoId);
    root.set(VIDEO_TITLE_KEY, item.title ?? null);
    playback.set(PB_STATE, "playing");
    playback.set(PB_POSITION, 0);
    playback.set(PB_RATE, DEFAULT_RATE);
    playback.set(PB_LIVE_EDGE, true);
    playback.set(PB_UPDATED_AT, Date.now());
  });
};

/**
 * Advance to the next queued video. Returns the video id that became active, or
 * null if the queue was empty.
 *
 * DOUBLE-ADVANCE GUARD: the ENDED event fires on every client, so several may
 * race to advance. `expectedCurrentVideoId` is the video that just ended; we
 * only advance if the doc STILL points at it. The first writer flips `videoId`
 * inside the transaction, so every later racer sees a mismatch and no-ops. This
 * makes the queue head move exactly once per ended video.
 */
export const advanceQueue = (
  doc: Y.Doc,
  expectedCurrentVideoId: string | null,
): string | null => {
  let advancedTo: string | null = null;
  doc.transact(() => {
    if (getVideoId(doc) !== expectedCurrentVideoId) {
      return;
    }
    const queue = readQueueArray(doc);
    if (!queue) {
      return;
    }
    if (queue.length === 0) {
      return;
    }
    const next = queue.get(0);
    if (!next || typeof next.videoId !== "string") {
      queue.delete(0, 1);
      return;
    }
    queue.delete(0, 1);
    const root = getRoot(doc);
    const playback = ensurePlaybackMap(doc);
    root.set(VIDEO_ID_KEY, next.videoId);
    root.set(VIDEO_TITLE_KEY, next.title ?? null);
    playback.set(PB_STATE, "playing");
    playback.set(PB_POSITION, 0);
    playback.set(PB_RATE, DEFAULT_RATE);
    playback.set(PB_LIVE_EDGE, true);
    playback.set(PB_UPDATED_AT, Date.now());
    advancedTo = next.videoId;
  });
  return advancedTo;
};

/**
 * Compute where playback should be right now given a record and the current
 * clock. This is the extrapolation at the heart of sync: while playing, the
 * position advances in real time from `updatedAt`; while paused it is frozen.
 * Author clocks differ slightly, which the drift threshold in the player hook
 * absorbs, so no server-clock plumbing is needed.
 */
export const expectedPosition = (
  playback: PlaybackRecord,
  now: number = Date.now(),
): number => {
  if (playback.state !== "playing") {
    return playback.positionSeconds;
  }
  const elapsedSeconds = Math.max(0, (now - playback.updatedAt) / 1000);
  return playback.positionSeconds + elapsedSeconds * playback.rate;
};

const createQueueId = (): string => {
  const hasRandomUUID =
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function";
  const random = hasRandomUUID
    ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `wt_${Date.now().toString(36)}_${random}`;
};
