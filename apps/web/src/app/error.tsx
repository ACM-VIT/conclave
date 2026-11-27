"use client";

import { useEffect } from "react";
import ErrorStateView from "./components/ErrorStateView";
import { telemetry } from "./lib/telemetry";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[Error]", error);
    telemetry.captureException(error, {
      source: "react_error_boundary",
      boundary: "route",
      digest: error.digest,
    });
  }, [error]);

  return <ErrorStateView onRetry={reset} />;
}
