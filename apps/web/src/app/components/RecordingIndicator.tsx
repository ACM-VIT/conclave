"use client";

import { useEffect, useState } from "react";

type Props = {
  active: boolean;
  paused?: boolean;
  startedAt?: number | null;
};

const pad = (n: number): string => String(n).padStart(2, "0");

const formatElapsed = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
};

export default function RecordingIndicator({
  active,
  paused = false,
  startedAt,
}: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active || paused) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, paused]);

  if (!active) return null;

  const elapsed = startedAt ? Math.max(0, now - startedAt) : 0;

  return (
    <div
      className={`pointer-events-none fixed top-3 left-3 z-[110] flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] backdrop-blur-md ${
        paused
          ? "bg-amber-300/15 text-amber-200 border border-amber-300/30"
          : "bg-[#F95F4A]/15 text-[#F95F4A] border border-[#F95F4A]/35"
      }`}
      style={{ fontFamily: "'PolySans Mono', monospace" }}
      aria-live="polite"
    >
      <span
        className={`block h-2 w-2 rounded-full ${
          paused ? "bg-amber-300" : "bg-[#F95F4A]"
        }`}
      />
      <span>{paused ? "Paused" : "Rec"}</span>
      {startedAt ? (
        <span className="font-mono text-[#FEFCD9]/55">
          {formatElapsed(elapsed)}
        </span>
      ) : null}
    </div>
  );
}
