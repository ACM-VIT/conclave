"use client";

import type { ReactNode } from "react";
import { motion } from "motion/react";
import ConclaveLottie from "./ConclaveLottie";

function BrandDots() {
  return (
    <span className="inline-flex items-center gap-[3px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="h-[3px] w-[3px] rounded-full bg-current"
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{
            duration: 1.1,
            repeat: Infinity,
            delay: i * 0.18,
            ease: "easeInOut",
          }}
        />
      ))}
    </span>
  );
}

export function BrandCaption({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-[13px] font-medium tracking-[0.01em] text-[#fafafa]/55">
      {children}
      <BrandDots />
    </span>
  );
}

export function BrandMessage({
  eyebrow,
  title,
  detail,
  actions,
}: {
  eyebrow?: string;
  title?: string;
  detail?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex w-full max-w-[380px] flex-col items-center text-center">
      {eyebrow ? (
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-[#fafafa]/40">
          {eyebrow}
        </p>
      ) : null}
      {title ? (
        <h1
          className="mt-2.5 text-[21px] leading-tight text-[#fafafa]"
          style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
        >
          {title}
        </h1>
      ) : null}
      {detail ? (
        <p className="mt-2 text-[13.5px] leading-snug text-[#fafafa]/55">
          {detail}
        </p>
      ) : null}
      {actions ? (
        <div className="mt-6 flex w-full flex-col gap-2.5">{actions}</div>
      ) : null}
    </div>
  );
}

type ConclaveBrandScreenProps = {
  caption?: string;
  eyebrow?: string;
  title?: string;
  detail?: string;
  actions?: ReactNode;
};

// Full-screen brand surface: the Conclave Lottie stays the visible centerpiece
// while a caption (loading) or message + actions (error / not-found) sit low
// over the already-black lower frame, never covering the mark. Shared by the
// route loading/error/not-found screens.
export default function ConclaveBrandScreen({
  caption,
  eyebrow,
  title,
  detail,
  actions,
}: ConclaveBrandScreenProps) {
  return (
    <main className="relative min-h-dvh w-full overflow-hidden bg-black text-[#fafafa]">
      <ConclaveLottie />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black via-black/65 to-transparent" />
      <div className="absolute inset-x-0 bottom-[max(env(safe-area-inset-bottom,0px)+5vh,7vh)] flex flex-col items-center px-6 text-center">
        {caption ? (
          <BrandCaption>{caption}</BrandCaption>
        ) : (
          <BrandMessage
            eyebrow={eyebrow}
            title={title}
            detail={detail}
            actions={actions}
          />
        )}
      </div>
    </main>
  );
}
