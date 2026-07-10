export type PlaybackState = "playing" | "paused";

/**
 * One playback record. Exactly one is held in the doc at a time. An acting
 * client overwrites it on play / pause / seek / rate change.
 */
export type PlaybackRecord = {
  state: PlaybackState;
  /** Player position, in seconds, at the moment the record was written. */
  positionSeconds: number;
  /** ms epoch stamped by the author at the moment of the change. */
  updatedAt: number;
  /** Playback rate; default 1. */
  rate: number;
  /**
   * Fresh videos keep this intent until the first explicit playback action;
   * active live broadcasts then follow their moving edge instead of a time.
   */
  liveEdge: boolean;
};

/** An up-next queue entry. */
export type QueueItem = {
  id: string;
  videoId: string;
  title: string | null;
  addedById: string | null;
  addedByName: string | null;
};

/** Author identity attached to writes that record who acted. */
export type WriteContext = {
  userId?: string | null;
  userName?: string | null;
};
