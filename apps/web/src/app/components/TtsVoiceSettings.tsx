"use client";

import {
  AudioWaveform,
  Check,
  LoaderCircle,
  Mic2,
  ShieldCheck,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { color } from "@conclave/ui-tokens";
import type {
  ClonedTtsVoice,
  TtsSystemVoiceOption,
} from "../hooks/useMeetTts";

const MIN_RECORDING_SECONDS = 10;
const MAX_RECORDING_SECONDS = 20;
const ICON_STROKE = 1.75;
const SAMPLE_SCRIPT =
  "Hi, this is my voice. I’m creating a personal voice for Conclave so my text-to-speech messages sound like me. The quick brown fox jumps over the lazy dog.";

type EnrollmentPhase = "idle" | "recording" | "uploading" | "deleting";

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
}: TtsVoiceSettingsProps) {
  const [phase, setPhase] = useState<EnrollmentPhase>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [hasConsent, setHasConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const intervalRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const clearTimers = useCallback(() => {
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    intervalRef.current = null;
    timeoutRef.current = null;
  }, []);

  const uploadRecording = useCallback(async (
    chunks: Blob[],
    mimeType: string,
    durationSeconds: number,
  ) => {
    if (durationSeconds < MIN_RECORDING_SECONDS) {
      setPhase("idle");
      setError(`Keep speaking for at least ${MIN_RECORDING_SECONDS} seconds.`);
      return;
    }
    setPhase("uploading");
    setError(null);
    const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
    const extension = mimeType.includes("mp4") ? "m4a" : "webm";
    const formData = new FormData();
    formData.append("audio", blob, `voice-sample.${extension}`);
    formData.append("durationSeconds", durationSeconds.toFixed(2));
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
      if (mountedRef.current) setPhase("idle");
    } catch (uploadError) {
      if (!mountedRef.current) return;
      setPhase("idle");
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Could not create your voice.",
      );
    }
  }, [onClonedVoiceChange, ownerName]);

  const finishRecording = useCallback(() => {
    clearTimers();
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    try {
      recorder.stop();
    } catch {
      recorderRef.current = null;
      setPhase("idle");
      setError("The recording could not be completed.");
    }
  }, [clearTimers]);

  const startRecording = useCallback(() => {
    setError(null);
    if (!hasConsent) {
      setError("Confirm that this is your voice before recording.");
      return;
    }
    const stream = getRecordingStream();
    if (!stream?.getAudioTracks().some((track) => track.readyState === "live")) {
      setError("Wait for the microphone test to start, then try again.");
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
      const duration = Math.min(
        MAX_RECORDING_SECONDS,
        (Date.now() - startedAtRef.current) / 1000,
      );
      void uploadRecording(chunksRef.current, recorder.mimeType || mimeType || "", duration);
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

    intervalRef.current = window.setInterval(() => {
      setElapsedSeconds(
        Math.min(MAX_RECORDING_SECONDS, (Date.now() - startedAtRef.current) / 1000),
      );
    }, 100);
    timeoutRef.current = window.setTimeout(finishRecording, MAX_RECORDING_SECONDS * 1000);
  }, [finishRecording, getRecordingStream, hasConsent, uploadRecording]);

  const deleteVoice = useCallback(async () => {
    if (!clonedVoice || phase !== "idle") return;
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
  }, [clonedVoice, onClonedVoiceClear, phase]);

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
    };
  }, [clearTimers]);

  const recordedEnough = elapsedSeconds >= MIN_RECORDING_SECONDS;
  const progress = Math.min(100, (elapsedSeconds / MAX_RECORDING_SECONDS) * 100);

  return (
    <div className="space-y-3">
      <div>
        <label
          htmlFor="tts-system-voice"
          className="mb-1.5 block text-[12px]"
          style={{ color: color.textMuted }}
        >
          Fallback voice you hear
        </label>
        <select
          id="tts-system-voice"
          value={selectedSystemVoiceUri || ""}
          onChange={(event) => onSystemVoiceChange?.(event.target.value || null)}
          disabled={!onSystemVoiceChange || !systemVoices.length}
          className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-[13px] text-[#fafafa] focus:border-[#F95F4A]/60 focus:outline-none disabled:opacity-50"
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

      <div
        className="overflow-hidden rounded-xl border"
        style={{ borderColor: color.borderStrong, backgroundColor: color.bgAlt }}
      >
        <div className="flex items-start gap-3 p-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#F95F4A]/30 bg-[#F95F4A]/10 text-[#F95F4A]">
            <AudioWaveform size={16} strokeWidth={ICON_STROKE} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13px] font-semibold">My message voice</p>
              {clonedVoice ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-[#32d583]">
                  <Check size={12} strokeWidth={2} /> Ready
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: color.textMuted }}>
              Your clone is used only when you send <code>/tts</code>. Other web
              participants hear it; unsupported clients use their system voice.
            </p>
          </div>
        </div>

        {clonedVoice ? (
          <div className="flex items-center justify-between gap-3 border-t border-white/10 px-3 py-2.5">
            <span className="min-w-0 truncate text-[12px]" style={{ color: color.textMuted }}>
              {clonedVoice.name}
            </span>
            <button
              type="button"
              onClick={() => void deleteVoice()}
              disabled={phase !== "idle"}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] text-[#f97066] transition-colors hover:bg-[#f97066]/10 disabled:opacity-50"
            >
              {phase === "deleting" ? (
                <LoaderCircle size={13} className="animate-spin" />
              ) : (
                <Trash2 size={13} strokeWidth={ICON_STROKE} />
              )}
              Delete
            </button>
          </div>
        ) : (
          <div className="border-t border-white/10 p-3">
            {!canCloneVoice ? (
              <p className="text-[12px] leading-relaxed" style={{ color: color.textMuted }}>
                Sign in with an email account to create and manage a voice clone.
              </p>
            ) : (
              <>
                <div className="rounded-lg border border-white/10 bg-black/15 p-2.5">
                  <p className="text-[10.5px] font-medium uppercase tracking-[0.08em]" style={{ color: color.textFaint }}>
                    Read this naturally
                  </p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-[#fafafa]/85">
                    {SAMPLE_SCRIPT}
                  </p>
                </div>

                {phase === "recording" ? (
                  <div className="mt-3">
                    <div className="mb-1.5 flex items-center justify-between text-[11.5px]">
                      <span className="inline-flex items-center gap-1.5 text-[#f97066]">
                        <span className="h-1.5 w-1.5 rounded-full bg-[#f97066] animate-pulse" />
                        Recording
                      </span>
                      <span className="tabular-nums" style={{ color: color.textMuted }}>
                        {elapsedSeconds.toFixed(1)} / {MAX_RECORDING_SECONDS}s
                      </span>
                    </div>
                    <div className="h-1 overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full bg-[#F95F4A] transition-[width] duration-100"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                ) : null}

                <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-[11.5px] leading-relaxed" style={{ color: color.textMuted }}>
                  <input
                    type="checkbox"
                    checked={hasConsent}
                    onChange={(event) => setHasConsent(event.target.checked)}
                    disabled={phase !== "idle"}
                    className="mt-0.5 h-3.5 w-3.5 accent-[#F95F4A]"
                  />
                  <span>
                    I confirm this is my voice, I consent to creating a clone, and
                    I understand meeting participants may hear it.
                  </span>
                </label>

                <button
                  type="button"
                  onClick={phase === "recording" ? finishRecording : startRecording}
                  disabled={
                    phase === "uploading" ||
                    phase === "deleting" ||
                    (phase === "recording" && !recordedEnough)
                  }
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#F95F4A] px-4 py-2 text-[12.5px] font-semibold text-white transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {phase === "uploading" ? (
                    <LoaderCircle size={14} className="animate-spin" />
                  ) : phase === "recording" ? (
                    <Square size={13} fill="currentColor" />
                  ) : (
                    <Mic2 size={15} strokeWidth={ICON_STROKE} />
                  )}
                  {phase === "uploading"
                    ? "Creating voice…"
                    : phase === "recording"
                      ? recordedEnough
                        ? "Stop and create voice"
                        : `Keep speaking · ${Math.ceil(MIN_RECORDING_SECONDS - elapsedSeconds)}s`
                      : "Record 10–20 seconds"}
                </button>

                <div className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-relaxed" style={{ color: color.textFaint }}>
                  <ShieldCheck size={13} strokeWidth={ICON_STROKE} className="mt-0.5 shrink-0" />
                  <span>
                    The sample is sent securely to the configured voice provider.
                    One to two minutes of clean audio gives better fidelity than a quick clone.
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {error ? (
        <div className="rounded-xl border border-[#f97066]/30 bg-[#f97066]/10 px-3 py-2 text-[11.5px] leading-relaxed text-[#fda29b]">
          {error}
        </div>
      ) : null}
    </div>
  );
}
