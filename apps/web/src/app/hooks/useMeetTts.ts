"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface TtsPayload {
  userId: string;
  displayName: string;
  text: string;
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

function getPreferredLanguage(): string {
  if (typeof navigator === "undefined") return "en-US";
  return navigator.language || "en-US";
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

export function useMeetTts() {
  const [ttsSpeakerId, setTtsSpeakerId] = useState<string | null>(null);
  const activeTokenRef = useRef<number | null>(null);
  const fallbackTimeoutRef = useRef<number | null>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const preferredLanguageRef = useRef<string>(getPreferredLanguage());

  const clearHighlight = useCallback((token: number) => {
    if (activeTokenRef.current !== token) return;
    setTtsSpeakerId(null);
  }, []);

  const refreshPreferredVoice = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return;
    voiceRef.current = pickBestVoice(voices, preferredLanguageRef.current);
  }, []);

  const handleTtsMessage = useCallback((payload: TtsPayload) => {
    const text = payload.text?.trim();
    if (!text) return;

    const token = Date.now();
    activeTokenRef.current = token;
    setTtsSpeakerId(payload.userId);

    if (fallbackTimeoutRef.current) {
      window.clearTimeout(fallbackTimeoutRef.current);
    }

    const words = text.split(/\s+/).filter(Boolean).length;
    const estimatedMs = Math.min(15000, Math.max(2000, Math.ceil(words * 420)));
    fallbackTimeoutRef.current = window.setTimeout(() => {
      clearHighlight(token);
    }, estimatedMs);

    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }

    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      if (!voiceRef.current) {
        refreshPreferredVoice();
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = TTS_RATE;
      utterance.pitch = TTS_PITCH;
      const selectedVoice = voiceRef.current;
      if (selectedVoice) {
        utterance.voice = selectedVoice;
        utterance.lang = selectedVoice.lang;
      } else {
        utterance.lang = preferredLanguageRef.current;
      }
      utterance.onend = () => clearHighlight(token);
      utterance.onerror = () => clearHighlight(token);

      synth.speak(utterance);
    } catch (_err) {
      clearHighlight(token);
    }
  }, [clearHighlight, refreshPreferredVoice]);

  useEffect(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      const synth = window.speechSynthesis;
      refreshPreferredVoice();
      synth.addEventListener("voiceschanged", refreshPreferredVoice);

      return () => {
        if (fallbackTimeoutRef.current) {
          window.clearTimeout(fallbackTimeoutRef.current);
        }
        synth.removeEventListener("voiceschanged", refreshPreferredVoice);
        synth.cancel();
      };
    }

    return () => {
      if (fallbackTimeoutRef.current) {
        window.clearTimeout(fallbackTimeoutRef.current);
      }
    };
  }, [refreshPreferredVoice]);

  return { ttsSpeakerId, handleTtsMessage };
}
