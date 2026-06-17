import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0b] px-4 py-10 text-[#fafafa]">
      <section className="animate-fade-in w-full max-w-[420px] rounded-2xl border border-white/10 bg-[#0e0e10] p-6 sm:p-8 text-center">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-[#fafafa]/40">
          404 · Not found
        </p>
        <h1
          className="mt-3 text-[22px] leading-tight text-[#fafafa]"
          style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
        >
          Page not found
        </h1>
        <p className="mt-2 text-[13.5px] leading-snug text-[#fafafa]/55">
          The room or page you&apos;re looking for doesn&apos;t exist. Head back
          to the lobby and start fresh.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex h-12 w-full items-center justify-center rounded-xl bg-[#F95F4A] text-[15px] font-medium text-white transition-[filter] duration-150 hover:brightness-[1.05]"
        >
          Back to lobby
        </Link>
      </section>
    </main>
  );
}
