"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clampMeetVolume, DEFAULT_MEET_VOLUME } from "../lib/meet-volume";

interface TtsPayload {
  userId: string;
  displayName: string;
  text: string;
  ttsVoiceToken?: string;
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
  const fallbackTimeoutRef = useRef<number | null>(null);
  const unlockTimeoutRef = useRef<number | null>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const pendingPayloadRef = useRef<TtsPayload | null>(null);
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

  const clearHighlight = useCallback((token: number) => {
    if (activeTokenRef.current !== token) return;
    setTtsSpeakerId(null);
  }, []);

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
      return;
    }

    try {
      const synth = window.speechSynthesis;
      if (synth.speaking || synth.pending) synth.cancel();
      synth.resume();
      if (!voiceRef.current) refreshPreferredVoice();

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
      utterance.onend = () => clearHighlight(token);
      utterance.onerror = () => clearHighlight(token);
      synth.speak(utterance);
    } catch {
      clearHighlight(token);
    }
  }, [clearHighlight, refreshPreferredVoice, ttsVolume]);

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
    try {
      const response = await fetch("/api/tts/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: voiceToken, text: payload.text.trim() }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Cloned speech was unavailable.");
      const blob = await response.blob();
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
      audio.onended = () => {
        stopClonedSpeech();
        clearHighlight(token);
      };
      audio.onerror = () => {
        stopClonedSpeech();
        speakWithSystemVoice(payload, token);
      };
      isSpeechUnlockedRef.current = true;
      await audio.play();
    } catch {
      if (controller.signal.aborted || activeTokenRef.current !== token) return;
      stopClonedSpeech();
      speakWithSystemVoice(payload, token);
    }
  }, [
    audioOutputDeviceId,
    clearHighlight,
    speakWithSystemVoice,
    stopClonedSpeech,
    ttsVolume,
  ]);

  const speakPayload = useCallback((payload: TtsPayload) => {
    const text = payload.text?.trim();
    if (!text) return;

    const token = Date.now();
    activeTokenRef.current = token;
    setTtsSpeakerId(payload.userId);
    stopClonedSpeech();

    if (fallbackTimeoutRef.current) {
      window.clearTimeout(fallbackTimeoutRef.current);
    }

    const words = text.split(/\s+/).filter(Boolean).length;
    const estimatedMs = Math.min(15000, Math.max(2000, Math.ceil(words * 420)));
    fallbackTimeoutRef.current = window.setTimeout(() => {
      clearHighlight(token);
    }, estimatedMs);

    if (payload.ttsVoiceToken) {
      void speakWithClonedVoice(payload, token);
    } else {
      speakWithSystemVoice(payload, token);
    }
  }, [clearHighlight, speakWithClonedVoice, speakWithSystemVoice, stopClonedSpeech]);

  const flushPendingPayload = useCallback(() => {
    const pendingPayload = pendingPayloadRef.current;
    if (!pendingPayload) return;
    pendingPayloadRef.current = null;
    speakPayload(pendingPayload);
  }, [speakPayload]);

  const unlockSpeech = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    if (isSpeechUnlockedRef.current) {
      flushPendingPayload();
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
        flushPendingPayload();
      };
      primer.onerror = () => {
        isSpeechUnlockedRef.current = true;
        flushPendingPayload();
      };
      synth.speak(primer);

      if (unlockTimeoutRef.current) {
        window.clearTimeout(unlockTimeoutRef.current);
      }
      unlockTimeoutRef.current = window.setTimeout(() => {
        isSpeechUnlockedRef.current = true;
        flushPendingPayload();
      }, 150);
    } catch {
      isSpeechUnlockedRef.current = true;
      flushPendingPayload();
    }
  }, [flushPendingPayload]);

  const handleTtsMessage = useCallback((payload: TtsPayload) => {
    if (shouldGateSpeechRef.current && !isSpeechUnlockedRef.current) {
      pendingPayloadRef.current = payload;
      return;
    }
    speakPayload(payload);
  }, [speakPayload]);

  useEffect(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      const synth = window.speechSynthesis;
      const handleUserGesture = () => {
        unlockSpeech();
      };

      shouldGateSpeechRef.current = shouldGateSpeechUntilGesture();
      isSpeechUnlockedRef.current = !shouldGateSpeechRef.current;
      refreshPreferredVoice();
      synth.addEventListener("voiceschanged", refreshPreferredVoice);
      if (shouldGateSpeechRef.current) {
        window.addEventListener("pointerdown", handleUserGesture);
        window.addEventListener("touchstart", handleUserGesture);
        window.addEventListener("keydown", handleUserGesture);
      }

      return () => {
        if (fallbackTimeoutRef.current) {
          window.clearTimeout(fallbackTimeoutRef.current);
        }
        if (unlockTimeoutRef.current) {
          window.clearTimeout(unlockTimeoutRef.current);
        }
        window.removeEventListener("pointerdown", handleUserGesture);
        window.removeEventListener("touchstart", handleUserGesture);
        window.removeEventListener("keydown", handleUserGesture);
        synth.removeEventListener("voiceschanged", refreshPreferredVoice);
        synth.cancel();
        stopClonedSpeech();
      };
    }

    return () => {
      if (fallbackTimeoutRef.current) {
        window.clearTimeout(fallbackTimeoutRef.current);
      }
      if (unlockTimeoutRef.current) {
        window.clearTimeout(unlockTimeoutRef.current);
      }
      stopClonedSpeech();
    };
  }, [refreshPreferredVoice, stopClonedSpeech, unlockSpeech]);

  return {
    ttsSpeakerId,
    handleTtsMessage,
    availableSystemVoices,
    selectedSystemVoiceUri,
    setSelectedSystemVoiceUri,
    clonedVoice,
    saveClonedVoice,
    clearClonedVoice,
    outgoingTtsVoiceToken: clonedVoice?.token,
  };
}
