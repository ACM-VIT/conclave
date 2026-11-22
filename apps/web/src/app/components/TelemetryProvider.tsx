"use client";

import { useEffect, type ReactNode } from "react";
import { setTelemetrySink } from "../lib/telemetry";
import { scrubTelemetryEvent } from "../lib/telemetry-privacy";

function TelemetryProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return;

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
        before_send: scrubTelemetryEvent,
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
