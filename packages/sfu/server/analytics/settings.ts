/**
 * The SFU's analytics settings, read straight from the environment and never
 * from the configuration, so crash reporting works even when the
 * configuration fails as it loads. Nothing here throws: a value that does not
 * parse falls back to its default.
 */

import "../../config/env.js";
import { normalizeSfuRegion } from "../regions.js";

const DEVELOPMENT_SECRET = "development-secret";

const integer = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  return value && Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

// Strictly opt-in: with no project key, no client is ever constructed and
// nothing is sent. Never hardcode a key; it comes from the environment.
const projectApiKey =
  process.env.SFU_POSTHOG_KEY?.trim() || process.env.SFU_POSTHOG_PROJECT_API_KEY?.trim() || "";
// Test runs load the same .env files as dev, so a developer's real key would
// otherwise send test crashes to the production project.
const disabled =
  process.env.SFU_POSTHOG_ENABLED === "0" ||
  process.env.SFU_POSTHOG_ENABLED?.toLowerCase() === "false" ||
  Boolean(process.env.VITEST);
const secret = process.env.SFU_SECRET?.trim();

export const analyticsSettings = {
  enabled: !disabled && Boolean(projectApiKey),
  projectApiKey,
  // The PostHog EU cloud ingestion host unless SFU_POSTHOG_HOST says otherwise.
  host: process.env.SFU_POSTHOG_HOST?.trim() || "https://eu.i.posthog.com",
  // A game meeting is long-lived and low-volume, so flush on a small batch or
  // a short interval to keep events fresh without chattiness.
  flushAt: integer(process.env.SFU_POSTHOG_FLUSH_AT, 20, 1, 1000),
  flushIntervalMs: integer(process.env.SFU_POSTHOG_FLUSH_INTERVAL_MS, 10000, 0, 300000),
  // Per-request cap, so an unreachable PostHog only ever holds a socket open
  // this long.
  requestTimeoutMs: integer(process.env.SFU_POSTHOG_REQUEST_TIMEOUT_MS, 5000, 500, 60000),
  // Bounded time to flush buffered events on graceful shutdown.
  shutdownTimeoutMs: integer(process.env.SFU_POSTHOG_SHUTDOWN_TIMEOUT_MS, 5000, 0, 60000),
  instanceId: process.env.SFU_INSTANCE_ID || `sfu-${process.pid}`,
  region: normalizeSfuRegion(process.env.SFU_REGION),
  /** The real SFU_SECRET, or null when unset or the public development fallback. */
  secret: secret && secret !== DEVELOPMENT_SECRET ? secret : null,
};
