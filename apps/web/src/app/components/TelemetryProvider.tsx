"use client";

import { useEffect, type ReactNode } from "react";
import { installCallErrorCapture } from "../lib/call-error-capture";
import { setTelemetryClient } from "../lib/telemetry";
import { scrubTelemetryEvent } from "../lib/telemetry-privacy";

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const posthogHost =
  process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.posthog.com";
// Local dev only sends events when someone opts in.
const telemetryAllowed =
  process.env.NODE_ENV === "production" ||
  process.env.NEXT_PUBLIC_POSTHOG_DEV === "1";

let started = false;

function startTelemetry(key: string): void {
  if (started) return;
  started = true;
  void Promise.all([
    import("posthog-js"),
    import("posthog-js/dist/exception-autocapture"),
  ])
    .then(([{ default: posthog }]) => {
      posthog.init(key, {
        api_host: posthogHost,
        capture_pageview: false,
        capture_pageleave: false,
        autocapture: false,
        disable_session_recording: true,
        disable_surveys: true,
        advanced_disable_flags: true,
        disable_external_dependency_loading: true,
        person_profiles: "identified_only",
        capture_exceptions: {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: false,
        },
        before_send: scrubTelemetryEvent,
      });
      posthog.register({
        client_version: process.env.NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION,
      });
      setTelemetryClient({
        capture: (event, props, options) => {
          posthog.capture(
            event,
            props,
            options?.immediate
              ? { transport: "sendBeacon", send_instantly: true }
              : undefined,
          );
        },
        captureException: (error, props) => {
          posthog.captureException(error, props);
        },
      });
      installCallErrorCapture((error, props) => {
        posthog.captureException(error, props);
      });
    })
    .catch(() => {
      started = false;
    });
}

/**
 * Starts PostHog once for the page's lifetime. It is never torn down, so the
 * root error boundary can still report after the layout unmounts.
 */
function TelemetryProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (posthogKey && telemetryAllowed) startTelemetry(posthogKey);
  }, []);

  return <>{children}</>;
}

export default TelemetryProvider;
