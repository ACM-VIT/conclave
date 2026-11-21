"use client";

export type TelemetryProps = Record<string, unknown>;

export type TelemetryCaptureOptions = {
  /** Send now with sendBeacon; for events captured while the page unloads. */
  immediate?: boolean;
};

export type TelemetryClient = {
  capture(
    event: string,
    props?: TelemetryProps,
    options?: TelemetryCaptureOptions,
  ): void;
  captureException(error: unknown, props?: TelemetryProps): void;
};

let client: TelemetryClient | null = null;

export function setTelemetryClient(next: TelemetryClient | null): void {
  client = next;
}

function capture(
  event: string,
  props?: TelemetryProps,
  options?: TelemetryCaptureOptions,
): void {
  if (!client) return;
  try {
    client.capture(event, props, options);
  } catch {
  }
}

function captureException(error: unknown, props?: TelemetryProps): void {
  if (!client) return;
  try {
    client.captureException(error, props);
  } catch {
  }
}

export const telemetry = {
  capture,
  captureException,
};
