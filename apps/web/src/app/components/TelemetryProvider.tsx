"use client";

import { useEffect, type ReactNode } from "react";
import { setTelemetrySink } from "../lib/telemetry";

/**
 * Wires the telemetry shim (lib/telemetry) to PostHog — but ONLY when a key is
 * configured. With no `NEXT_PUBLIC_POSTHOG_KEY` set there is zero tracking, no
 * network request, and no cookie: the shim stays a no-op and this provider just
 * renders its children. So telemetry is strictly opt-in per deployment.
 *
 * Defaults to the ACM-VIT EU PostHog host. We disable autocapture + pageviews
 * and only emit the explicit meeting-reliability events (join/reconnect/TURN)
 * the app captures via `telemetry.capture(...)`.
 */
function TelemetryProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return; // opt-in only — no key, no tracking

    let active = true;
    const host =
      process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.posthog.com";

    void import("posthog-js").then(({ default: posthog }) => {
      if (!active) return;
      posthog.init(key, {
        api_host: host,
        capture_pageview: false,
        autocapture: false,
        person_profiles: "identified_only",
      });
      setTelemetrySink((event, props) => {
        posthog.capture(event, props);
      });
    });

    return () => {
      active = false;
      setTelemetrySink(null);
    };
  }, []);

  return <>{children}</>;
}

export default TelemetryProvider;
