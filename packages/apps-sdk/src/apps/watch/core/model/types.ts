export type PlaybackState = "playing" | "paused";

export type PlaybackRecord = {
  state: PlaybackState;
  positionSeconds: number;
  updatedAt: number;
  rate: number;
  liveEdge: boolean;
};

export type QueueItem = {
  id: string;
  videoId: string;
  title: string | null;
  addedById: string | null;
  addedByName: string | null;
};

export type WriteContext = {
  userId?: string | null;
  userName?: string | null;
};
