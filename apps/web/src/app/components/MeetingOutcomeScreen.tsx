"use client";

import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { font } from "@conclave/ui-tokens";
import { BRAND_BTN_GHOST, BRAND_BTN_PRIMARY } from "./brandScreenStyles";
import {
  CALL_OUTCOME_POLICY,
  CALL_RATING_LABELS,
  type CallOutcome,
} from "../lib/call-outcome";

interface MeetingOutcomeScreenProps {
  outcome: CallOutcome;
  onRejoin?: () => void;
  onReturnHome: () => void;
  onRate: (rating: number) => void;
}

export default function MeetingOutcomeScreen({
  outcome,
  onRejoin,
  onReturnHome,
  onRate,
}: MeetingOutcomeScreenProps) {
  const policy = CALL_OUTCOME_POLICY[outcome.kind];
  const actions = onRejoin ? policy.actions : policy.actions.filter((action) => action !== "rejoin");
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const shownRating = rating ?? preview ?? 0;
  const detail = outcome.detail ?? policy.body;

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const rate = (value: number) => {
    if (rating !== null) return;
    setRating(value);
    onRate(value);
  };

  return (
    <main className="flex min-h-dvh w-full items-center justify-center bg-[#0a0a0b] px-4 py-10 text-[#fafafa]">
      <div className="flex w-full max-w-[420px] flex-col items-center text-center">
        <h1
          ref={titleRef}
          tabIndex={-1}
          className="text-balance text-[26px] leading-tight outline-none"
          style={{ fontFamily: font.display }}
        >
          {policy.title}
        </h1>
        {detail ? (
          <p className="mt-2.5 text-pretty text-[14px] leading-snug text-[#fafafa]/70">
            {detail}
          </p>
        ) : null}
        <div className="mt-7 flex w-full flex-col gap-2.5 sm:flex-row">
          {actions.map((action, index) => (
            <button
              key={action}
              type="button"
              onClick={action === "rejoin" ? onRejoin : onReturnHome}
              className={index === 0 ? BRAND_BTN_PRIMARY : BRAND_BTN_GHOST}
            >
              {action === "rejoin" ? "Rejoin" : "Return to home screen"}
            </button>
          ))}
        </div>
        {policy.asksForRating ? (
          <section
            aria-labelledby="call-rating-title"
            className="mt-8 w-full rounded-2xl border border-white/10 bg-[#18181b] px-5 pb-3 pt-4"
          >
            <h2 id="call-rating-title" className="text-[14px] font-medium">
              How was the audio and video?
            </h2>
            <div
              role="group"
              aria-labelledby="call-rating-title"
              className="mt-2 flex justify-center gap-1"
              onMouseLeave={() => setPreview(null)}
            >
              {CALL_RATING_LABELS.map((label, index) => {
                const value = index + 1;
                return (
                  <button
                    key={label}
                    type="button"
                    aria-label={`${value} of 5, ${label}`}
                    aria-pressed={rating === value}
                    title={label}
                    onClick={() => rate(value)}
                    onMouseEnter={() => setPreview(value)}
                    onFocus={() => setPreview(value)}
                    onBlur={() => setPreview(null)}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-xl transition-colors duration-100 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F95F4A]/50"
                  >
                    <Star
                      size={26}
                      strokeWidth={1.6}
                      aria-hidden
                      className={
                        value <= shownRating
                          ? "fill-[#F95F4A] text-[#F95F4A]"
                          : "text-[#fafafa]/45"
                      }
                    />
                  </button>
                );
              })}
            </div>
            <div className="mt-1 min-h-5 text-[12.5px] text-[#fafafa]/70">
              <p role="status">
                {rating !== null ? "Thanks for the feedback." : ""}
              </p>
              {rating === null && shownRating > 0 ? (
                <p aria-hidden>{CALL_RATING_LABELS[shownRating - 1]}</p>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
