"use client";

import { useEffect, useRef } from "react";
import type { AnimationItem } from "lottie-web";
import { loadConclaveAnimation } from "../lib/conclaveAnimation";

const ART_W = 3222;
const ART_H = 2160;

// The resolved logo lockup (C-mark + camera + "conclave" wordmark) sits in the
// middle of a much larger, mostly-empty artboard. These fractions are the
// optical center of that lockup within the artboard — we place THIS point
// (rather than the artboard center) so the mark reads centered on every screen
// and is never cropped. Tuned visually against the resolved frame.
const FOCUS_X = 0.521;
const FOCUS_Y = 0.536;

type ConclaveLottieProps = {
  /** Playback multiplier — the raw export runs slow for a loader. */
  speed?: number;
  loop?: boolean;
  /** CSS width of the artboard box (the lockup is ~26% of it). */
  width?: string;
  /** Viewport vertical placement of the lockup's optical center. */
  top?: string;
  onReady?: () => void;
};

export default function ConclaveLottie({
  speed = 3,
  loop = true,
  width = "clamp(560px, 82vw, 1060px)",
  top = "41%",
  onReady,
}: ConclaveLottieProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    let cancelled = false;
    let anim: AnimationItem | null = null;

    void (async () => {
      try {
        // lottie-web touches `window` on import, so keep it client-only and
        // out of the initial bundle via dynamic import.
        const [lottieModule, animationData] = await Promise.all([
          import("lottie-web"),
          loadConclaveAnimation(),
        ]);
        if (cancelled || !containerRef.current) return;

        // canvas renderer: this is a video-to-lottie (a 301-frame WebP image
        // sequence), so canvas draws one frame at a time instead of spawning
        // hundreds of <image> nodes the way the SVG renderer would.
        anim = lottieModule.default.loadAnimation({
          container: containerRef.current,
          renderer: "canvas",
          loop,
          autoplay: true,
          animationData,
          rendererSettings: {
            preserveAspectRatio: "xMidYMid meet",
            clearCanvas: true,
          },
        });
        anim.setSpeed(speed);
        onReadyRef.current?.();
      } catch {
        // Caller still shows its backdrop + text without the animation.
      }
    })();

    return () => {
      cancelled = true;
      anim?.destroy();
    };
  }, [loop, speed]);

  // Absolutely positioned box at the artboard's aspect ratio, shifted so the
  // lockup's optical center lands at (50%, `top`) of the positioned ancestor.
  // The empty artboard margins overflow into the (black) backdrop and clip.
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: "50%",
        top,
        width,
        aspectRatio: `${ART_W} / ${ART_H}`,
        transform: `translate(${(-FOCUS_X * 100).toFixed(2)}%, ${(-FOCUS_Y * 100).toFixed(2)}%)`,
      }}
    >
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
