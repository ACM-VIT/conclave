"use client";

import { AlertTriangle, Home, RotateCw } from "lucide-react";

type ErrorStateViewProps = {
  eyebrow?: string;
  title?: string;
  message?: string;
  retryLabel?: string;
  homeLabel?: string;
  onRetry?: () => void;
};

export default function ErrorStateView({
  eyebrow = "Something went wrong",
  title = "We couldn't load this screen",
  message = "Try again. If the issue continues, return to the lobby and rejoin.",
  retryLabel = "Try again",
  homeLabel = "Go home",
  onRetry,
}: ErrorStateViewProps) {
  return (
    <main className="min-h-dvh bg-[#080809] px-5 py-6 text-[#fafafa] sm:px-8">
      <div className="mx-auto flex min-h-[calc(100dvh-48px)] w-full max-w-2xl flex-col">
        <header className="flex items-center justify-between">
          <a
            href="/"
            className="text-[13px] font-semibold text-[#fafafa]/70 transition-colors hover:text-[#fafafa]"
            aria-label="Conclave lobby"
          >
            Conclave
          </a>
        </header>

        <section className="flex flex-1 items-center py-10">
          <div className="w-full rounded-xl border border-white/10 bg-[#111113] p-6 shadow-[0_18px_50px_rgba(0,0,0,0.28)] sm:p-8">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#F95F4A]/25 bg-[#F95F4A]/10 text-[#F95F4A]">
              <AlertTriangle size={20} strokeWidth={1.9} />
            </div>

            <p className="mt-6 text-[12px] font-semibold uppercase text-[#fafafa]/40">
              {eyebrow}
            </p>
            <h1
              className="mt-3 max-w-[520px] text-[28px] leading-[1.08] text-[#fafafa] sm:text-[36px]"
              style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
            >
              {title}
            </h1>
            <p className="mt-4 max-w-[520px] text-[15px] leading-6 text-[#fafafa]/58">
              {message}
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              {onRetry ? (
                <button
                  type="button"
                  onClick={onRetry}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-[#F95F4A] px-5 text-[14px] font-semibold text-white transition-colors hover:bg-[#ff705d] focus:outline-none focus:ring-2 focus:ring-[#F95F4A]/45 focus:ring-offset-2 focus:ring-offset-[#111113]"
                >
                  <RotateCw size={17} strokeWidth={2.2} />
                  {retryLabel}
                </button>
              ) : null}
              <a
                href="/"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-5 text-[14px] font-semibold text-[#fafafa] transition-colors hover:bg-white/[0.07] focus:outline-none focus:ring-2 focus:ring-white/20 focus:ring-offset-2 focus:ring-offset-[#111113]"
              >
                <Home size={17} strokeWidth={2.1} />
                {homeLabel}
              </a>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
