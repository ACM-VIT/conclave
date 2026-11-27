"use client";

import { useEffect } from "react";
import ErrorStateView from "./components/ErrorStateView";
import { telemetry } from "./lib/telemetry";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GlobalError]", error);
    telemetry.captureException(error, {
      source: "react_error_boundary",
      boundary: "root",
      digest: error.digest,
    });
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-[#0a0a0b] text-[#fafafa]">
        <ErrorStateView onRetry={reset} />
      </body>
    </html>
  );
}
