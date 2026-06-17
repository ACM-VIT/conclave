"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[Error]", error);
  }, [error]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0b] px-4 py-10 text-[#fafafa]">
      <section className="animate-fade-in w-full max-w-[420px] rounded-2xl border border-white/10 bg-[#0e0e10] p-6 sm:p-8 text-center">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-[#fafafa]/40">
          Something went wrong
        </p>
        <h1
          className="mt-3 text-[22px] leading-tight text-[#fafafa]"
          style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
        >
          We hit a snag
        </h1>
        <p className="mt-2 text-[13.5px] leading-snug text-[#fafafa]/55">
          Please try again. If this keeps happening, refresh the page or rejoin
          the room.
        </p>
        <div className="mt-6 flex flex-col gap-2.5 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-12 flex-1 items-center justify-center rounded-xl bg-[#F95F4A] px-5 text-[15px] font-medium text-white transition-[filter] duration-150 hover:brightness-[1.05] sm:flex-none sm:min-w-[120px]"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex h-12 flex-1 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] px-5 text-[15px] font-medium text-[#fafafa] transition-colors duration-150 hover:bg-white/[0.08] sm:flex-none sm:min-w-[120px]"
          >
            Go home
          </a>
        </div>
      </section>
    </main>
  );
}
