import type { TranscriptServiceVersion } from "@conclave/meeting-core/transcript-types";
import type { Env } from "./types";
import { toStringValue } from "./utils";

const nullableString = (value: unknown): string | null => {
  const normalized = toStringValue(value).trim();
  return normalized || null;
};

export const getTranscriptServiceVersion = (
  env: Env,
): TranscriptServiceVersion => {
  const metadata = env.CF_VERSION_METADATA;
  return {
    id: nullableString(metadata?.id) ?? "local",
    tag: nullableString(metadata?.tag),
    timestamp: nullableString(metadata?.timestamp),
  };
};
