"use client";

import { useEffect } from "react";
import ErrorStateView from "./components/ErrorStateView";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GlobalError]", error);
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-[#0a0a0b] text-[#fafafa]">
        <ErrorStateView onRetry={reset} />
      </body>
    </html>
  );
}
