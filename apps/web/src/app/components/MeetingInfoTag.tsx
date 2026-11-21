"use client";

import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { color } from "@conclave/ui-tokens";
import { useOneTimeHint } from "../hooks/useOneTimeHint";
import { copyText, meetingLinkFor } from "../lib/meeting-link";

function useClock() {
  const [time, setTime] = useState("");
  useEffect(() => {
    const fmt = () =>
      new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    setTime(fmt());
    const id = window.setInterval(() => setTime(fmt()), 15000);
    return () => window.clearInterval(id);
  }, []);
  return time;
}

export default function MeetingInfoTag({
  roomId,
  clientId,
}: {
  roomId?: string;
  clientId?: string;
}) {
  const time = useClock();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const hint = useOneTimeHint("copy-room-code", {
    enabled: Boolean(roomId),
    delay: 1800,
  });

  useEffect(
    () => () => {
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!hint.visible) return;
    const t = window.setTimeout(() => hint.dismiss(), 5000);
    return () => window.clearTimeout(t);
  }, [hint.visible, hint.dismiss]);

  const canHover =
    typeof window !== "undefined" &&
    window.matchMedia?.("(hover: hover)").matches === true;

  const handleCopy = useCallback(() => {
    if (!roomId) return;
    void copyText(meetingLinkFor(roomId, clientId)).then((ok) => {
      if (!ok) return;
      hint.dismiss();
      setCopied(true);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }, [roomId, clientId, hint]);

  const content = (
    <div className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium leading-none">
      <span className="tabular-nums" style={{ color: color.text }}>
        {time}
      </span>
      {roomId ? (
        <>
          <span
            aria-hidden
            className="inline-block h-[3px] w-[3px] shrink-0 rounded-full"
            style={{ backgroundColor: color.textFaint }}
          />
          {copied ? (
            <span
              className="inline-flex items-center gap-1"
              style={{ color: color.success }}
            >
              <Check size={12} strokeWidth={2} />
              Copied
            </span>
          ) : (
            <span
              className="inline-flex min-w-0 items-center gap-1"
              style={{ color: color.textMuted }}
            >
              <span className="truncate">{roomId}</span>
              <Copy
                size={11}
                strokeWidth={1.75}
                className="shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-60"
              />
            </span>
          )}
        </>
      ) : null}
    </div>
  );

  return (
    <div className="relative inline-flex min-w-0">
      {roomId ? (
        <button
          type="button"
          onClick={handleCopy}
          aria-label={
            copied ? "Meeting link copied" : `Copy meeting link for ${roomId}`
          }
          title="Copy meeting link"
          className="group -mx-1.5 -my-1 min-w-0 rounded-md px-1.5 py-1 transition-colors duration-150 hover:bg-white/[0.06]"
        >
          {content}
        </button>
      ) : (
        content
      )}
      {hint.visible && !copied ? (
        <span
          className="pointer-events-none absolute bottom-full left-0 mb-2 inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-medium animate-[meet-popover-in_150ms_cubic-bezier(0.22,1,0.36,1)]"
          style={{ color: color.textFaint }}
        >
          <Copy size={11} strokeWidth={1.75} />
          {canHover ? "Click" : "Tap"} to copy link
        </span>
      ) : null}
    </div>
  );
}
