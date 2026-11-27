"use client";

import { useEffect, type ReactNode } from "react";
import { startTelemetry } from "../lib/telemetry";

/** Loads PostHog on every page so unhandled errors are captured. */
function TelemetryProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    startTelemetry();
  }, []);

  return <>{children}</>;
}

export default TelemetryProvider;
