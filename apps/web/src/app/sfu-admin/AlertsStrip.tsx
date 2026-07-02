"use client";

import { color } from "@conclave/ui-tokens";
import type { RoomSelection } from "./types";

export type OperatorAlert = {
  key: string;
  message: string;
  /** When set, clicking the alert jumps to this room. */
  selection?: RoomSelection;
};

/** Amber condition chips under the header: workers down, draining left on,
 * waiting rooms with no host. Dismissals are per session. */
export function AlertsStrip({
  alerts,
  onJump,
  onDismiss,
}: {
  alerts: OperatorAlert[];
  onJump: (selection: RoomSelection) => void;
  onDismiss: (key: string) => void;
}) {
  if (alerts.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-t px-4 py-1.5"
      style={{ borderColor: color.border }}
    >
      {alerts.map((alert) => (
        <span
          key={alert.key}
          className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] font-medium"
          style={{ borderColor: "rgba(251,191,36,0.35)", color: color.warning }}
        >
          {alert.selection ? (
            <button
              type="button"
              className="transition-opacity hover:opacity-80"
              onClick={() => onJump(alert.selection!)}
              title="Jump to this room"
            >
              {alert.message}
            </button>
          ) : (
            alert.message
          )}
          <button
            type="button"
            aria-label="Dismiss alert"
            className="opacity-60 transition-opacity hover:opacity-100"
            onClick={() => onDismiss(alert.key)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
