"use client";

import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import { color } from "@conclave/ui-tokens";

interface MeetsWaitingScreenProps {
  waitingTitle: string;
  waitingIntro: string;
  roomId: string;
  isAdmin: boolean;
}

export default function MeetsWaitingScreen({
  waitingTitle,
  waitingIntro,
  roomId,
  isAdmin,
}: MeetsWaitingScreenProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!roomId) return;
    void navigator.clipboard
      ?.writeText(roomId)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  }, [roomId]);

  return (
    <main
      className="flex min-h-dvh items-center justify-center px-4 py-10"
      style={{ backgroundColor: color.bg, color: color.text }}
    >
      <section
        className="animate-fade-in w-full max-w-[400px] rounded-2xl border p-8 text-center"
        style={{ backgroundColor: color.surface, borderColor: color.border }}
      >
        <div className="flex items-center justify-center gap-1.5" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 animate-pulse rounded-full"
              style={{
                backgroundColor: color.accent,
                animationDelay: `${i * 220}ms`,
                animationDuration: "1200ms",
              }}
            />
          ))}
        </div>

        <h1
          className="mt-5 text-[20px] font-semibold leading-snug tracking-tight"
          style={{ color: color.text }}
        >
          {waitingTitle}
        </h1>
        <p className="mt-2 text-[13.5px] leading-relaxed" style={{ color: color.textMuted }}>
          {waitingIntro}
        </p>

        {isAdmin && roomId ? (
          <div className="mt-7 border-t pt-5" style={{ borderColor: color.border }}>
            <p
              className="text-[11px] font-medium tracking-wide"
              style={{ color: color.textFaint }}
            >
              Room code
            </p>
            <button
              type="button"
              onClick={handleCopy}
              className="mt-2 inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 transition-[background-color] duration-[120ms] hover:bg-white/[0.04]"
              style={{ borderColor: color.border }}
            >
              <span className="text-[15px] font-medium" style={{ color: color.accent }}>
                {roomId}
              </span>
              {copied ? (
                <Check size={15} strokeWidth={2} style={{ color: color.success }} />
              ) : (
                <Copy size={15} strokeWidth={1.75} style={{ color: color.textMuted }} />
              )}
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
