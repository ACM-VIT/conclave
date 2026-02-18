import { useCallback, useEffect, useRef, useState } from "react";
import * as Speech from "expo-speech";

interface TtsPayload {
  userId: string;
  displayName: string;
  text: string;
}

const TTS_RATE = 0.94;
const TTS_PITCH = 1;
const VOICE_QUALITY_KEYWORDS = ["neural", "natural", "enhanced", "premium", "siri", "google"];

function getPreferredLanguage(): string {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    return locale || "en-US";
  } catch {
    return "en-US";
  }
}

function isLanguageMatch(voiceLanguage: string, targetLanguage: string): boolean {
  const voiceLang = voiceLanguage.toLowerCase();
  const targetLang = targetLanguage.toLowerCase();
  if (voiceLang === targetLang) return true;
  const voiceBase = voiceLang.split("-")[0];
  const targetBase = targetLang.split("-")[0];
  return voiceBase === targetBase;
}

function scoreVoice(voice: Speech.Voice, preferredLanguage: string): number {
  let score = 0;
  const voiceLang = voice.language.toLowerCase();
  const preferred = preferredLanguage.toLowerCase();
  const voiceBase = voiceLang.split("-")[0];
  const preferredBase = preferred.split("-")[0];

  if (voiceLang === preferred) score += 80;
  else if (voiceBase === preferredBase) score += 45;
  else if (voiceBase === "en") score += 20;

  if (voice.quality === Speech.VoiceQuality.Enhanced) score += 40;

  const descriptor = `${voice.name} ${voice.identifier}`.toLowerCase();
  if (VOICE_QUALITY_KEYWORDS.some((keyword) => descriptor.includes(keyword))) {
    score += 30;
  }

  return score;
}

function pickBestVoice(voices: Speech.Voice[], preferredLanguage: string): Speech.Voice | null {
  if (!voices.length) return null;
  const matching = voices.filter((voice) =>
    isLanguageMatch(voice.language, preferredLanguage)
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
  const fallbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceRef = useRef<Speech.Voice | null>(null);
  const preferredLanguageRef = useRef<string>(getPreferredLanguage());
  const isResolvingVoiceRef = useRef(false);

  const clearHighlight = useCallback((token: number) => {
    if (activeTokenRef.current !== token) return;
    setTtsSpeakerId(null);
  }, []);

  const refreshPreferredVoice = useCallback(async () => {
    if (isResolvingVoiceRef.current) return;
    isResolvingVoiceRef.current = true;

    try {
      const voices = await Speech.getAvailableVoicesAsync();
      voiceRef.current = pickBestVoice(voices, preferredLanguageRef.current);
    } catch {
      voiceRef.current = null;
    } finally {
      isResolvingVoiceRef.current = false;
    }
  }, []);

  const handleTtsMessage = useCallback(
    (payload: TtsPayload) => {
      const text = payload.text?.trim();
      if (!text) return;

      const token = Date.now();
      activeTokenRef.current = token;
      setTtsSpeakerId(payload.userId);

      if (fallbackTimeoutRef.current) {
        clearTimeout(fallbackTimeoutRef.current);
      }

      const words = text.split(/\s+/).filter(Boolean).length;
      const estimatedMs = Math.min(15000, Math.max(2000, Math.ceil(words * 420)));
      fallbackTimeoutRef.current = setTimeout(() => {
        clearHighlight(token);
      }, estimatedMs);

      try {
        Speech.stop();
        if (!voiceRef.current) {
          void refreshPreferredVoice();
        }
        Speech.speak(text, {
          rate: TTS_RATE,
          pitch: TTS_PITCH,
          language: voiceRef.current?.language ?? preferredLanguageRef.current,
          voice: voiceRef.current?.identifier,
          onDone: () => clearHighlight(token),
          onStopped: () => clearHighlight(token),
          onError: () => clearHighlight(token),
        });
      } catch (_err) {
        clearHighlight(token);
      }
    },
    [clearHighlight, refreshPreferredVoice]
  );

  useEffect(() => {
    void refreshPreferredVoice();

    return () => {
      if (fallbackTimeoutRef.current) {
        clearTimeout(fallbackTimeoutRef.current);
      }
      Speech.stop();
    };
  }, [refreshPreferredVoice]);

  return { ttsSpeakerId, handleTtsMessage };
}
