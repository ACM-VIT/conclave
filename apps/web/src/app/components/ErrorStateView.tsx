"use client";

import Image from "next/image";

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
    <main className="flex min-h-dvh flex-col bg-[#0a0a0b] text-[#fafafa]">
      <header className="px-5 py-4">
        <a href="/" className="flex items-center" aria-label="Conclave home">
          <Image
            src="/assets/acm_topleft.svg"
            alt="ACM-VIT"
            width={128}
            height={128}
            className="h-auto w-[104px]"
            priority
          />
        </a>
      </header>

      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <section className="animate-fade-in w-full max-w-[420px] rounded-2xl border border-white/10 bg-[#0e0e10] p-6 text-center sm:max-w-[480px] sm:p-8">
          <p className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-[#fafafa]/40">
            {eyebrow}
          </p>
          <h1
            className="mt-3 text-[22px] leading-tight text-[#fafafa]"
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            {title}
          </h1>
          <p className="mt-2 text-[13.5px] leading-snug text-[#fafafa]/55">
            {message}
          </p>

          <div className="mt-6 flex flex-col gap-2.5">
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-[#F95F4A] text-[15px] font-medium text-white transition-[filter] duration-150 hover:brightness-[1.05]"
              >
                {retryLabel}
              </button>
            ) : null}
            <a
              href="/"
              className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-[15px] font-medium text-[#fafafa] transition-colors hover:bg-white/[0.06]"
            >
              {homeLabel}
            </a>
          </div>
        </section>
      </div>
    </main>
  );
}
