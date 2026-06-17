"use client";

/**
 * Thin client telemetry shim.
 *
 * posthog-js is NOT a dependency of this app (checked apps/web/package.json),
 * so this module is a deliberately minimal, dependency-free indirection layer.
 * Every capture is a safe no-op until a real sink is wired in — it never throws
 * and never blocks the caller (join, reconnect, etc.).
 *
 * To go live, install `posthog-js` and replace the `sink` below with a PostHog
 * client, e.g. inside a `"use client"` provider:
 *
 *   import posthog from "posthog-js";
 *   posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
 *     api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.posthog.com",
 *   });
 *   setTelemetrySink((event, props) => posthog.capture(event, props));
 *
 * Nothing else in the app needs to change — call sites only ever touch
 * `telemetry.capture(...)`.
 */

export type TelemetryProps = Record<string, unknown>;

export type TelemetrySink = (
  event: string,
  props?: TelemetryProps,
) => void;

/**
 * Known meeting-reliability events. Kept as a union so call sites stay
 * consistent and a future PostHog dashboard has a stable event taxonomy.
 */
export type TelemetryEvent =
  | "meet_join_attempt"
  | "meet_join_success"
  | "meet_join_failure"
  | "meet_reconnect_attempt"
  | "meet_reconnect_success"
  | "meet_reconnect_give_up"
  | "meet_turn_relay_activated";

let sink: TelemetrySink | null = null;

/**
 * Wire (or unwire) the real telemetry backend. Idempotent and side-effect free
 * beyond swapping the sink reference. Pass `null` to disable.
 */
export function setTelemetrySink(next: TelemetrySink | null): void {
  sink = next;
}

/** Whether a real sink is currently configured. */
export function isTelemetryConfigured(): boolean {
  return sink !== null;
}

/**
 * Capture an event. No-ops (and swallows any sink error) when telemetry is
 * unconfigured or the sink throws — callers must never have to guard this.
 */
export function capture(
  event: TelemetryEvent | string,
  props?: TelemetryProps,
): void {
  if (!sink) return;
  try {
    sink(event, props);
  } catch {
    // Telemetry must never surface to the user or break the calling flow.
  }
}

export const telemetry = {
  capture,
  setSink: setTelemetrySink,
  isConfigured: isTelemetryConfigured,
};

export default telemetry;
