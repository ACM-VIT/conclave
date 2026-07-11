/**
 * Server-side product analytics (PostHog) for the SFU.
 *
 * Design contract:
 *   - STRICTLY OPT-IN. With no `SFU_POSTHOG_KEY` set, `config.analytics.enabled`
 *     is false: NO client is ever constructed, and every exported function is a
 *     no-op. Zero network, zero allocation, zero overhead.
 *   - EXACTLY ONE client per process. The SFU is long-lived, so we construct a
 *     single batching `PostHog` client lazily on first use and reuse it. Events
 *     are buffered and flushed by `flushAt` / `flushInterval`, and on graceful
 *     shutdown via `shutdownAnalytics()`.
 *   - NEVER throws into the caller. Analytics is best-effort telemetry that must
 *     not break a socket handler; every public call is wrapped in try/catch.
 *
 * This module is transport-agnostic and generic: it knows nothing about games
 * specifically. The game handlers build event names + property bags and hand
 * them here. Group analytics (associating each event with the meeting/room) is
 * a first-class parameter so the whole game lifecycle for one room rolls up
 * under a single `room` group in PostHog.
 */

import { PostHog } from "posthog-node";
import { config as sfuConfig } from "../../config/config.js";
import { Logger } from "../../utilities/loggers.js";

/** The PostHog group type used to roll events up by meeting/room. */
const ROOM_GROUP_TYPE = "room" as const;

/** Property values we are willing to send. Deliberately NON-PII: only ids,
 *  counts, booleans, durations, phase labels, and numeric/enum config. Never
 *  free text, names, chat, or user-authored content. */
type AnalyticsPropertyValue = string | number | boolean | null;
export type AnalyticsProperties = Record<string, AnalyticsPropertyValue>;

export type CaptureGameEventArgs = {
  /** snake_case object_action event name, e.g. `game_started`. */
  event: string;
  /** Most stable identifier for the acting participant (see gameHandlers). */
  distinctId: string;
  /** The meeting/room identifier, `room.channelId`. Associates the event with
   *  the `room` group so a whole play rolls up under one meeting. */
  roomKey: string;
  /** Non-PII event properties. */
  properties?: AnalyticsProperties;
};

// ---------------------------------------------------------------------------
// Single lazily-constructed client for the process.
// ---------------------------------------------------------------------------

let client: PostHog | null = null;
let constructionAttempted = false;

/**
 * Returns the process-wide PostHog client, constructing it on first use.
 * Returns null (and never constructs) when analytics is disabled or if the
 * client failed to construct once already.
 */
const getClient = (): PostHog | null => {
  if (!sfuConfig.analytics.enabled) return null;
  if (client) return client;
  if (constructionAttempted) return client; // failed before, do not retry
  constructionAttempted = true;
  try {
    client = new PostHog(sfuConfig.analytics.projectApiKey, {
      host: sfuConfig.analytics.host,
      flushAt: sfuConfig.analytics.flushAt,
      flushInterval: sfuConfig.analytics.flushIntervalMs,
    });
    Logger.info(
      `[Analytics] PostHog enabled (host: ${sfuConfig.analytics.host})`,
    );
  } catch (error) {
    client = null;
    Logger.warn("[Analytics] failed to construct PostHog client", error);
  }
  return client;
};

// Track which (room, distinctId) pairs we've already sent a `$groupidentify`
// for, so we register the group once instead of on every event. Bounded in
// practice by concurrent rooms; cleared on shutdown.
const identifiedRoomGroups = new Set<string>();

/**
 * Capture one game lifecycle event, associated with its meeting/room group.
 *
 * Never throws. No-ops entirely when analytics is disabled. Best-effort: any
 * failure is logged at warn and swallowed so the socket flow is unaffected.
 */
export const captureGameEvent = ({
  event,
  distinctId,
  roomKey,
  properties,
}: CaptureGameEventArgs): void => {
  const posthog = getClient();
  if (!posthog) return;
  if (!distinctId || !roomKey) return; // never send anonymous/ungrouped
  try {
    // Register the room as a group once per (room, actor). `groupIdentify`
    // creates the group + group type if they don't exist. We intentionally do
    // NOT attach group properties here (no room name / no PII); the group key
    // alone is enough to roll events up.
    const groupCacheKey = `${roomKey}::${distinctId}`;
    if (!identifiedRoomGroups.has(groupCacheKey)) {
      posthog.groupIdentify({
        groupType: ROOM_GROUP_TYPE,
        groupKey: roomKey,
        distinctId,
      });
      identifiedRoomGroups.add(groupCacheKey);
    }

    posthog.capture({
      distinctId,
      event,
      properties,
      groups: { [ROOM_GROUP_TYPE]: roomKey },
    });
  } catch (error) {
    // Telemetry must never surface to the user or break the calling flow.
    Logger.warn(`[Analytics] capture failed for ${event}`, error);
  }
};

/**
 * Flush buffered events and close the client. Safe to call when analytics is
 * disabled (no-op) or never initialized. Wired into the SFU graceful-shutdown
 * path so events aren't lost on exit. Never throws.
 */
export const shutdownAnalytics = async (): Promise<void> => {
  const active = client;
  if (!active) return;
  client = null;
  identifiedRoomGroups.clear();
  try {
    // `shutdown()` flushes the queue then tears the client down. The typings
    // annotate the return as `void`, but at runtime it resolves a Promise once
    // the final flush completes; await it so buffered events reach PostHog
    // before the process exits. Bounded by `shutdownTimeoutMs`.
    await Promise.resolve(
      active.shutdown(sfuConfig.analytics.shutdownTimeoutMs),
    );
  } catch (error) {
    Logger.warn("[Analytics] shutdown flush failed", error);
  }
};
