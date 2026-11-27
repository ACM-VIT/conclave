import type { ProducerType } from "../config/classes/Client.js";

type ConsumerPriorityParseResult =
  | { ok: true; value: number | null | undefined }
  | { ok: false; error: string };

export const MIN_CONSUMER_PRIORITY = 1;
export const MAX_CONSUMER_PRIORITY = 255;

export const WEBCAM_KEY_FRAME_REQUEST_DELAY_MS = 150;
export const SCREEN_KEY_FRAME_REQUEST_DELAY_MS = 1_000;

export const parseConsumerPriority = (
  value: unknown,
  options: { allowNull?: boolean } = {},
): ConsumerPriorityParseResult => {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (value === null && options.allowNull) {
    return { ok: true, value: null };
  }

  const priority = Number(value);
  if (
    !Number.isInteger(priority) ||
    priority < MIN_CONSUMER_PRIORITY ||
    priority > MAX_CONSUMER_PRIORITY
  ) {
    return { ok: false, error: "Invalid consumer priority" };
  }

  return { ok: true, value: priority };
};

export const getVideoKeyFrameRequestDelayMs = (
  type: ProducerType,
): number =>
  type === "screen"
    ? SCREEN_KEY_FRAME_REQUEST_DELAY_MS
    : WEBCAM_KEY_FRAME_REQUEST_DELAY_MS;

export const shouldExplicitlyRequestConsumerKeyFrame = ({
  kind,
  wasPaused,
  requested,
}: {
  kind: "audio" | "video";
  wasPaused: boolean;
  requested: boolean;
}): boolean => kind === "video" && requested && !wasPaused;
