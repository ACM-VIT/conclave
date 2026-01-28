import { useEffect } from "react";
import {
  ACTIVE_SPEAKER_HOLD_MS,
  SPEAKER_CHECK_INTERVAL_MS,
  SPEAKER_THRESHOLD,
} from "../constants";
import type { AudioAnalyserEntry, Participant } from "../types";

interface UseMeetAudioActivityOptions {
  participants: Map<string, Participant>;
  localStream: MediaStream | null;
  isMuted: boolean;
  userId: string;
  setActiveSpeakerId: React.Dispatch<React.SetStateAction<string | null>>;
  audioContextRef: React.MutableRefObject<AudioContext | null>;
  audioAnalyserMapRef: React.MutableRefObject<
    Map<string, AudioAnalyserEntry>
  >;
  lastActiveSpeakerRef: React.MutableRefObject<
    { id: string; ts: number } | null
  >;
}

export function useMeetAudioActivity({
  participants,
  localStream,
  isMuted,
  userId,
  setActiveSpeakerId,
  audioContextRef,
  audioAnalyserMapRef,
  lastActiveSpeakerRef,
}: UseMeetAudioActivityOptions) {
  useEffect(() => {
    const sources = new Map<string, MediaStream>();
    const localAudioTrack = localStream?.getAudioTracks()[0];

    if (
      localStream &&
      localAudioTrack &&
      localAudioTrack.enabled &&
      localAudioTrack.readyState === "live" &&
      !isMuted
    ) {
      sources.set(userId, localStream);
    }

    for (const participant of participants.values()) {
      if (!participant.audioStream || participant.isMuted) continue;
      const track = participant.audioStream.getAudioTracks()[0];
      if (!track || !track.enabled || track.readyState !== "live") continue;
      sources.set(participant.userId, participant.audioStream);
    }

    const analyserMap = audioAnalyserMapRef.current;

    for (const [id, entry] of analyserMap) {
      if (!sources.has(id)) {
        entry.source.disconnect();
        entry.analyser.disconnect();
        analyserMap.delete(id);
      }
    }

    if (!sources.size) {
      analyserMap.forEach((entry) => {
        entry.source.disconnect();
        entry.analyser.disconnect();
      });
      analyserMap.clear();
      lastActiveSpeakerRef.current = null;
      setActiveSpeakerId((prev) => (prev ? null : prev));
      return;
    }

    const AudioContextConstructor =
      globalThis.AudioContext ||
      (globalThis as typeof globalThis & {
        webkitAudioContext?: typeof AudioContext;
      }).webkitAudioContext;

    if (!AudioContextConstructor) {
      return;
    }

    const audioContext =
      audioContextRef.current || new AudioContextConstructor();
    audioContextRef.current = audioContext;

    if (audioContext.state === "suspended") {
      audioContext.resume().catch(() => {});
    }

    for (const [id, stream] of sources) {
      const streamId = stream.id;
      const existing = analyserMap.get(id);
      if (existing && existing.streamId === streamId) {
        continue;
      }

      if (existing) {
        existing.source.disconnect();
        existing.analyser.disconnect();
        analyserMap.delete(id);
      }

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);

      const data = new Uint8Array(analyser.fftSize);
      analyserMap.set(id, { analyser, data, source, streamId });
    }

    const interval = setInterval(() => {
      let loudestId: string | null = null;
      let maxLevel = SPEAKER_THRESHOLD;

      for (const [id, entry] of analyserMap) {
        entry.analyser.getByteTimeDomainData(entry.data);
        let sumSquares = 0;
        for (let i = 0; i < entry.data.length; i += 1) {
          const normalized = (entry.data[i] - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / entry.data.length);
        if (rms > maxLevel) {
          maxLevel = rms;
          loudestId = id;
        }
      }

      const now = Date.now();

      if (loudestId) {
        lastActiveSpeakerRef.current = { id: loudestId, ts: now };
        setActiveSpeakerId((prev) => (prev === loudestId ? prev : loudestId));
        return;
      }

      if (
        lastActiveSpeakerRef.current &&
        now - lastActiveSpeakerRef.current.ts < ACTIVE_SPEAKER_HOLD_MS
      ) {
        const lingeringId = lastActiveSpeakerRef.current.id;
        setActiveSpeakerId((prev) =>
          prev === lingeringId ? prev : lingeringId
        );
        return;
      }

      if (lastActiveSpeakerRef.current) {
        lastActiveSpeakerRef.current = null;
      }
      setActiveSpeakerId((prev) => (prev ? null : prev));
    }, SPEAKER_CHECK_INTERVAL_MS);

    return () => {
      clearInterval(interval);
    };
  }, [
    participants,
    localStream,
    isMuted,
    userId,
    setActiveSpeakerId,
    audioContextRef,
    audioAnalyserMapRef,
    lastActiveSpeakerRef,
  ]);

  useEffect(() => {
    return () => {
      audioAnalyserMapRef.current.forEach((entry) => {
        entry.source.disconnect();
        entry.analyser.disconnect();
      });
      audioAnalyserMapRef.current.clear();
      audioContextRef.current?.close().catch(() => {});
      audioContextRef.current = null;
    };
  }, [audioAnalyserMapRef, audioContextRef]);
}
