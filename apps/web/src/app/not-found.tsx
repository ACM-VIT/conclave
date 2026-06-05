import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-dvh bg-[#18181b] text-white flex items-center justify-center px-6 relative overflow-hidden">
      <div className="absolute inset-0 acm-bg-dot-grid pointer-events-none" />
      <div className="relative z-10 flex flex-col items-center text-center animate-fade-in">
        <div
          className="text-[11px] uppercase tracking-[0.3em] text-[#fafafa]/56"
          style={{ fontFamily: "'PolySans Trial', sans-serif" }}
        >
          404 · Not Found
        </div>
        <div className="relative inline-flex items-center mt-6">
          <span
            className="absolute -left-10 text-[#F95F4A]/40 text-4xl"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            [
          </span>
          <h1
            className="text-4xl md:text-5xl text-[#fafafa] tracking-tight"
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            Lost in the void
          </h1>
          <span
            className="absolute -right-10 text-[#F95F4A]/40 text-4xl"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            ]
          </span>
        </div>
        <p
          className="mt-5 text-sm text-[#fafafa]/30 max-w-md"
          style={{ fontFamily: "'PolySans Trial', sans-serif" }}
        >
          The room or page you&apos;re looking for doesn&apos;t exist. Jump back
          to the lobby and start fresh.
        </p>
        <Link
          href="/"
          className="group mt-10 flex items-center gap-3 px-8 py-3 bg-[#F95F4A] text-white text-xs uppercase tracking-widest rounded-lg hover:bg-[#e8553f] transition-all hover:gap-4"
          style={{ fontFamily: "'PolySans Trial', sans-serif" }}
        >
          <span>Back to Lobby</span>
          <span className="w-2.5 h-2.5 border-t-2 border-r-2 border-white rotate-45" />
        </Link>
      </div>
    </div>
  );
}
