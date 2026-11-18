"use client";

type TelemetryProps = Record<string, unknown>;

type TelemetrySink = (
  event: string,
  props?: TelemetryProps,
) => void;

let sink: TelemetrySink | null = null;

export function setTelemetrySink(next: TelemetrySink | null): void {
  sink = next;
}

function capture(event: string, props?: TelemetryProps): void {
  if (!sink) return;
  try {
    sink(event, props);
  } catch {
  }
}

export const telemetry = {
  capture,
};
