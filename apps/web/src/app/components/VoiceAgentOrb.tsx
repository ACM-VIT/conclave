"use client";

import { useEffect, useRef } from "react";

type VoiceAgentOrbState = "idle" | "thinking" | "speaking";

interface VoiceAgentOrbProps {
  state?: VoiceAgentOrbState;
  compact?: boolean;
  className?: string;
  /**
   * The agent's audio stream. When provided, the orb reacts to its live
   * loudness — swelling and brightening as the agent speaks.
   */
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

/**
 * Ambient "sky" orb for the AI voice agent: a soft sphere with blurred cloud
 * layers drifting inside and a slow, soothing hue drift. When an audioStream is
 * passed it becomes reactive — an analyser drives the `--vao-level` custom
 * property (0–1) from the agent's live loudness, which the CSS maps to a gentle
 * swell and brightening. All motion is disabled under prefers-reduced-motion by
 * the global reset in globals.css.
 */
export default function VoiceAgentOrb({
  state = "idle",
  compact = false,
  className,
  audioStream = null,
}: VoiceAgentOrbProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !audioStream || audioStream.getAudioTracks().length === 0) {
      return;
    }
    const AudioCtor = getAudioContextCtor();
    if (!AudioCtor) return;

    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let raf = 0;
    let smoothed = 0;
    let disposed = false;

    try {
      context = new AudioCtor();
      source = context.createMediaStreamSource(audioStream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      // Analyser is a sink only — nothing is routed to the destination, so this
      // never double-plays the agent audio (ParticipantAudio owns playback).
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
        // Gain up quiet speech, then ease toward the target so the orb glides
        // instead of jittering frame to frame.
        const target = Math.min(1, rms * 2.6);
        smoothed += (target - smoothed) * 0.25;
        root.style.setProperty("--vao-level", smoothed.toFixed(3));
        raf = window.requestAnimationFrame(tick);
      };

      void context.resume().catch(() => undefined);
      raf = window.requestAnimationFrame(tick);
    } catch {
      // Autoplay/AudioContext restrictions: fall back to the non-reactive orb.
    }

    return () => {
      disposed = true;
      if (raf) window.cancelAnimationFrame(raf);
      try {
        source?.disconnect();
      } catch {}
      if (context) void context.close().catch(() => undefined);
      root.style.removeProperty("--vao-level");
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
      </div>
    </div>
  );
}
