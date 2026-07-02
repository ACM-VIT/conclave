"use client";

import { color } from "@conclave/ui-tokens";
import type { AdminActionInput, PendingUserSnapshot } from "./types";
import { Section, btnTiny, btnTinyDanger } from "./ui";

/** Waiting room list with per-person and bulk admit/reject. Only rendered
 * when someone is actually waiting. */
export function WaitingSection({
  pendingUsers,
  roomPath,
  act,
}: {
  pendingUsers: PendingUserSnapshot[];
  roomPath: string;
  act: (input: AdminActionInput) => void;
}) {
  if (pendingUsers.length === 0) return null;

  return (
    <Section
      title={`Waiting room · ${pendingUsers.length}`}
      action={
        <div className="flex gap-1.5">
          <button
            type="button"
            className={btnTiny}
            onClick={() =>
              act({ label: "Admitted everyone", path: `${roomPath}/pending/admit-all` })
            }
          >
            Admit all
          </button>
          <button
            type="button"
            className={btnTinyDanger}
            onClick={() =>
              act({ label: "Rejected everyone", path: `${roomPath}/pending/reject-all` })
            }
          >
            Reject all
          </button>
        </div>
      }
    >
      <div className="space-y-1.5">
        {pendingUsers.map((pending) => (
          <div
            key={`${pending.userKey}-${pending.participantUserId}`}
            className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
            style={{ borderColor: color.border, backgroundColor: color.surface }}
          >
            <div className="min-w-0">
              <p className="truncate text-[13px]" style={{ color: color.text }}>
                {pending.displayName}
              </p>
              <p className="truncate text-[11px]" style={{ color: color.textFaint }}>
                {pending.userKey}
              </p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <button
                type="button"
                className={btnTiny}
                onClick={() =>
                  act({
                    label: `Admitted ${pending.displayName}`,
                    path: `${roomPath}/pending/${encodeURIComponent(pending.userKey)}/admit`,
                  })
                }
              >
                Admit
              </button>
              <button
                type="button"
                className={btnTinyDanger}
                onClick={() =>
                  act({
                    label: `Rejected ${pending.displayName}`,
                    path: `${roomPath}/pending/${encodeURIComponent(pending.userKey)}/reject`,
                  })
                }
              >
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
