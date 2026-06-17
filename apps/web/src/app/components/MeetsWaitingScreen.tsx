"use client";

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
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0b] px-4 py-10 text-[#fafafa]">
      <section className="animate-fade-in w-full max-w-[420px] rounded-2xl border border-white/10 bg-[#0e0e10] p-6 sm:p-8 text-center">
        <div className="mx-auto mb-4 flex items-center justify-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[#F95F4A] animate-pulse" />
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-[#fafafa]/40">
            {waitingTitle}
          </span>
        </div>
        <h1
          className="text-[22px] leading-tight text-[#fafafa]"
          style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
        >
          Waiting to join
        </h1>
        <p className="mt-2 text-[13.5px] leading-snug text-[#fafafa]/55">
          {waitingIntro}
        </p>
        {isAdmin && roomId ? (
          <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <p className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-[#fafafa]/40">
              Room code
            </p>
            <p className="mt-1 text-[15px] font-medium text-[#F95F4A]">{roomId}</p>
          </div>
        ) : null}
      </section>
    </main>
  );
}
