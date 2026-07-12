"use client";

import {
  AudioLines,
  Check,
  LoaderCircle,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { color } from "@conclave/ui-tokens";
import type {
  ClonedTtsVoice,
  TtsSystemVoiceOption,
} from "../hooks/useMeetTts";

// The voice provider's instant-clone guidance: 1 to 2 minutes of clean,
// consistent audio gives the best likeness; short samples clone poorly.
const MIN_RECORDING_SECONDS = 60;
const MAX_RECORDING_SECONDS = 120;
const ICON_STROKE = 1.75;
const SAMPLE_SCRIPT =
  "Hi, this is my voice. I am recording a short sample so my spoken chat " +
  "messages in Conclave sound like me. When I send a message out loud, this " +
  "is the voice everyone in the meeting will hear, so I want it to sound " +
  "natural, steady, and clear. I am speaking the way I normally talk in a " +
  "call: relaxed, at a comfortable pace, without rushing. A few varied lines " +
  "help the clone. The quick brown fox jumps over the lazy dog. Pack my box " +
  "with five dozen liquor jugs. Sphinx of black quartz, judge my vow. One, " +
  "two, three, four, five, six, seven, eight, nine, ten. In a meeting I " +
  "might say: can everyone see my screen, let us take a look at the " +
  "dashboard, or I will follow up right after the call. I will keep reading " +
  "in this same tone until the timer fills, because a longer, consistent " +
  "sample makes my voice sound more like me.";

const formatClock = (totalSeconds: number): string => {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
};
const CLONE_PREVIEW_TEXT =
  "Hey everyone, this is how my chat messages sound when I send them as speech.";
const SYSTEM_PREVIEW_TEXT =
  "This is the standard voice used for spoken chat messages.";

type EnrollmentPhase =
  | "idle"
  | "recording"
  | "review"
  | "uploading"
  | "deleting";

type PreviewPhase = "idle" | "loading" | "playing";

const pickRecorderMimeType = (): string | undefined => {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const candidate of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {}
  }
  return undefined;
};

const readError = async (response: Response, fallback: string): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
};

const attachSink = async (
  audio: HTMLAudioElement,
  outputDeviceId?: string,
): Promise<void> => {
  const sinkCapable = audio as HTMLAudioElement & {
    setSinkId?: (sinkId: string) => Promise<void>;
  };
  if (outputDeviceId && sinkCapable.setSinkId) {
    await sinkCapable.setSinkId(outputDeviceId).catch(() => {});
  }
};

/**
 * Scrolling level-history waveform for the active recording, fed by its own
 * analyser so it tracks exactly what the recorder hears.
 */
function LiveWaveform({ stream }: { stream: MediaStream | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stream) return;
    const AudioContextCtor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextCtor) return;

    const audioContext = new AudioContextCtor();
    let source: MediaStreamAudioSourceNode;
    try {
      source = audioContext.createMediaStreamSource(stream);
    } catch {
      void audioContext.close().catch(() => {});
      return;
    }
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const data = new Uint8Array(analyser.fftSize);
    const history: number[] = [];
    let frame = 0;

    const draw = () => {
      frame = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const value = (data[i] - 128) / 128;
        sum += value * value;
      }
      const level = Math.min(1, Math.sqrt(sum / data.length) * 3.2);

      const context = canvas.getContext("2d");
      if (!context) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth * dpr;
      const height = canvas.clientHeight * dpr;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      const barWidth = 3 * dpr;
      const gap = 2 * dpr;
      const maxBars = Math.max(8, Math.floor(width / (barWidth + gap)));
      history.push(level);
      while (history.length > maxBars) history.shift();

      context.clearRect(0, 0, width, height);
      context.fillStyle = "#F95F4A";
      const mid = height / 2;
      for (let index = 0; index < history.length; index += 1) {
        const x = width - (history.length - index) * (barWidth + gap);
        const barHeight = Math.max(
          2 * dpr,
          history[index] ** 0.8 * (height - 4 * dpr),
        );
        context.fillRect(x, mid - barHeight / 2, barWidth, barHeight);
      }
    };
    draw();

    return () => {
      cancelAnimationFrame(frame);
      try {
        source.disconnect();
      } catch {}
      void audioContext.close().catch(() => {});
    };
  }, [stream]);

  return <canvas ref={canvasRef} aria-hidden="true" className="h-10 w-full" />;
}

interface RecordingReview {
  blob: Blob;
  url: string;
  mimeType: string;
  durationSeconds: number;
}

interface TtsVoiceSettingsProps {
  systemVoices: TtsSystemVoiceOption[];
  selectedSystemVoiceUri?: string | null;
  onSystemVoiceChange?: (voiceUri: string | null) => void;
  clonedVoice?: ClonedTtsVoice | null;
  onClonedVoiceChange?: (voice: ClonedTtsVoice) => void;
  onClonedVoiceClear?: () => void;
  getRecordingStream: () => MediaStream | null;
  canCloneVoice: boolean;
  ownerName: string;
  audioOutputDeviceId?: string;
}

export default function TtsVoiceSettings({
  systemVoices,
  selectedSystemVoiceUri,
  onSystemVoiceChange,
  clonedVoice,
  onClonedVoiceChange,
  onClonedVoiceClear,
  getRecordingStream,
  canCloneVoice,
  ownerName,
  audioOutputDeviceId,
}: TtsVoiceSettingsProps) {
  const [phase, setPhase] = useState<EnrollmentPhase>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [hasConsent, setHasConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<RecordingReview | null>(null);
  const [recordingStream, setRecordingStream] = useState<MediaStream | null>(
    null,
  );
  const [isReviewPlaying, setIsReviewPlaying] = useState(false);
  const [reviewProgress, setReviewProgress] = useState(0);
  const [clonePreviewPhase, setClonePreviewPhase] =
    useState<PreviewPhase>("idle");
  const [isSystemPreviewPlaying, setIsSystemPreviewPlaying] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const intervalRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const reviewAudioRef = useRef<HTMLAudioElement | null>(null);
  const reviewUrlRef = useRef<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  // True only while a system-voice preview this component started is live.
  // Guards the global speechSynthesis.cancel() so closing settings never
  // cuts off an unrelated /tts message being spoken in the meeting.
  const ownsSystemPreviewRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    intervalRef.current = null;
    timeoutRef.current = null;
  }, []);

  const stopReviewPlayback = useCallback(() => {
    const audio = reviewAudioRef.current;
    reviewAudioRef.current = null;
    if (audio) {
      audio.onended = null;
      audio.ontimeupdate = null;
      audio.onerror = null;
      audio.pause();
      audio.src = "";
    }
    setIsReviewPlaying(false);
    setReviewProgress(0);
  }, []);

  const discardReview = useCallback(() => {
    stopReviewPlayback();
    if (reviewUrlRef.current) {
      URL.revokeObjectURL(reviewUrlRef.current);
      reviewUrlRef.current = null;
    }
    setReview(null);
  }, [stopReviewPlayback]);

  const stopClonePreview = useCallback(() => {
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    const audio = previewAudioRef.current;
    previewAudioRef.current = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = "";
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setClonePreviewPhase("idle");
  }, []);

  const stopSystemPreview = useCallback(() => {
    if (!ownsSystemPreviewRef.current) return;
    ownsSystemPreviewRef.current = false;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
    setIsSystemPreviewPlaying(false);
  }, []);

  const finishRecording = useCallback(() => {
    clearTimers();
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    try {
      recorder.stop();
    } catch {
      recorderRef.current = null;
      setRecordingStream(null);
      setPhase("idle");
      setError("The recording could not be completed.");
    }
  }, [clearTimers]);

  const startRecording = useCallback(() => {
    setError(null);
    discardReview();
    const stream = getRecordingStream();
    if (!stream?.getAudioTracks().some((track) => track.readyState === "live")) {
      setError("Wait for the microphone test above to start, then try again.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setError("Voice recording is not supported in this browser.");
      return;
    }

    const mimeType = pickRecorderMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      setError("Voice recording could not start.");
      return;
    }

    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      recorderRef.current = null;
      if (!mountedRef.current) return;
      setRecordingStream(null);
      const duration = Math.min(
        MAX_RECORDING_SECONDS,
        (Date.now() - startedAtRef.current) / 1000,
      );
      const recordedType = recorder.mimeType || mimeType || "audio/webm";
      if (duration < MIN_RECORDING_SECONDS) {
        setPhase("idle");
        setError(
          `Keep speaking for at least ${formatClock(MIN_RECORDING_SECONDS)} so the clone has enough to learn from.`,
        );
        return;
      }
      const blob = new Blob(chunksRef.current, { type: recordedType });
      if (!blob.size) {
        setPhase("idle");
        setError("Nothing was recorded. Check your microphone and try again.");
        return;
      }
      const url = URL.createObjectURL(blob);
      reviewUrlRef.current = url;
      setReview({ blob, url, mimeType: recordedType, durationSeconds: duration });
      setPhase("review");
    };
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setElapsedSeconds(0);
    setPhase("recording");
    try {
      recorder.start(500);
    } catch {
      recorderRef.current = null;
      setPhase("idle");
      setError("Voice recording could not start.");
      return;
    }
    setRecordingStream(stream);

    intervalRef.current = window.setInterval(() => {
      setElapsedSeconds(
        Math.min(MAX_RECORDING_SECONDS, (Date.now() - startedAtRef.current) / 1000),
      );
    }, 100);
    timeoutRef.current = window.setTimeout(finishRecording, MAX_RECORDING_SECONDS * 1000);
  }, [discardReview, finishRecording, getRecordingStream]);

  const reRecord = useCallback(() => {
    setError(null);
    discardReview();
    setPhase("idle");
  }, [discardReview]);

  const toggleReviewPlayback = useCallback(async () => {
    if (!review) return;
    if (isReviewPlaying) {
      stopReviewPlayback();
      return;
    }
    stopClonePreview();
    stopSystemPreview();
    const audio = new Audio(review.url);
    reviewAudioRef.current = audio;
    await attachSink(audio, audioOutputDeviceId);
    // A second click or unmount while the sink attached wins ownership.
    if (!mountedRef.current || reviewAudioRef.current !== audio) {
      audio.pause();
      return;
    }
    audio.ontimeupdate = () => {
      if (reviewAudioRef.current !== audio || !review.durationSeconds) return;
      setReviewProgress(
        Math.min(1, audio.currentTime / review.durationSeconds),
      );
    };
    audio.onended = () => {
      if (reviewAudioRef.current === audio) stopReviewPlayback();
    };
    audio.onerror = () => {
      if (reviewAudioRef.current !== audio) return;
      stopReviewPlayback();
      setError("The recording could not be played back.");
    };
    try {
      await audio.play();
      if (!mountedRef.current || reviewAudioRef.current !== audio) {
        audio.pause();
        return;
      }
      setIsReviewPlaying(true);
    } catch {
      if (reviewAudioRef.current !== audio) return;
      stopReviewPlayback();
      setError("The recording could not be played back.");
    }
  }, [
    audioOutputDeviceId,
    isReviewPlaying,
    review,
    stopClonePreview,
    stopReviewPlayback,
    stopSystemPreview,
  ]);

  const createVoice = useCallback(async () => {
    if (!review || phase !== "review") return;
    if (!hasConsent) {
      setError("Confirm that this is your voice before creating it.");
      return;
    }
    stopReviewPlayback();
    setPhase("uploading");
    setError(null);
    const extension = review.mimeType.includes("mp4") ? "m4a" : "webm";
    const formData = new FormData();
    formData.append("audio", review.blob, `voice-sample.${extension}`);
    formData.append("durationSeconds", review.durationSeconds.toFixed(2));
    formData.append("consent", "true");
    formData.append("name", ownerName);

    try {
      const response = await fetch("/api/tts/voices", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        throw new Error(await readError(response, "Could not create your voice."));
      }
      const body = (await response.json()) as { token?: string; name?: string };
      if (!body.token || !body.name) throw new Error("Voice creation was incomplete.");
      onClonedVoiceChange?.({ token: body.token, name: body.name });
      if (mountedRef.current) {
        discardReview();
        setPhase("idle");
      }
    } catch (uploadError) {
      if (!mountedRef.current) return;
      setPhase("review");
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Could not create your voice.",
      );
    }
  }, [
    discardReview,
    hasConsent,
    onClonedVoiceChange,
    ownerName,
    phase,
    review,
    stopReviewPlayback,
  ]);

  const deleteVoice = useCallback(async () => {
    if (!clonedVoice || phase !== "idle") return;
    stopClonePreview();
    setPhase("deleting");
    setError(null);
    try {
      const response = await fetch("/api/tts/voices/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: clonedVoice.token }),
      });
      if (!response.ok) {
        throw new Error(await readError(response, "Could not delete your voice."));
      }
      onClonedVoiceClear?.();
      setPhase("idle");
    } catch (deleteError) {
      setPhase("idle");
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Could not delete your voice.",
      );
    }
  }, [clonedVoice, onClonedVoiceClear, phase, stopClonePreview]);

  const toggleClonePreview = useCallback(async () => {
    if (!clonedVoice) return;
    if (clonePreviewPhase !== "idle") {
      stopClonePreview();
      return;
    }
    stopReviewPlayback();
    stopSystemPreview();
    setError(null);
    setClonePreviewPhase("loading");
    const controller = new AbortController();
    previewAbortRef.current = controller;
    try {
      const response = await fetch("/api/tts/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: clonedVoice.token,
          text: CLONE_PREVIEW_TEXT,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(await readError(response, "The preview is unavailable."));
      }
      const blob = await response.blob();
      if (controller.signal.aborted || !mountedRef.current) return;
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      await attachSink(audio, audioOutputDeviceId);
      if (controller.signal.aborted || previewAudioRef.current !== audio) {
        audio.pause();
        return;
      }
      audio.onended = () => {
        if (previewAudioRef.current === audio) stopClonePreview();
      };
      audio.onerror = () => {
        if (previewAudioRef.current === audio) stopClonePreview();
      };
      await audio.play();
      if (controller.signal.aborted || previewAudioRef.current !== audio) {
        audio.pause();
        return;
      }
      if (mountedRef.current) setClonePreviewPhase("playing");
    } catch (previewError) {
      if (controller.signal.aborted || !mountedRef.current) return;
      stopClonePreview();
      setError(
        previewError instanceof Error
          ? previewError.message
          : "The preview is unavailable.",
      );
    }
  }, [
    audioOutputDeviceId,
    clonePreviewPhase,
    clonedVoice,
    stopClonePreview,
    stopReviewPlayback,
    stopSystemPreview,
  ]);

  const toggleSystemPreview = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    if (isSystemPreviewPlaying) {
      stopSystemPreview();
      return;
    }
    stopReviewPlayback();
    stopClonePreview();
    try {
      const synth = window.speechSynthesis;
      // Preempt anything already speaking so that from here on the only
      // utterance in flight is ours; stop/unmount cancel is then always safe.
      // A live meeting message recovers through its own error handler.
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(SYSTEM_PREVIEW_TEXT);
      const chosen = synth
        .getVoices()
        .find((voice) => voice.voiceURI === selectedSystemVoiceUri);
      if (chosen) {
        utterance.voice = chosen;
        utterance.lang = chosen.lang;
      }
      utterance.rate = 0.97;
      utterance.onend = () => {
        ownsSystemPreviewRef.current = false;
        if (mountedRef.current) setIsSystemPreviewPlaying(false);
      };
      utterance.onerror = () => {
        ownsSystemPreviewRef.current = false;
        if (mountedRef.current) setIsSystemPreviewPlaying(false);
      };
      synth.speak(utterance);
      ownsSystemPreviewRef.current = true;
      setIsSystemPreviewPlaying(true);
    } catch {
      ownsSystemPreviewRef.current = false;
      setIsSystemPreviewPlaying(false);
    }
  }, [
    isSystemPreviewPlaying,
    selectedSystemVoiceUri,
    stopClonePreview,
    stopReviewPlayback,
    stopSystemPreview,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimers();
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        if (recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {}
        }
      }
      const reviewAudio = reviewAudioRef.current;
      reviewAudioRef.current = null;
      if (reviewAudio) {
        reviewAudio.onended = null;
        reviewAudio.ontimeupdate = null;
        reviewAudio.onerror = null;
        reviewAudio.pause();
      }
      if (reviewUrlRef.current) {
        URL.revokeObjectURL(reviewUrlRef.current);
        reviewUrlRef.current = null;
      }
      previewAbortRef.current?.abort();
      const previewAudio = previewAudioRef.current;
      previewAudioRef.current = null;
      if (previewAudio) {
        previewAudio.onended = null;
        previewAudio.onerror = null;
        previewAudio.pause();
      }
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
      // Only cancels a preview this component started; a live /tts message
      // in the meeting keeps speaking.
      if (
        ownsSystemPreviewRef.current &&
        typeof window !== "undefined" &&
        "speechSynthesis" in window
      ) {
        ownsSystemPreviewRef.current = false;
        try {
          window.speechSynthesis.cancel();
        } catch {}
      }
    };
  }, [clearTimers]);

  const recordedEnough = elapsedSeconds >= MIN_RECORDING_SECONDS;
  const recordingProgress = Math.min(
    100,
    (elapsedSeconds / MAX_RECORDING_SECONDS) * 100,
  );

  const outlinePill =
    "inline-flex items-center justify-center gap-2 rounded-full border px-4 py-2 text-[12.5px] font-medium transition-colors duration-[120ms] hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="space-y-3">
      <div
        className="rounded-xl border p-3"
        style={{ borderColor: color.border, backgroundColor: color.bgAlt }}
      >
        {clonedVoice ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[12px]" style={{ color: color.textMuted }}>
                Your voice
              </p>
              <span className="inline-flex items-center gap-1 text-[11px] text-[#32d583]">
                <Check size={12} strokeWidth={2} /> Ready
              </span>
            </div>
            <p className="mt-1 truncate text-[13px]" style={{ color: color.text }}>
              {clonedVoice.name}
            </p>
            <div className="mt-2.5 flex items-center gap-2">
              <button
                type="button"
                data-testid="tts-clone-preview"
                onClick={() => void toggleClonePreview()}
                disabled={phase !== "idle"}
                className={`${outlinePill} flex-1`}
                style={{ borderColor: color.borderStrong, color: color.text }}
              >
                {clonePreviewPhase === "loading" ? (
                  <LoaderCircle
                    size={14}
                    strokeWidth={ICON_STROKE}
                    className="animate-spin text-[#F95F4A]"
                  />
                ) : clonePreviewPhase === "playing" ? (
                  <Square size={12} strokeWidth={ICON_STROKE} />
                ) : (
                  <Play size={14} strokeWidth={ICON_STROKE} />
                )}
                {clonePreviewPhase === "playing"
                  ? "Stop"
                  : clonePreviewPhase === "loading"
                    ? "Preparing"
                    : "Hear my voice"}
              </button>
              <button
                type="button"
                onClick={() => void deleteVoice()}
                disabled={phase !== "idle"}
                aria-label="Delete my voice"
                title="Delete my voice"
                className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border text-[#f97066] transition-colors duration-[120ms] hover:bg-[#f97066]/10 disabled:cursor-not-allowed disabled:opacity-40"
                style={{ borderColor: color.borderStrong }}
              >
                {phase === "deleting" ? (
                  <LoaderCircle size={14} className="animate-spin" />
                ) : (
                  <Trash2 size={14} strokeWidth={ICON_STROKE} />
                )}
              </button>
            </div>
            <p
              className="mt-1.5 text-[11px] leading-snug"
              style={{ color: color.textFaint }}
            >
              Plays for everyone when you send /tts in chat.
            </p>
          </>
        ) : !canCloneVoice ? (
          <>
            <p className="text-[12px]" style={{ color: color.textMuted }}>
              Your voice
            </p>
            <p
              className="mt-1 text-[12px] leading-relaxed"
              style={{ color: color.textFaint }}
            >
              Sign in with an email account to create a personal voice for
              /tts messages. Until then, messages use the standard voice
              below.
            </p>
          </>
        ) : phase === "review" || phase === "uploading" ? (
          <>
            <p className="mb-2 text-[12px]" style={{ color: color.textMuted }}>
              Listen back before creating your voice
            </p>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                data-testid="tts-review-playback"
                onClick={() => void toggleReviewPlayback()}
                disabled={phase === "uploading"}
                aria-label={isReviewPlaying ? "Pause recording" : "Play recording"}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors duration-[120ms] hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
                style={{ borderColor: color.borderStrong, color: color.text }}
              >
                {isReviewPlaying ? (
                  <Pause size={14} strokeWidth={ICON_STROKE} />
                ) : (
                  <Play size={14} strokeWidth={ICON_STROKE} className="translate-x-[1px]" />
                )}
              </button>
              <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full bg-[#F95F4A] transition-[width] duration-150"
                  style={{ width: `${reviewProgress * 100}%` }}
                />
              </div>
              <span
                className="shrink-0 text-[11.5px] tabular-nums"
                style={{ color: color.textMuted }}
              >
                {review ? formatClock(review.durationSeconds) : ""}
              </span>
            </div>

            <label
              className="mt-3 flex cursor-pointer items-start gap-2.5 text-[11.5px] leading-relaxed"
              style={{ color: color.textMuted }}
            >
              <input
                type="checkbox"
                checked={hasConsent}
                onChange={(event) => setHasConsent(event.target.checked)}
                disabled={phase === "uploading"}
                className="mt-0.5 h-3.5 w-3.5 accent-[#F95F4A]"
              />
              <span>
                This is my voice. I consent to creating a clone of it and
                understand meeting participants may hear it.
              </span>
            </label>

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                data-testid="tts-create-voice"
                onClick={() => void createVoice()}
                disabled={phase === "uploading" || !hasConsent}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-[#F95F4A] px-4 py-2 text-[12.5px] font-semibold text-white transition-[filter] duration-[120ms] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {phase === "uploading" ? (
                  <LoaderCircle size={14} className="animate-spin" />
                ) : (
                  <Check size={14} strokeWidth={2} />
                )}
                {phase === "uploading" ? "Creating" : "Create my voice"}
              </button>
              <button
                type="button"
                onClick={reRecord}
                disabled={phase === "uploading"}
                className={`${outlinePill} shrink-0`}
                style={{ borderColor: color.borderStrong, color: color.text }}
              >
                <RotateCcw size={13} strokeWidth={ICON_STROKE} />
                Redo
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mb-2 text-[12px]" style={{ color: color.textMuted }}>
              {phase === "recording"
                ? "Read this naturally"
                : "Create your voice for /tts messages"}
            </p>
            <p className="devicesettings-scroll max-h-44 overflow-y-auto pr-1 text-[12.5px] leading-relaxed text-[#fafafa]/85">
              {SAMPLE_SCRIPT}
            </p>

            {phase === "recording" ? (
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-[11.5px]">
                  <span className="inline-flex items-center gap-1.5 text-[#f97066]">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#f97066]" />
                    Recording
                  </span>
                  <span className="tabular-nums" style={{ color: color.textMuted }}>
                    {formatClock(elapsedSeconds)} / {formatClock(MAX_RECORDING_SECONDS)}
                  </span>
                </div>
                <LiveWaveform stream={recordingStream} />
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full bg-[#F95F4A] transition-[width] duration-100"
                    style={{ width: `${recordingProgress}%` }}
                  />
                </div>
              </div>
            ) : null}

            <button
              type="button"
              data-testid="tts-record"
              onClick={phase === "recording" ? finishRecording : startRecording}
              disabled={phase === "recording" && !recordedEnough}
              className={`${outlinePill} mt-3 w-full`}
              style={{ borderColor: color.borderStrong, color: color.text }}
            >
              {phase === "recording" ? (
                <Square size={12} strokeWidth={ICON_STROKE} />
              ) : (
                <Mic size={14} strokeWidth={ICON_STROKE} />
              )}
              {phase === "recording"
                ? recordedEnough
                  ? "Stop recording"
                  : `Keep speaking (${formatClock(MIN_RECORDING_SECONDS - elapsedSeconds)} left)`
                : "Record my voice"}
            </button>
            {phase !== "recording" ? (
              <p
                className="mt-1.5 text-[11px] leading-snug"
                style={{ color: color.textFaint }}
              >
                Takes 1 to 2 minutes in a quiet room, speaking steadily at your
                normal pace. The clone copies exactly what it hears. You can
                listen back before anything is created.
              </p>
            ) : (
              <p
                className="mt-1.5 text-[11px] leading-snug"
                style={{ color: color.textFaint }}
              >
                If you finish the script early, read it again in the same tone.
              </p>
            )}
          </>
        )}
      </div>

      <div>
        <label
          htmlFor="tts-system-voice"
          className="mb-1.5 block text-[12px]"
          style={{ color: color.textMuted }}
        >
          Standard voice
        </label>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <AudioLines
              size={15}
              strokeWidth={ICON_STROKE}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#fafafa]/45"
            />
            <select
              id="tts-system-voice"
              value={selectedSystemVoiceUri || ""}
              onChange={(event) => onSystemVoiceChange?.(event.target.value || null)}
              disabled={!onSystemVoiceChange || !systemVoices.length}
              className="h-10 w-full cursor-pointer appearance-none rounded-xl border border-white/10 bg-white/[0.03] pl-9 pr-3 text-[13px] text-[#fafafa] transition-colors duration-[120ms] hover:bg-white/[0.05] focus:border-[#F95F4A]/60 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            >
              <option value="" className="bg-[#18181b]">Automatic</option>
              {systemVoices.map((voice) => (
                <option
                  key={voice.voiceURI}
                  value={voice.voiceURI}
                  className="bg-[#18181b]"
                >
                  {voice.name} · {voice.lang}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            data-testid="tts-system-preview"
            onClick={toggleSystemPreview}
            disabled={!systemVoices.length}
            aria-label={
              isSystemPreviewPlaying
                ? "Stop voice preview"
                : "Preview the standard voice"
            }
            title={isSystemPreviewPlaying ? "Stop preview" : "Preview this voice"}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-[#fafafa] transition-colors duration-[120ms] hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isSystemPreviewPlaying ? (
              <Square size={13} strokeWidth={ICON_STROKE} />
            ) : (
              <Play size={14} strokeWidth={ICON_STROKE} className="translate-x-[1px]" />
            )}
          </button>
        </div>
        <p
          className="mt-1 px-1 text-[11px] leading-snug"
          style={{ color: color.textFaint }}
        >
          You hear this for speakers without a personal voice.
        </p>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-[#F95F4A]/30 bg-[#F95F4A]/[0.14] px-3 py-2 text-[12px] leading-snug"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
