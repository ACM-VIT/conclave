import type {
  WebinarConfigSnapshot,
  WebinarQaChangedNotification,
  WebinarQaEntry,
  WebinarQaSnapshot,
} from "./types";

/**
 * The old events' Q&A list for one connection, or null while it has none:
 * before its first list, and once the connection has ended.
 */
export type WebinarQaList = WebinarQaEntry[] | null;

const byAsked = (a: WebinarQaEntry, b: WebinarQaEntry) => a.askedAt - b.askedAt;

/** A whole list replaces whatever was held. */
export const qaListFromSnapshot = (snapshot: WebinarQaSnapshot): WebinarQaEntry[] =>
  [...(snapshot.entries ?? [])].sort(byAsked);

/**
 * One question changed or went. A connection sent no list yet holds an empty
 * one: a server that sends no list when a meeting becomes a webinar still
 * sends each question.
 */
export const withQaChange = (
  held: WebinarQaList,
  notification: WebinarQaChangedNotification,
): WebinarQaEntry[] => {
  const list = held ?? [];
  if (notification.removedId) {
    return list.filter((entry) => entry.id !== notification.removedId);
  }
  const entry = notification.entry;
  if (!entry) return list;
  const existingIndex = list.findIndex((candidate) => candidate.id === entry.id);
  if (existingIndex === -1) return [...list, entry].sort(byAsked);
  const next = list.slice();
  next[existingIndex] = {
    ...entry,
    hasUpvoted: entry.hasUpvoted ?? list[existingIndex].hasUpvoted,
  };
  return next;
};

/** Webinar Q&A ends with webinar mode: nothing of it is kept. */
export const qaListForConfig = (
  list: WebinarQaList,
  config: WebinarConfigSnapshot,
): WebinarQaList => {
  if (config.enabled) return list;
  return list !== null && list.length === 0 ? list : [];
};
