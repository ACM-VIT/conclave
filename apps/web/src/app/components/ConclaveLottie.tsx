"use client";

import { useEffect, useRef } from "react";
import type { AnimationItem } from "lottie-web";
import { loadConclaveAnimation } from "../lib/conclaveAnimation";

const ART_W = 3222;
const ART_H = 2160;

const FOCUS_X = 0.521;
const FOCUS_Y = 0.536;

type ConclaveLottieProps = {
  speed?: number;
  loop?: boolean;
  width?: string;
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
        const [lottieModule, animationData] = await Promise.all([
          import("lottie-web"),
          loadConclaveAnimation(),
        ]);
        if (cancelled || !containerRef.current) return;

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
      }
    })();

    return () => {
      cancelled = true;
      anim?.destroy();
    };
  }, [loop, speed]);

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
