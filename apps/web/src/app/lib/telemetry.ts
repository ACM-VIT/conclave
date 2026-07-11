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

type TelemetryProps = Record<string, unknown>;

type TelemetrySink = (
  event: string,
  props?: TelemetryProps,
) => void;

let sink: TelemetrySink | null = null;

/**
 * Wire (or unwire) the real telemetry backend. Idempotent and side-effect free
 * beyond swapping the sink reference. Pass `null` to disable.
 */
export function setTelemetrySink(next: TelemetrySink | null): void {
  sink = next;
}

/**
 * Capture an event. No-ops (and swallows any sink error) when telemetry is
 * unconfigured or the sink throws — callers must never have to guard this.
 */
function capture(event: string, props?: TelemetryProps): void {
  if (!sink) return;
  try {
    sink(event, props);
  } catch {
    // Telemetry must never surface to the user or break the calling flow.
  }
}

export const telemetry = {
  capture,
};
