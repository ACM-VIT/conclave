// Shared button classes for the Conclave brand screens (loading / error /
// not-found / entry overlay). Kept in a plain module — no "use client" — so both
// server components (e.g. not-found.tsx) and client components can import them.

export const BRAND_BTN_PRIMARY =
  "inline-flex h-12 w-full items-center justify-center rounded-xl bg-[#F95F4A] text-[15px] font-medium text-white transition-[filter] duration-150 hover:brightness-[1.05]";

export const BRAND_BTN_GHOST =
  "inline-flex h-12 w-full items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-[15px] font-medium text-[#fafafa] transition-colors duration-150 hover:bg-white/[0.09]";
