"use client";

import { useEffect } from "react";
import ErrorStateView from "./components/ErrorStateView";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[Error]", error);
  }, [error]);

  return <ErrorStateView onRetry={reset} />;
}
