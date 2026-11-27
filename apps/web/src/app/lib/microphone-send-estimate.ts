import type { WebcamProducerNetworkProfile } from "./webcam-codec";

const PROFILE_FLOORS_BPS: ReadonlyArray<{
  profile: WebcamProducerNetworkProfile;
  floorBps: number;
}> = [
  { profile: "good", floorBps: 200_000 },
  { profile: "fair", floorBps: 140_000 },
  { profile: "poor", floorBps: 90_000 },
];

const RANK: Record<WebcamProducerNetworkProfile, number> = {
  good: 1,
  fair: 2,
  poor: 3,
  emergency: 4,
};

const DOWNGRADE_AFTER_MS = 3_000;
const UPGRADE_AFTER_MS = 8_000;
const UPGRADE_HEADROOM = 1.25;

const profileForEstimate = (estimateBps: number): WebcamProducerNetworkProfile =>
  PROFILE_FLOORS_BPS.find(({ floorBps }) => estimateBps >= floorBps)?.profile ??
  "emergency";

export type MicrophoneSendEstimateState = {
  profile: WebcamProducerNetworkProfile;
  pending: WebcamProducerNetworkProfile | null;
  pendingSince: number;
};

export const INITIAL_MICROPHONE_SEND_ESTIMATE_STATE: MicrophoneSendEstimateState =
  { profile: "good", pending: null, pendingSince: 0 };

export const stepMicrophoneSendEstimate = (
  state: MicrophoneSendEstimateState,
  estimateBps: number | null | undefined,
  nowMs: number,
): MicrophoneSendEstimateState => {
  if (
    typeof estimateBps !== "number" ||
    !Number.isFinite(estimateBps) ||
    estimateBps <= 0
  ) {
    return state.pending ? { ...state, pending: null } : state;
  }
  const lower = profileForEstimate(estimateBps);
  const higher = profileForEstimate(estimateBps / UPGRADE_HEADROOM);
  const target =
    RANK[lower] > RANK[state.profile]
      ? lower
      : RANK[higher] < RANK[state.profile]
        ? higher
        : state.profile;
  if (target === state.profile) {
    return state.pending ? { ...state, pending: null } : state;
  }
  if (state.pending !== target) {
    return { ...state, pending: target, pendingSince: nowMs };
  }
  const holdMs =
    RANK[target] > RANK[state.profile] ? DOWNGRADE_AFTER_MS : UPGRADE_AFTER_MS;
  return nowMs - state.pendingSince >= holdMs
    ? { profile: target, pending: null, pendingSince: nowMs }
    : state;
};
