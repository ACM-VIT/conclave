import type { WebinarQaStatus } from "../types.js";
import type { SfuState } from "./state.js";

/**
 * Q&A runs one store per room under two audience rules. In a webinar,
 * attendees ask and hosts publish questions by answering them. In a regular
 * meeting, anyone asks and every question is public until a host hides it.
 */
export type QaMode = "webinar" | "meeting";

const PUBLIC_STATUSES: Record<QaMode, ReadonlySet<WebinarQaStatus>> = {
  webinar: new Set<WebinarQaStatus>(["answering", "answered"]),
  meeting: new Set<WebinarQaStatus>(["pending", "answering", "answered"]),
};

export const getQaMode = (state: SfuState, channelId: string): QaMode =>
  state.webinarConfigs.get(channelId)?.enabled ? "webinar" : "meeting";

/** Public questions reach the whole room; the rest only hosts and the asker. */
export const isQaStatusPublic = (
  status: WebinarQaStatus,
  mode: QaMode,
): boolean => PUBLIC_STATUSES[mode].has(status);
