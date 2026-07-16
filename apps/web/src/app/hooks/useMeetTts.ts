"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clampMeetVolume, DEFAULT_MEET_VOLUME } from "../lib/meet-volume";

export interface TtsPayload {
  userId: string;
  displayName: string;
  text: string;
  ttsVoiceToken?: string;
  /** Chat message id, when the payload came from a chat message. */
  messageId?: string;
}

export interface TtsSystemVoiceOption {
  voiceURI: string;
  name: string;
  lang: string;
}

export interface ClonedTtsVoice {
  token: string;
  name: string;
}

const TTS_RATE = 0.94;
const TTS_PITCH = 1;
/** Queued messages beyond this are dropped oldest-first. */
const MAX_QUEUED_TTS = 6;
/** Gap between queued messages so back-to-back TTS doesn't run together. */
const QUEUE_ADVANCE_DELAY_MS = 250;
/** Give up on cloned-speech generation after this and use the system voice. */
const CLONED_GENERATION_TIMEOUT_MS = 15000;
/** Post-playback grace before the stuck-playback failsafe fires. */
const FAILSAFE_GRACE_MS = 8000;

/** Speech budget for playbacks whose real duration is unknown. */
const estimateSpeechMs = (text: string): number => {
  const words = text.split(/\s+/).filter(Boolean).length;
  // Whitespace-free scripts (CJK etc.) would count as one word, so also
  // budget by characters and take the larger of the two.
  const units = Math.max(words, Math.ceil(text.length / 6));
  return Math.min(90000, Math.max(FAILSAFE_GRACE_MS, units * 700 + 5000));
};
const VOICE_QUALITY_KEYWORDS = [
  "neural",
  "natural",
  "enhanced",
  "premium",
  "wavenet",
  "google",
  "microsoft",
  "siri",
];
const MOBILE_USER_AGENT = /android|iphone|ipad|ipod|mobile/i;
const SYSTEM_VOICE_STORAGE_KEY = "conclave:tts:system-voice";
const CLONED_VOICE_STORAGE_KEY = "conclave:tts:cloned-voice";

const readStoredValue = (key: string): string | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const readStoredClonedVoice = (): ClonedTtsVoice | null => {
  const stored = readStoredValue(CLONED_VOICE_STORAGE_KEY);
  if (!stored) return null;
  try {
    const value = JSON.parse(stored) as Partial<ClonedTtsVoice>;
    if (typeof value.token === "string" && typeof value.name === "string") {
      return { token: value.token, name: value.name };
    }
  } catch {}
  return null;
};

function getPreferredLanguage(): string {
  if (typeof navigator === "undefined") return "en-US";
  return navigator.language || "en-US";
}

function shouldGateSpeechUntilGesture(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    navigator.maxTouchPoints > 0 || MOBILE_USER_AGENT.test(navigator.userAgent)
  );
}

function isLanguageMatch(voiceLanguage: string, targetLanguage: string): boolean {
  const voiceLang = voiceLanguage.toLowerCase();
  const targetLang = targetLanguage.toLowerCase();
  if (voiceLang === targetLang) return true;
  const voiceBase = voiceLang.split("-")[0];
  const targetBase = targetLang.split("-")[0];
  return voiceBase === targetBase;
}

function scoreVoice(voice: SpeechSynthesisVoice, preferredLanguage: string): number {
  let score = 0;
  const voiceLang = voice.lang.toLowerCase();
  const preferred = preferredLanguage.toLowerCase();
  const voiceBase = voiceLang.split("-")[0];
  const preferredBase = preferred.split("-")[0];

  if (voiceLang === preferred) score += 80;
  else if (voiceBase === preferredBase) score += 45;
  else if (voiceBase === "en") score += 20;

  const voiceDescriptor = `${voice.name} ${voice.voiceURI}`.toLowerCase();
  if (VOICE_QUALITY_KEYWORDS.some((keyword) => voiceDescriptor.includes(keyword))) {
    score += 35;
  }
  if (voice.default) score += 5;

  return score;
}

function pickBestVoice(
  voices: SpeechSynthesisVoice[],
  preferredLanguage: string
): SpeechSynthesisVoice | null {
  if (!voices.length) return null;

  const matching = voices.filter((voice) =>
    isLanguageMatch(voice.lang, preferredLanguage)
  );
  const candidates = matching.length ? matching : voices;

  return [...candidates].sort(
    (left, right) =>
      scoreVoice(right, preferredLanguage) - scoreVoice(left, preferredLanguage)
  )[0] ?? null;
}

interface UseMeetTtsOptions {
  meetVolume?: number;
  audioOutputDeviceId?: string;
}

export function useMeetTts({
  meetVolume = DEFAULT_MEET_VOLUME,
  audioOutputDeviceId,
}: UseMeetTtsOptions = {}) {
  const [ttsSpeakerId, setTtsSpeakerId] = useState<string | null>(null);
  const [activeTtsMessageId, setActiveTtsMessageId] = useState<string | null>(
    null,
  );
  const [availableSystemVoices, setAvailableSystemVoices] = useState<
    TtsSystemVoiceOption[]
  >([]);
  const [selectedSystemVoiceUri, setSelectedSystemVoiceUriState] = useState<
    string | null
  >(() => readStoredValue(SYSTEM_VOICE_STORAGE_KEY));
  const [clonedVoice, setClonedVoiceState] = useState<ClonedTtsVoice | null>(
    readStoredClonedVoice,
  );
  const activeTokenRef = useRef<number | null>(null);
  const tokenCounterRef = useRef(0);
  const queueRef = useRef<TtsPayload[]>([]);
  const speakPayloadRef = useRef<(payload: TtsPayload) => void>(() => {});
  const failsafeTimeoutRef = useRef<number | null>(null);
  const advanceTimeoutRef = useRef<number | null>(null);
  const unlockTimeoutRef = useRef<number | null>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const clonedSpeechAbortRef = useRef<AbortController | null>(null);
  const clonedSpeechAudioRef = useRef<HTMLAudioElement | null>(null);
  const clonedSpeechUrlRef = useRef<string | null>(null);
  const isSpeechUnlockedRef = useRef(false);
  const shouldGateSpeechRef = useRef(false);
  const preferredLanguageRef = useRef<string>(getPreferredLanguage());
  const ttsVolume = clampMeetVolume(meetVolume);

  const stopClonedSpeech = useCallback(() => {
    clonedSpeechAbortRef.current?.abort();
    clonedSpeechAbortRef.current = null;
    const audio = clonedSpeechAudioRef.current;
    clonedSpeechAudioRef.current = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = "";
    }
    if (clonedSpeechUrlRef.current) {
      URL.revokeObjectURL(clonedSpeechUrlRef.current);
      clonedSpeechUrlRef.current = null;
    }
  }, []);

  const startNextInQueue = useCallback(() => {
    if (activeTokenRef.current !== null) return;
    const next = queueRef.current.shift();
    if (next) speakPayloadRef.current(next);
  }, []);

  /**
   * Single completion path for a playback attempt: clears the speaking
   * indicators and, after a short beat, plays the next queued message.
   * Safe to call multiple times — only the owning token wins.
   */
  const finishPlayback = useCallback((token: number) => {
    if (activeTokenRef.current !== token) return;
    activeTokenRef.current = null;
    setTtsSpeakerId(null);
    setActiveTtsMessageId(null);
    if (failsafeTimeoutRef.current !== null) {
      window.clearTimeout(failsafeTimeoutRef.current);
      failsafeTimeoutRef.current = null;
    }
    if (queueRef.current.length) {
      if (advanceTimeoutRef.current !== null) {
        window.clearTimeout(advanceTimeoutRef.current);
      }
      advanceTimeoutRef.current = window.setTimeout(() => {
        advanceTimeoutRef.current = null;
        startNextInQueue();
      }, QUEUE_ADVANCE_DELAY_MS);
    }
  }, [startNextInQueue]);

  const refreshPreferredVoice = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return;
    setAvailableSystemVoices(
      voices.map((voice) => ({
        voiceURI: voice.voiceURI,
        name: voice.name,
        lang: voice.lang,
      })),
    );
    voiceRef.current =
      voices.find((voice) => voice.voiceURI === selectedSystemVoiceUri) ??
      pickBestVoice(voices, preferredLanguageRef.current);
  }, [selectedSystemVoiceUri]);

  // The mount effect must not re-run when the selected voice changes (its
  // cleanup tears down live playback), so it reaches the latest refresher
  // through a ref while this effect applies selection changes immediately.
  const refreshPreferredVoiceRef = useRef(refreshPreferredVoice);
  useEffect(() => {
    refreshPreferredVoiceRef.current = refreshPreferredVoice;
    refreshPreferredVoice();
  }, [refreshPreferredVoice]);

  /**
   * Arms the stuck-playback failsafe for the active token. Real completion
   * comes from the utterance/audio end events; this only rescues playback
   * that never reports back so the queue cannot wedge.
   */
  const armFailsafe = useCallback((token: number, delayMs: number) => {
    if (failsafeTimeoutRef.current !== null) {
      window.clearTimeout(failsafeTimeoutRef.current);
    }
    failsafeTimeoutRef.current = window.setTimeout(() => {
      failsafeTimeoutRef.current = null;
      if (activeTokenRef.current !== token) return;
      stopClonedSpeech();
      finishPlayback(token);
    }, delayMs);
  }, [finishPlayback, stopClonedSpeech]);

  const setSelectedSystemVoiceUri = useCallback((voiceUri: string | null) => {
    const normalized = voiceUri?.trim() || null;
    setSelectedSystemVoiceUriState(normalized);
    try {
      if (normalized) {
        window.localStorage.setItem(SYSTEM_VOICE_STORAGE_KEY, normalized);
      } else {
        window.localStorage.removeItem(SYSTEM_VOICE_STORAGE_KEY);
      }
    } catch {}
  }, []);

  const saveClonedVoice = useCallback((voice: ClonedTtsVoice) => {
    setClonedVoiceState(voice);
    try {
      window.localStorage.setItem(CLONED_VOICE_STORAGE_KEY, JSON.stringify(voice));
    } catch {}
  }, []);

  const clearClonedVoice = useCallback(() => {
    setClonedVoiceState(null);
    try {
      window.localStorage.removeItem(CLONED_VOICE_STORAGE_KEY);
    } catch {}
  }, []);

  const speakWithSystemVoice = useCallback((
    payload: TtsPayload,
    token: number,
  ) => {
    if (activeTokenRef.current !== token) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      finishPlayback(token);
      return;
    }

    try {
      const synth = window.speechSynthesis;
      if (synth.speaking || synth.pending) synth.cancel();
      synth.resume();
      if (!voiceRef.current) refreshPreferredVoiceRef.current();
      armFailsafe(token, estimateSpeechMs(payload.text));

      const utterance = new SpeechSynthesisUtterance(payload.text.trim());
      utterance.rate = TTS_RATE;
      utterance.pitch = TTS_PITCH;
      utterance.volume = ttsVolume;
      const selectedVoice = voiceRef.current;
      if (selectedVoice) {
        utterance.voice = selectedVoice;
        utterance.lang = selectedVoice.lang;
      } else {
        utterance.lang = preferredLanguageRef.current;
      }
      utterance.onstart = () => {
        isSpeechUnlockedRef.current = true;
      };
      utterance.onend = () => finishPlayback(token);
      utterance.onerror = () => finishPlayback(token);
      synth.speak(utterance);
    } catch {
      finishPlayback(token);
    }
  }, [armFailsafe, finishPlayback, ttsVolume]);

  const speakWithClonedVoice = useCallback(async (
    payload: TtsPayload,
    token: number,
  ) => {
    const voiceToken = payload.ttsVoiceToken;
    if (!voiceToken) {
      speakWithSystemVoice(payload, token);
      return;
    }

    const controller = new AbortController();
    clonedSpeechAbortRef.current = controller;
    // Generation gets its own clock: a slow provider falls back to the system
    // voice instead of eating into (or being killed by) the playback failsafe.
    let generationTimedOut = false;
    const generationTimeout = window.setTimeout(() => {
      generationTimedOut = true;
      controller.abort();
    }, CLONED_GENERATION_TIMEOUT_MS);
    try {
      const response = await fetch("/api/tts/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: voiceToken, text: payload.text.trim() }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Cloned speech was unavailable.");
      const blob = await response.blob();
      window.clearTimeout(generationTimeout);
      if (activeTokenRef.current !== token || controller.signal.aborted) return;

      const url = URL.createObjectURL(blob);
      clonedSpeechUrlRef.current = url;
      const audio = new Audio(url);
      clonedSpeechAudioRef.current = audio;
      audio.volume = ttsVolume;
      const sinkCapable = audio as HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
      };
      if (audioOutputDeviceId && sinkCapable.setSinkId) {
        await sinkCapable.setSinkId(audioOutputDeviceId).catch(() => {});
      }
      if (activeTokenRef.current !== token || controller.signal.aborted) return;
      audio.onended = () => {
        stopClonedSpeech();
        finishPlayback(token);
      };
      audio.onerror = () => {
        stopClonedSpeech();
        speakWithSystemVoice(payload, token);
      };
      isSpeechUnlockedRef.current = true;
      await audio.play();
      const knownDurationMs =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000 + FAILSAFE_GRACE_MS
          : estimateSpeechMs(payload.text);
      armFailsafe(token, knownDurationMs);
    } catch {
      window.clearTimeout(generationTimeout);
      if (activeTokenRef.current !== token) return;
      // A user-initiated stop aborts too; only the generation timeout should
      // fall back to the system voice.
      if (controller.signal.aborted && !generationTimedOut) return;
      stopClonedSpeech();
      speakWithSystemVoice(payload, token);
    }
  }, [
    armFailsafe,
    audioOutputDeviceId,
    finishPlayback,
    speakWithSystemVoice,
    stopClonedSpeech,
    ttsVolume,
  ]);

  const speakPayload = useCallback((payload: TtsPayload) => {
    const text = payload.text?.trim();
    if (!text) return;

    const token = ++tokenCounterRef.current;
    activeTokenRef.current = token;
    setTtsSpeakerId(payload.userId);
    setActiveTtsMessageId(payload.messageId ?? null);
    stopClonedSpeech();

    if (failsafeTimeoutRef.current !== null) {
      window.clearTimeout(failsafeTimeoutRef.current);
      failsafeTimeoutRef.current = null;
    }
    // The cloned path arms its playback failsafe once audio actually starts
    // (generation has its own timeout); until then, guard the fetch window.
    if (payload.ttsVoiceToken) {
      armFailsafe(token, CLONED_GENERATION_TIMEOUT_MS + estimateSpeechMs(text));
      void speakWithClonedVoice(payload, token);
    } else {
      speakWithSystemVoice(payload, token);
    }
  }, [armFailsafe, speakWithClonedVoice, speakWithSystemVoice, stopClonedSpeech]);

  useEffect(() => {
    speakPayloadRef.current = speakPayload;
  }, [speakPayload]);

  const unlockSpeech = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    if (isSpeechUnlockedRef.current) {
      startNextInQueue();
      return;
    }

    try {
      const synth = window.speechSynthesis;
      const primer = new SpeechSynthesisUtterance(" ");
      primer.volume = 0;
      primer.rate = 1;
      primer.pitch = 1;
      primer.lang = preferredLanguageRef.current;
      primer.onend = () => {
        isSpeechUnlockedRef.current = true;
        startNextInQueue();
      };
      primer.onerror = () => {
        isSpeechUnlockedRef.current = true;
        startNextInQueue();
      };
      synth.speak(primer);

      if (unlockTimeoutRef.current) {
        window.clearTimeout(unlockTimeoutRef.current);
      }
      unlockTimeoutRef.current = window.setTimeout(() => {
        isSpeechUnlockedRef.current = true;
        startNextInQueue();
      }, 150);
    } catch {
      isSpeechUnlockedRef.current = true;
      startNextInQueue();
    }
  }, [startNextInQueue]);

  const handleTtsMessage = useCallback((payload: TtsPayload) => {
    if (!payload.text?.trim()) return;
    const mustQueue =
      activeTokenRef.current !== null ||
      // Messages already waiting keep their order even during the short
      // advance gap between playbacks.
      queueRef.current.length > 0 ||
      (shouldGateSpeechRef.current && !isSpeechUnlockedRef.current);
    if (mustQueue) {
      queueRef.current.push(payload);
      while (queueRef.current.length > MAX_QUEUED_TTS) {
        queueRef.current.shift();
      }
      return;
    }
    speakPayload(payload);
  }, [speakPayload]);

  /** Stops the current message (if any) and plays this payload right away. */
  const replayTts = useCallback((payload: TtsPayload) => {
    if (!payload.text?.trim()) return;
    // Replay always comes from a click, so speech is user-gesture unlocked.
    isSpeechUnlockedRef.current = true;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
    speakPayload(payload);
  }, [speakPayload]);

  /** Stops the current message and drops everything queued behind it. */
  const stopTts = useCallback(() => {
    queueRef.current = [];
    if (advanceTimeoutRef.current !== null) {
      window.clearTimeout(advanceTimeoutRef.current);
      advanceTimeoutRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
    stopClonedSpeech();
    const token = activeTokenRef.current;
    if (token !== null) finishPlayback(token);
  }, [finishPlayback, stopClonedSpeech]);

  // Mount-only lifecycle (all deps are stable callbacks): re-running this
  // effect would tear down live playback and leave the queue wedged.
  useEffect(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      const synth = window.speechSynthesis;
      const handleUserGesture = () => {
        unlockSpeech();
      };
      const handleVoicesChanged = () => refreshPreferredVoiceRef.current();

      shouldGateSpeechRef.current = shouldGateSpeechUntilGesture();
      isSpeechUnlockedRef.current = !shouldGateSpeechRef.current;
      refreshPreferredVoiceRef.current();
      synth.addEventListener("voiceschanged", handleVoicesChanged);
      if (shouldGateSpeechRef.current) {
        window.addEventListener("pointerdown", handleUserGesture);
        window.addEventListener("touchstart", handleUserGesture);
        window.addEventListener("keydown", handleUserGesture);
      }

      return () => {
        if (failsafeTimeoutRef.current !== null) {
          window.clearTimeout(failsafeTimeoutRef.current);
        }
        if (advanceTimeoutRef.current !== null) {
          window.clearTimeout(advanceTimeoutRef.current);
        }
        if (unlockTimeoutRef.current) {
          window.clearTimeout(unlockTimeoutRef.current);
        }
        window.removeEventListener("pointerdown", handleUserGesture);
        window.removeEventListener("touchstart", handleUserGesture);
        window.removeEventListener("keydown", handleUserGesture);
        synth.removeEventListener("voiceschanged", handleVoicesChanged);
        synth.cancel();
        stopClonedSpeech();
      };
    }

    return () => {
      if (failsafeTimeoutRef.current !== null) {
        window.clearTimeout(failsafeTimeoutRef.current);
      }
      if (advanceTimeoutRef.current !== null) {
        window.clearTimeout(advanceTimeoutRef.current);
      }
      if (unlockTimeoutRef.current) {
        window.clearTimeout(unlockTimeoutRef.current);
      }
      stopClonedSpeech();
    };
  }, [stopClonedSpeech, unlockSpeech]);

  return {
    ttsSpeakerId,
    activeTtsMessageId,
    handleTtsMessage,
    replayTts,
    stopTts,
    availableSystemVoices,
    selectedSystemVoiceUri,
    setSelectedSystemVoiceUri,
    clonedVoice,
    saveClonedVoice,
    clearClonedVoice,
    outgoingTtsVoiceToken: clonedVoice?.token,
  };
}
