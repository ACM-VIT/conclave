"use client";

import { useEffect, useRef } from "react";

type VoiceAgentOrbState = "idle" | "thinking" | "speaking";

interface VoiceAgentOrbProps {
  state?: VoiceAgentOrbState;
  compact?: boolean;
  className?: string;
  audioStream?: MediaStream | null;
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

const getAudioContextCtor = (): AudioContextCtor | null => {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: AudioContextCtor })
      .webkitAudioContext ??
    null
  );
};

export default function VoiceAgentOrb({
  state = "idle",
  compact = false,
  className,
  audioStream = null,
}: VoiceAgentOrbProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const glow = glowRef.current;
    if (
      !root ||
      !glow ||
      !audioStream ||
      audioStream.getAudioTracks().length === 0
    ) {
      return;
    }
    const AudioCtor = getAudioContextCtor();
    if (!AudioCtor) return;

    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let raf = 0;
    let smoothed = 0;
    let disposed = false;
    let lastWritten = 0;
    const motionQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    let reduceMotion = motionQuery?.matches ?? false;
    const onMotionPreferenceChange = (event: MediaQueryListEvent) => {
      reduceMotion = event.matches;
      if (reduceMotion) {
        root.style.removeProperty("transform");
      } else {
        lastWritten = -1;
      }
    };
    motionQuery?.addEventListener("change", onMotionPreferenceChange);

    try {
      context = new AudioCtor();
      source = context.createMediaStreamSource(audioStream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);

      const tick = () => {
        if (disposed) return;
        analyser.getByteTimeDomainData(samples);
        let sumSquares = 0;
        for (let i = 0; i < samples.length; i += 1) {
          const centered = (samples[i] - 128) / 128;
          sumSquares += centered * centered;
        }
        const rms = Math.sqrt(sumSquares / samples.length);
        const target = Math.min(1, rms * 2.6);
        smoothed += (target - smoothed) * 0.25;
        if (smoothed < 0.004) smoothed = 0;
        if (
          Math.abs(smoothed - lastWritten) >= 0.004 ||
          (smoothed === 0 && lastWritten !== 0)
        ) {
          lastWritten = smoothed;
          if (!reduceMotion) {
            root.style.transform = `scale(${(1 + smoothed * 0.09).toFixed(4)})`;
          }
          glow.style.opacity = (0.08 + smoothed * 0.6).toFixed(3);
        }
        raf = window.requestAnimationFrame(tick);
      };

      void context.resume().catch(() => undefined);
      raf = window.requestAnimationFrame(tick);
    } catch {
    }

    return () => {
      disposed = true;
      if (raf) window.cancelAnimationFrame(raf);
      motionQuery?.removeEventListener("change", onMotionPreferenceChange);
      try {
        source?.disconnect();
      } catch {}
      if (context) void context.close().catch(() => undefined);
      root.style.removeProperty("transform");
      glow.style.removeProperty("opacity");
    };
  }, [audioStream]);

  const classes = [
    "voice-agent-orb",
    compact ? "voice-agent-orb--compact" : "voice-agent-orb--regular",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={rootRef} className={classes} data-state={state} aria-hidden="true">
      <div className="voice-agent-orb-core">
        <div className="voice-agent-orb-cloud" />
        <div className="voice-agent-orb-cloud" />
        <div className="voice-agent-orb-cloud" />
        <div ref={glowRef} className="voice-agent-orb-glow" />
      </div>
    </div>
  );
}
