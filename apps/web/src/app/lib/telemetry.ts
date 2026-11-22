"use client";

import type { PostHog } from "posthog-js";
import { installCallErrorCapture } from "./call-error-capture";
import { scrubTelemetryEvent } from "./telemetry-privacy";

export type TelemetryProps = Record<string, unknown>;

export type TelemetryCaptureOptions = {
  /** Send now with sendBeacon; for events captured while the page unloads. */
  immediate?: boolean;
};

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const posthogHost =
  process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.posthog.com";

/** False without a project key, and in `next dev` unless someone opts in. */
export const telemetryEnabled =
  Boolean(posthogKey) &&
  (process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_POSTHOG_DEV === "1");

// Reports made while posthog-js loads, such as an error boundary that fires
// on the first render. Capped so a failing load cannot grow it.
const MAX_QUEUED = 50;

type Delivery = (posthog: PostHog) => void;

let posthog: PostHog | null = null;
let queue: Delivery[] | null = null;

const deliver = (client: PostHog, delivery: Delivery): void => {
  try {
    delivery(client);
  } catch {
  }
};

const initPostHog = (client: PostHog, key: string): void => {
  client.init(key, {
    api_host: posthogHost,
    capture_pageview: false,
    capture_pageleave: false,
    autocapture: false,
    disable_session_recording: true,
    disable_surveys: true,
    advanced_disable_flags: true,
    disable_external_dependency_loading: true,
    save_campaign_params: false,
    person_profiles: "identified_only",
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    before_send: scrubTelemetryEvent,
  });
  client.register({
    client_version: process.env.NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION,
  });
  installCallErrorCapture((error, props) => {
    client.captureException(error, props);
  });
};

/**
 * Loads PostHog once for the page's lifetime. Every report starts it too, so
 * an error boundary that replaced the root layout can still send.
 */
export function startTelemetry(): void {
  if (posthog || queue || !posthogKey || !telemetryEnabled) return;
  if (typeof window === "undefined") return;
  const pending: Delivery[] = [];
  queue = pending;
  void Promise.all([
    import("posthog-js"),
    import("posthog-js/dist/exception-autocapture"),
  ])
    .then(([{ default: client }]) => {
      initPostHog(client, posthogKey);
      posthog = client;
      pending.forEach((delivery) => deliver(client, delivery));
    })
    .catch(() => {})
    .finally(() => {
      queue = null;
    });
}

const send = (delivery: Delivery): void => {
  if (posthog) {
    deliver(posthog, delivery);
    return;
  }
  startTelemetry();
  if (queue && queue.length < MAX_QUEUED) queue.push(delivery);
};

export const telemetry = {
  capture(
    event: string,
    props?: TelemetryProps,
    options?: TelemetryCaptureOptions,
  ): void {
    send((client) => {
      client.capture(
        event,
        props,
        options?.immediate
          ? { transport: "sendBeacon", send_instantly: true }
          : undefined,
      );
    });
  },
  captureException(error: unknown, props?: TelemetryProps): void {
    send((client) => {
      client.captureException(error, props);
    });
  },
};
