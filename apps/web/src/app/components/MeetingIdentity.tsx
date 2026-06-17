"use client";

import { Monitor, RefreshCw, VenetianMask } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { color } from "@conclave/ui-tokens";
import type { ConnectionQuality } from "../hooks/useConnectionQuality";
import { ConnectionQualityIndicator } from "./ConnectionIndicator";

interface MeetingIdentityProps {
  connectionState: string;
  serverRestartNotice?: string | null;
  isScreenSharing?: boolean;
  isGhost?: boolean;
  connectionQuality?: ConnectionQuality;
}

/**
 * Meet-style status indicator (top-left). Renders NOTHING over the video unless
 * there is a live status — reconnecting / sharing / ghost — shown as one small
 * chip (never stacked). Room + time live in the control bar.
 */
export default function MeetingIdentity({
  connectionState,
  serverRestartNotice,
  isScreenSharing,
  isGhost,
  connectionQuality = "unknown",
}: MeetingIdentityProps) {
  const chip = useMemo<{ icon: ReactNode; label: string; tone: string } | null>(() => {
    const connecting =
      connectionState === "reconnecting" ||
      (serverRestartNotice && !["error", "disconnected"].includes(connectionState));
    if (connecting) {
      return {
        icon: <RefreshCw className="h-3 w-3 animate-spin" />,
        label:
          serverRestartNotice && !["error", "disconnected"].includes(connectionState)
            ? "Restarting"
            : "Reconnecting",
        tone: color.warning,
      };
    }
    if (isScreenSharing) {
      return { icon: <Monitor className="h-3 w-3" />, label: "Sharing", tone: color.accent };
    }
    if (isGhost) {
      return { icon: <VenetianMask className="h-3 w-3" />, label: "Ghost", tone: color.accentSecondary };
    }
    return null;
  }, [connectionState, serverRestartNotice, isScreenSharing, isGhost]);

  const showQuality = connectionQuality !== "unknown";
  if (!chip && !showQuality) return null;

  const qualityLabel =
    connectionQuality === "good"
      ? "Good connection"
      : connectionQuality === "fair"
        ? "Fair connection"
        : "Poor connection";

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-40 flex items-center gap-1.5">
      {chip && (
        <div
          className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]"
          style={{ backgroundColor: color.scrim, borderColor: color.border, color: chip.tone }}
        >
          {chip.icon}
          {chip.label}
        </div>
      )}
      {showQuality && (
        <div
          className="pointer-events-auto inline-flex items-center rounded-full border px-2 py-1"
          style={{ backgroundColor: color.scrim, borderColor: color.border }}
          title={qualityLabel}
        >
          <ConnectionQualityIndicator quality={connectionQuality} />
        </div>
      )}
    </div>
  );
}
