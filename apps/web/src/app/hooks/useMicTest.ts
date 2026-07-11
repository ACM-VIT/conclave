"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_AUDIO_CONSTRAINTS } from "../lib/constants";
import { createNoiseCancellationPipeline } from "../lib/noise-cancellation";

type MicLoopbackPhase = "idle" | "recording" | "playing";

export interface MicTestController {
  /** Capture + analysis chain is live and metering. */
  isRunning: boolean;
  isStarting: boolean;
  error: string | null;
  /** Whether the metered signal actually went through noise cancellation
   * (the pipeline can fail and fall back to the raw mic). */
  usingNoiseCancellation: boolean;
  /** Smoothed input level 0..1, updated every animation frame. Read it from a
   * rAF loop instead of state so the meter doesn't re-render the panel. */
  levelRef: React.MutableRefObject<number>;
  gain: number;
  setGain: (value: number) => void;
  loopbackPhase: MicLoopbackPhase;
  /** Seconds left while recording the loopback clip. */
  loopbackSecondsLeft: number;
  /** idle → record a short clip; recording → stop early and play; playing → stop. */
  toggleLoopback: () => void;
  /** Current private, post-gain microphone stream for explicit local tests. */
  getRecordingStream: () => MediaStream | null;
}

const LOOPBACK_MAX_SECONDS = 5;
const LEVEL_SCALE = 4.5; // speech RMS is ~0.05–0.25; scale into a useful 0..1
const MIN_GAIN = 0;
const MAX_GAIN = 2;

const describeMicTestError = (err: unknown): string => {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError" || err.name === "SecurityError") {
      return "Microphone access is blocked. Allow microphone access in your browser to test it.";
    }
    if (err.name === "NotFoundError" || err.name === "OverconstrainedError") {
      return "The selected microphone was not found.";
    }
    if (err.name === "NotReadableError" || err.name === "AbortError") {
      return "The microphone is in use by another app.";
    }
  }
  return "Microphone test failed to start.";
};

const pickRecorderMimeType = (): string | undefined => {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const candidate of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {}
  }
  return undefined;
};

/**
 * Private microphone test chain: its own getUserMedia capture (same
 * constraints as the published mic), optionally routed through the same
 * noise-cancellation pipeline the meeting publishes with, then through a test
 * gain into an analyser. Nothing here touches the mediasoup producers — the
 * meeting keeps hearing (or not hearing) exactly what it did before.
 */
export function useMicTest({
  active,
  deviceId,
  noiseCancellation,
  outputDeviceId,
}: {
  active: boolean;
  deviceId?: string;
  noiseCancellation: boolean;
  /** Speaker used for loopback playback. */
  outputDeviceId?: string;
}): MicTestController {
  const [isRunning, setIsRunning] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usingNoiseCancellation, setUsingNoiseCancellation] = useState(false);
  const [gain, setGainState] = useState(1);
  const [loopbackPhase, setLoopbackPhase] = useState<MicLoopbackPhase>("idle");
  const [loopbackSecondsLeft, setLoopbackSecondsLeft] =
    useState(LOOPBACK_MAX_SECONDS);

  const levelRef = useRef(0);
  const gainRef = useRef(1);
  const gainNodeRef = useRef<GainNode | null>(null);
  const recorderStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderTimeoutRef = useRef<number | null>(null);
  const recorderCountdownRef = useRef<number | null>(null);
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const playbackUrlRef = useRef<string | null>(null);
  const outputDeviceIdRef = useRef(outputDeviceId);
  outputDeviceIdRef.current = outputDeviceId;

  const setGain = useCallback((value: number) => {
    const clamped = Math.min(MAX_GAIN, Math.max(MIN_GAIN, value));
    gainRef.current = clamped;
    const node = gainNodeRef.current;
    if (node) node.gain.value = clamped;
    setGainState(clamped);
  }, []);

  const getRecordingStream = useCallback(
    () => recorderStreamRef.current,
    [],
  );

  const clearRecorderTimers = useCallback(() => {
    if (recorderTimeoutRef.current !== null) {
      window.clearTimeout(recorderTimeoutRef.current);
      recorderTimeoutRef.current = null;
    }
    if (recorderCountdownRef.current !== null) {
      window.clearInterval(recorderCountdownRef.current);
      recorderCountdownRef.current = null;
    }
  }, []);

  const stopPlayback = useCallback(() => {
    const audio = playbackAudioRef.current;
    playbackAudioRef.current = null;
    if (audio) {
      try {
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.src = "";
      } catch {}
    }
    if (playbackUrlRef.current) {
      URL.revokeObjectURL(playbackUrlRef.current);
      playbackUrlRef.current = null;
    }
  }, []);

  const stopLoopback = useCallback(() => {
    clearRecorderTimers();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      // Neutralize handlers unconditionally: stop() flips state to
      // "inactive" synchronously while the onstop event is still queued, so
      // an already-inactive recorder can still fire playback afterwards.
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {}
      }
    }
    stopPlayback();
    setLoopbackPhase("idle");
    setLoopbackSecondsLeft(LOOPBACK_MAX_SECONDS);
  }, [clearRecorderTimers, stopPlayback]);

  // Build / tear down the capture chain whenever the inputs change.
  useEffect(() => {
    if (!active) return;
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setError("Microphone testing is not available in this browser.");
      return;
    }

    let cancelled = false;
    let sourceStream: MediaStream | null = null;
    let pipelineCleanup: (() => void) | null = null;
    let context: AudioContext | null = null;
    let rafId: number | null = null;
    const nodes: AudioNode[] = [];

    setIsStarting(true);
    setError(null);

    const run = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...DEFAULT_AUDIO_CONSTRAINTS,
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        sourceStream = stream;
        const rawTrack = stream.getAudioTracks()[0];
        if (!rawTrack) throw new Error("No audio track obtained");

        let monitorTrack = rawTrack;
        let usedNoiseCancellation = false;
        if (noiseCancellation) {
          try {
            const pipeline = await createNoiseCancellationPipeline(rawTrack);
            if (cancelled) {
              pipeline.cleanup({ stopSource: true, stopOutput: true });
              return;
            }
            monitorTrack = pipeline.outputTrack;
            usedNoiseCancellation = true;
            pipelineCleanup = () =>
              pipeline.cleanup({ stopSource: false, stopOutput: true });
          } catch {
            // Pipeline unavailable — meter the raw mic instead.
          }
        }

        const AudioContextConstructor =
          window.AudioContext ||
          (
            window as typeof window & {
              webkitAudioContext?: typeof AudioContext;
            }
          ).webkitAudioContext;
        if (!AudioContextConstructor) {
          throw new Error("Web Audio is not available");
        }
        context = new AudioContextConstructor({ latencyHint: "interactive" });
        if (context.state === "suspended") {
          void context.resume().catch(() => {});
        }

        const source = context.createMediaStreamSource(
          new MediaStream([monitorTrack]),
        );
        const gainNode = context.createGain();
        gainNode.gain.value = gainRef.current;
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        // Post-gain destination so loopback records what the meter shows.
        const recorderDestination = context.createMediaStreamDestination();

        source.connect(gainNode);
        gainNode.connect(analyser);
        gainNode.connect(recorderDestination);
        nodes.push(source, gainNode, analyser, recorderDestination);

        gainNodeRef.current = gainNode;
        recorderStreamRef.current = recorderDestination.stream;

        const samples = new Float32Array(analyser.fftSize);
        const tick = () => {
          if (cancelled) return;
          analyser.getFloatTimeDomainData(samples);
          let sumSquares = 0;
          for (let i = 0; i < samples.length; i += 1) {
            sumSquares += samples[i] * samples[i];
          }
          const rms = Math.sqrt(sumSquares / samples.length);
          const target = Math.min(1, rms * LEVEL_SCALE);
          const previous = levelRef.current;
          // Fast attack, slower release so peaks are visible but not jumpy.
          levelRef.current =
            target > previous
              ? previous + (target - previous) * 0.55
              : previous + (target - previous) * 0.12;
          rafId = window.requestAnimationFrame(tick);
        };
        rafId = window.requestAnimationFrame(tick);

        setUsingNoiseCancellation(usedNoiseCancellation);
        setIsRunning(true);
        setIsStarting(false);
      } catch (err) {
        if (cancelled) return;
        // Tear down everything built before the failure (the NC pipeline and
        // audio context can already exist by the time something throws).
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }
        gainNodeRef.current = null;
        recorderStreamRef.current = null;
        for (const node of nodes) {
          try {
            node.disconnect();
          } catch {}
        }
        nodes.length = 0;
        pipelineCleanup?.();
        pipelineCleanup = null;
        sourceStream?.getTracks().forEach((track) => track.stop());
        sourceStream = null;
        if (context) {
          void context.close().catch(() => {});
          context = null;
        }
        setError(describeMicTestError(err));
        setIsStarting(false);
        setIsRunning(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      stopLoopback();
      gainNodeRef.current = null;
      recorderStreamRef.current = null;
      for (const node of nodes) {
        try {
          node.disconnect();
        } catch {}
      }
      pipelineCleanup?.();
      sourceStream?.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });
      if (context) {
        void context.close().catch(() => {});
      }
      levelRef.current = 0;
      setIsRunning(false);
      setUsingNoiseCancellation(false);
    };
    // stopLoopback is stable; deviceId/noiseCancellation changes rebuild the chain.
  }, [active, deviceId, noiseCancellation, stopLoopback]);

  const playLoopbackClip = useCallback(
    (chunks: Blob[], mimeType: string | undefined) => {
      if (chunks.length === 0) {
        setLoopbackPhase("idle");
        return;
      }
      stopPlayback();
      const blob = new Blob(chunks, mimeType ? { type: mimeType } : undefined);
      const url = URL.createObjectURL(blob);
      const audio = new Audio();
      playbackAudioRef.current = audio;
      playbackUrlRef.current = url;
      audio.src = url;
      const finish = () => {
        if (playbackAudioRef.current === audio) {
          stopPlayback();
          setLoopbackPhase("idle");
        }
      };
      audio.onended = finish;
      audio.onerror = finish;
      const sinkId = outputDeviceIdRef.current;
      const sinkCapable = audio as HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
      };
      const applySink =
        sinkId && sinkCapable.setSinkId
          ? sinkCapable.setSinkId(sinkId).catch(() => {})
          : Promise.resolve();
      setLoopbackPhase("playing");
      void applySink.then(() =>
        audio.play().catch(() => {
          finish();
        }),
      );
    },
    [stopPlayback],
  );

  const toggleLoopback = useCallback(() => {
    if (loopbackPhase === "playing") {
      stopPlayback();
      setLoopbackPhase("idle");
      return;
    }
    if (loopbackPhase === "recording") {
      // Stop early: the recorder's onstop hands the clip to playback.
      clearRecorderTimers();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          stopLoopback();
        }
      } else {
        stopLoopback();
      }
      return;
    }

    const stream = recorderStreamRef.current;
    if (!stream || typeof MediaRecorder === "undefined") return;

    const mimeType = pickRecorderMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
    } catch {
      return;
    }

    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      if (recorderRef.current === recorder) {
        recorderRef.current = null;
      }
      clearRecorderTimers();
      playLoopbackClip(chunks, mimeType);
    };
    recorderRef.current = recorder;
    try {
      recorder.start();
    } catch {
      recorderRef.current = null;
      return;
    }
    setLoopbackPhase("recording");
    setLoopbackSecondsLeft(LOOPBACK_MAX_SECONDS);
    const startedAt = Date.now();
    recorderCountdownRef.current = window.setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      setLoopbackSecondsLeft(
        Math.max(0, Math.ceil(LOOPBACK_MAX_SECONDS - elapsed)),
      );
    }, 250);
    recorderTimeoutRef.current = window.setTimeout(() => {
      if (recorderRef.current === recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {}
      }
    }, LOOPBACK_MAX_SECONDS * 1000);
  }, [
    clearRecorderTimers,
    loopbackPhase,
    playLoopbackClip,
    stopLoopback,
    stopPlayback,
  ]);

  return {
    isRunning,
    isStarting,
    error,
    usingNoiseCancellation,
    levelRef,
    gain,
    setGain,
    loopbackPhase,
    loopbackSecondsLeft,
    toggleLoopback,
    getRecordingStream,
  };
}

/**
 * Plays a short two-note chime through the chosen speaker so people can check
 * the right output device is selected. Local playback only.
 */
export async function playSpeakerTestSound(
  outputDeviceId?: string,
): Promise<void> {
  if (typeof window === "undefined") return;
  const AudioContextConstructor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextConstructor) return;

  const context = new AudioContextConstructor();
  if (context.state === "suspended") {
    await context.resume().catch(() => {});
  }
  const destination = context.createMediaStreamDestination();
  const master = context.createGain();
  master.gain.value = 0.5;
  master.connect(destination);

  const now = context.currentTime;
  const notes: { frequency: number; start: number; duration: number }[] = [
    { frequency: 659.25, start: 0, duration: 0.28 },
    { frequency: 880, start: 0.22, duration: 0.5 },
  ];
  for (const note of notes) {
    const osc = context.createOscillator();
    osc.type = "sine";
    osc.frequency.value = note.frequency;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, now + note.start);
    envelope.gain.linearRampToValueAtTime(0.9, now + note.start + 0.02);
    envelope.gain.exponentialRampToValueAtTime(
      0.001,
      now + note.start + note.duration,
    );
    osc.connect(envelope);
    envelope.connect(master);
    osc.start(now + note.start);
    osc.stop(now + note.start + note.duration + 0.05);
  }

  const audio = new Audio();
  audio.srcObject = destination.stream;
  const sinkCapable = audio as HTMLAudioElement & {
    setSinkId?: (sinkId: string) => Promise<void>;
  };
  if (outputDeviceId && sinkCapable.setSinkId) {
    await sinkCapable.setSinkId(outputDeviceId).catch(() => {});
  }
  await audio.play().catch(() => {});

  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 900);
  });
  try {
    audio.pause();
    audio.srcObject = null;
  } catch {}
  try {
    master.disconnect();
  } catch {}
  await context.close().catch(() => {});
}
