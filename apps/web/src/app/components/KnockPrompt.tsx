"use client";

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { color } from "@conclave/ui-tokens";
import { Avatar } from "@conclave/ui-tokens/web";
import {
  admitAllPendingUsers,
  admitPendingUser,
  denyPendingUser,
} from "../lib/admissions";
import { formatDisplayName } from "../lib/utils";

interface KnockPromptProps {
  socket: Socket | null;
  pendingUsers: Map<string, string>;
  onViewAll: () => void;
  onPendingUserStale?: (userId: string) => void;
}

const ACTION_SETTLE_FALLBACK_MS = 10000;

const BUTTON_BASE =
  "inline-flex h-9 items-center justify-center rounded-lg px-3.5 text-[13px] font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F95F4A] disabled:cursor-wait disabled:opacity-60";
const BUTTON_PRIMARY = `${BUTTON_BASE} bg-[#F95F4A] text-white hover:brightness-[1.05]`;
const BUTTON_GHOST = `${BUTTON_BASE} border border-white/10 bg-white/[0.04] text-[#fafafa] hover:bg-white/[0.08]`;

// Shown to hosts while anyone is waiting to be let in, like native's
// "wants to join" banner: one person gets Deny and Admit, several get
// View all and Admit all.
export default function KnockPrompt({
  socket,
  pendingUsers,
  onViewAll,
  onPendingUserStale,
}: KnockPromptProps) {
  // The people an action in flight is for. It settles once they have all
  // left the waiting list (or on a failed admit-all ack, or a timeout), not
  // when someone else knocks meanwhile.
  const [actionTargets, setActionTargets] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const isBusy = actionTargets !== null;

  const settleAction = () => {
    setActionTargets(null);
    if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
  };

  useEffect(() => {
    if (actionTargets?.every((userId) => !pendingUsers.has(userId))) {
      settleAction();
    }
  }, [actionTargets, pendingUsers]);

  useEffect(
    () => () => {
      if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
    },
    [],
  );

  const entries = Array.from(pendingUsers.entries());
  if (entries.length === 0) return null;

  const people = entries.map(([userId, displayName]) => ({
    userId,
    name: formatDisplayName(displayName || userId),
  }));
  const single = people.length === 1 ? people[0] : null;
  const title = single
    ? `${single.name} wants to join`
    : `${people.length} people want to join`;
  const othersPreview =
    people.length > 2
      ? `${people[0].name}, ${people[1].name} and ${people.length - 2} more`
      : people.map((person) => person.name).join(" and ");

  const startAction = (
    targets: string[],
    action: (activeSocket: Socket) => void,
  ) => {
    if (!socket || isBusy) return;
    setError(null);
    setActionTargets(targets);
    settleTimerRef.current = window.setTimeout(
      () => setActionTargets(null),
      ACTION_SETTLE_FALLBACK_MS,
    );
    action(socket);
  };

  return (
    <section
      aria-label="Join requests"
      className="pointer-events-auto fixed bottom-24 left-4 right-4 z-40 rounded-2xl border p-3.5 shadow-[0_12px_36px_rgba(0,0,0,0.34)] sm:right-auto sm:w-[340px]"
      style={{ backgroundColor: color.surfaceRaised, borderColor: color.border }}
    >
      <div className="flex items-center gap-3">
        {single ? (
          <Avatar id={single.userId} name={single.name} size={36} />
        ) : (
          <div className="flex shrink-0 -space-x-2.5">
            {people.slice(0, 3).map((person) => (
              <span
                key={person.userId}
                className="rounded-full"
                style={{ boxShadow: `0 0 0 2px ${color.surfaceRaised}` }}
              >
                <Avatar id={person.userId} name={person.name} size={30} />
              </span>
            ))}
          </div>
        )}
        <div className="min-w-0 flex-1" role="status" aria-live="assertive">
          <p className="truncate text-[14px] font-medium text-[#fafafa]">
            {title}
          </p>
          {single ? null : (
            <p className="truncate text-[12.5px] text-[#fafafa]/55">
              {othersPreview}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        {single ? (
          <>
            <button
              type="button"
              disabled={isBusy}
              onClick={() =>
                startAction([single.userId], (activeSocket) =>
                  denyPendingUser(activeSocket, single.userId, onPendingUserStale),
                )
              }
              aria-label={`Deny ${single.name}`}
              className={BUTTON_GHOST}
            >
              Deny
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() =>
                startAction([single.userId], (activeSocket) =>
                  admitPendingUser(activeSocket, single.userId, onPendingUserStale),
                )
              }
              aria-label={`Admit ${single.name}`}
              className={BUTTON_PRIMARY}
            >
              Admit
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={onViewAll} className={BUTTON_GHOST}>
              View all
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() =>
                startAction(
                  people.map((person) => person.userId),
                  (activeSocket) =>
                    admitAllPendingUsers(activeSocket, (failure) => {
                      if (!failure) return;
                      settleAction();
                      setError(failure);
                    }),
                )
              }
              className={BUTTON_PRIMARY}
            >
              Admit all
            </button>
          </>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-[12px] text-[#F95F4A]">
          {error}
        </p>
      ) : null}
    </section>
  );
}
