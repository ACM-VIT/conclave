"use client";

import { CheckCircle2, Loader2 } from "lucide-react";
import type { ParticipantConnectionStatus } from "../lib/types";

interface ParticipantConnectionOverlayProps {
  status?: ParticipantConnectionStatus;
  compact?: boolean;
}

const getReasonLabel = (reason?: string) => {
  if (reason === "ping timeout") return "Connection timed out";
  if (reason === "transport close" || reason === "transport error") {
    return "Network interrupted";
  }
  return "Connection interrupted";
};

export default function ParticipantConnectionOverlay({
  status,
  compact = false,
}: ParticipantConnectionOverlayProps) {
  if (!status) return null;

  const isReconnecting = status.state === "reconnecting";
  const label = isReconnecting ? "Reconnecting" : "Back online";
  const detail = isReconnecting ? getReasonLabel(status.reason) : null;
  const Icon = isReconnecting ? Loader2 : CheckCircle2;

  return (
    <div
      className={`pointer-events-none absolute left-1/2 z-20 -translate-x-1/2 ${
        compact ? "top-2" : "top-3"
      }`}
      aria-live="polite"
      aria-label={detail ? `${label}. ${detail}` : label}
      title={detail ?? label}
    >
      <div
        className={`flex items-center gap-1.5 rounded-full border border-[#fafafa]/10 bg-[#0a0a0b]/72 text-[#fafafa] backdrop-blur-md ${
          compact ? "px-2 py-1" : "px-2.5 py-1.5"
        }`}
        style={{ fontFamily: "'PolySans Trial', sans-serif" }}
      >
        {isReconnecting ? (
          <Icon
            size={compact ? 14 : 16}
            strokeWidth={1.75}
            className="shrink-0 animate-spin text-[#F95F4A]"
          />
        ) : (
          <Icon
            size={compact ? 14 : 16}
            strokeWidth={1.75}
            className="shrink-0 text-emerald-300"
          />
        )}
        <span
          className={`font-medium leading-none ${
            compact ? "text-[11px]" : "text-[12px]"
          }`}
        >
          {label}
        </span>
      </div>
    </div>
  );
}
