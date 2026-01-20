"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface TtsPayload {
  userId: string;
  displayName: string;
  text: string;
}

export function useMeetTts() {
  const [ttsSpeakerId, setTtsSpeakerId] = useState<string | null>(null);
  const activeTokenRef = useRef<number | null>(null);
  const fallbackTimeoutRef = useRef<number | null>(null);

  const clearHighlight = useCallback((token: number) => {
    if (activeTokenRef.current !== token) return;
    setTtsSpeakerId(null);
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

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.onend = () => clearHighlight(token);
      utterance.onerror = () => clearHighlight(token);

      synth.speak(utterance);
    } catch (_err) {
      clearHighlight(token);
    }
  }, [clearHighlight]);

  useEffect(() => {
    return () => {
      if (fallbackTimeoutRef.current) {
        window.clearTimeout(fallbackTimeoutRef.current);
      }
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  return { ttsSpeakerId, handleTtsMessage };
}
