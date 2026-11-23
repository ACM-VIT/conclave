"use client";

import type { ComponentType } from "react";
import { LoaderCircle, RotateCw } from "lucide-react";
import type { AppSyncStatus } from "@conclave/apps-sdk";

interface PresentedAppProps {
  app: ComponentType;
  appName: string;
  appKey: string;
  syncStatus: AppSyncStatus;
  onRetrySync: () => void;
}

export default function PresentedApp({
  app: App,
  appName,
  appKey,
  syncStatus,
  onRetrySync,
}: PresentedAppProps) {
  if (syncStatus === "synced") return <App key={appKey} />;
  if (syncStatus === "failed") {
    return (
      <div
        role="status"
        className="flex h-full min-h-0 w-full items-center justify-center gap-3"
      >
        <span className="text-[12.5px] text-[#fafafa]/80">
          {"Couldn't load this app"}
        </span>
        <button
          type="button"
          onClick={onRetrySync}
          className="inline-flex h-7 items-center gap-1.5 rounded-full border border-white/10 px-3 text-[12px] font-medium text-[#fafafa]/85 transition-colors hover:border-white/25 hover:bg-white/[0.06] hover:text-[#fafafa] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
        >
          <RotateCw size={13} strokeWidth={1.75} aria-hidden="true" />
          Retry
        </button>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="flex h-full min-h-0 w-full items-center justify-center gap-2 text-[13px] text-[#a1a1aa]"
    >
      <LoaderCircle size={15} strokeWidth={2} className="animate-spin" aria-hidden="true" />
      Loading {appName}
    </div>
  );
}
