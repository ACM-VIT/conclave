import type { PlaybackState } from "../core/model/types";

const LIVE_EDGE_HEADROOM_SECONDS = 1.25;
export const LIVE_EDGE_TOLERANCE_SECONDS = 4;

const SETTLED_DRIFT_SECONDS = 0.45;
const HARD_SEEK_DRIFT_SECONDS = 5;

export type PlaybackCorrection =
  | { kind: "settled"; rate: number }
  | { kind: "rate"; rate: number }
  | { kind: "seek"; rate: number; target: number };

export const planPlaybackCorrection = (input: {
  current: number;
  target: number;
  state: PlaybackState;
  baseRate: number;
  forceSeek?: boolean;
}): PlaybackCorrection => {
  const drift = input.target - input.current;
  const absoluteDrift = Math.abs(drift);
  if (absoluteDrift <= SETTLED_DRIFT_SECONDS) {
    return { kind: "settled", rate: input.baseRate };
  }
  if (
    input.forceSeek === true ||
    input.state === "paused" ||
    absoluteDrift >= HARD_SEEK_DRIFT_SECONDS
  ) {
    return { kind: "seek", rate: input.baseRate, target: input.target };
  }

  return {
    kind: "rate",
    rate:
      drift > 0
        ? Math.min(2, input.baseRate * 1.25)
        : Math.max(0.25, input.baseRate * 0.75),
  };
};

export const liveEdgeTime = (duration: number): number | null => {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return Math.max(0, duration - LIVE_EDGE_HEADROOM_SECONDS);
};

export const liveEdgeLag = (
  currentTime: number,
  duration: number,
): number | null => {
  const edge = liveEdgeTime(duration);
  if (edge === null || !Number.isFinite(currentTime)) return null;
  return Math.max(0, edge - currentTime);
};
