"use client";

import type { ConnectionState } from "../lib/types";
import type { ConnectionQuality } from "../hooks/useConnectionQuality";

function ConnectionIndicator({ state }: { state: ConnectionState }) {
  const colors: Record<ConnectionState, string> = {
    disconnected: "bg-neutral-600",
    connecting: "bg-yellow-500 animate-pulse",
    connected: "bg-green-500",
    joining: "bg-yellow-500 animate-pulse",
    joined: "bg-green-500",
    reconnecting: "bg-yellow-500 animate-pulse",
    waiting: "bg-blue-500 animate-pulse",
    error: "bg-red-500",
  };

  const labels: Record<ConnectionState, string> = {
    disconnected: "Disconnected",
    connecting: "Connecting...",
    connected: "Connected",
    joining: "Joining...",
    joined: "In Meeting",
    reconnecting: "Reconnecting...",
    waiting: "Waiting...",
    error: "Error",
  };

  return (
    <div className="flex items-center gap-2">
      <span className={`w-1.5 h-1.5 rounded-full ${colors[state]}`} />
      <span className="text-xs text-neutral-500 tracking-wider">
        {labels[state]}
      </span>
    </div>
  );
}

const QUALITY_DOT: Record<ConnectionQuality, string> = {
  // Flat Carbon dots — solid fill, NO glow, NO pulse.
  good: "bg-green-500",
  fair: "bg-amber-500",
  poor: "bg-red-500",
  unknown: "bg-neutral-600",
};

const QUALITY_LABEL: Record<ConnectionQuality, string> = {
  good: "Good connection",
  fair: "Fair connection",
  poor: "Poor connection",
  unknown: "Measuring connection",
};

interface ConnectionQualityIndicatorProps {
  quality: ConnectionQuality;
  /** Show the text label next to the dot. Defaults to false (dot only). */
  showLabel?: boolean;
  /** Optional title/tooltip override (e.g. "RTT 120ms · loss 1%"). */
  title?: string;
  className?: string;
}

/**
 * Flat 3-tier network-quality badge (green/amber/red dot — Carbon flat, no glow).
 * Hidden entirely when quality is `unknown` and no label is requested, so it
 * never renders a meaningless grey dot on a healthy tile.
 */
export function ConnectionQualityIndicator({
  quality,
  showLabel = false,
  title,
  className,
}: ConnectionQualityIndicatorProps) {
  if (quality === "unknown" && !showLabel) return null;

  return (
    <div
      className={`flex items-center gap-1.5${className ? ` ${className}` : ""}`}
      title={title ?? QUALITY_LABEL[quality]}
      aria-label={QUALITY_LABEL[quality]}
      role="img"
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${QUALITY_DOT[quality]}`}
      />
      {showLabel && (
        <span className="text-xs text-neutral-500 tracking-wider">
          {QUALITY_LABEL[quality]}
        </span>
      )}
    </div>
  );
}

export default ConnectionIndicator;
