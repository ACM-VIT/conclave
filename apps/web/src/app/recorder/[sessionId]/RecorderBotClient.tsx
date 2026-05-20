"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  sessionId: string;
  roomId: string;
  token: string;
  width?: number;
  height?: number;
  fps?: number;
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
};

type Phase =
  | "validating"
  | "navigating"
  | "recording"
  | "stopping"
  | "completed"
  | "error";

const TIMESLICE_MS = 4_000;
const STATUS_POLL_MS = 5_000;

const log = (...args: unknown[]): void => {
  console.log("[recorder-bot]", ...args);
};

export default function RecorderBotClient({
  sessionId,
  roomId,
  token,
  width = 1920,
  height = 1080,
  fps = 30,
  videoBitrateKbps = 5_000,
  audioBitrateKbps = 128,
}: Props) {
  const [phase, setPhase] = useState<Phase>("validating");
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sequenceRef = useRef(0);
  const startedAtRef = useRef<number>(0);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!roomId || !token || !sessionId) {
      setError("Missing recorder credentials");
      setPhase("error");
      return;
    }

    let cancelled = false;

    const uploadChunk = async (blob: Blob): Promise<void> => {
      if (cancelled) return;
      const seq = sequenceRef.current;
      sequenceRef.current = seq + 1;
      const body = await blob.arrayBuffer();
      try {
        const response = await fetch(
          `/api/sfu/recorder/${encodeURIComponent(sessionId)}/chunk?seq=${seq}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "x-recorder-token": token,
              "x-recorder-sequence": String(seq),
            },
            body,
          },
        );
        if (!response.ok) {
          log("chunk upload failed", seq, await response.text());
        }
      } catch (err) {
        log("chunk upload error", seq, err);
      }
    };

    const stopRecording = async (
      reason: "host-stop" | "page-exit" | "error",
    ): Promise<void> => {
      if (phase === "completed" || phase === "stopping") return;
      setPhase("stopping");
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.requestData?.();
          await new Promise<void>((resolve) => {
            const r = mediaRecorderRef.current!;
            r.addEventListener("stop", () => resolve(), { once: true });
            try {
              r.stop();
            } catch {
              resolve();
            }
          });
        }
      } catch (err) {
        log("recorder stop error", err);
      }
      try {
        if (mediaStreamRef.current) {
          for (const track of mediaStreamRef.current.getTracks()) {
            track.stop();
          }
          mediaStreamRef.current = null;
        }
      } catch (err) {
        log("track stop error", err);
      }
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      try {
        const duration = Date.now() - startedAtRef.current;
        await fetch(
          `/api/sfu/recorder/${encodeURIComponent(sessionId)}/finalize`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-recorder-token": token,
            },
            body: JSON.stringify({
              durationMs: duration,
              reason,
              sequenceCount: sequenceRef.current,
            }),
          },
        );
      } catch (err) {
        log("finalize error", err);
      }
      setPhase("completed");
    };

    const startRecording = async (): Promise<void> => {
      setPhase("navigating");
      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: fps, width, height } as any,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48_000,
          } as any,
        });
        mediaStreamRef.current = displayStream;

        const tracksHaveAudio = displayStream.getAudioTracks().length > 0;
        const mimeCandidates = [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm",
        ];
        const mimeType = mimeCandidates.find((candidate) =>
          MediaRecorder.isTypeSupported(candidate),
        );
        if (!mimeType) {
          throw new Error("MediaRecorder has no compatible WebM codec");
        }

        const recorder = new MediaRecorder(displayStream, {
          mimeType,
          videoBitsPerSecond: videoBitrateKbps * 1_000,
          audioBitsPerSecond: audioBitrateKbps * 1_000,
        });
        mediaRecorderRef.current = recorder;
        startedAtRef.current = Date.now();

        recorder.addEventListener("dataavailable", (event) => {
          if (event.data && event.data.size > 0) {
            void uploadChunk(event.data);
          }
        });
        recorder.addEventListener("error", (event) => {
          log("recorder error", event);
          void stopRecording("error");
        });

        recorder.start(TIMESLICE_MS);
        log(
          `recording started (${displayStream.getVideoTracks().length} v, ${tracksHaveAudio ? displayStream.getAudioTracks().length : 0} a, mime=${mimeType})`,
        );
        setPhase("recording");

        pollingRef.current = setInterval(async () => {
          try {
            const response = await fetch(
              `/api/sfu/recorder/${encodeURIComponent(sessionId)}/status`,
              {
                headers: { "x-recorder-token": token },
                cache: "no-store",
              },
            );
            if (!response.ok) return;
            const data = (await response.json()) as { stopRequested?: boolean };
            if (data?.stopRequested) {
              await stopRecording("host-stop");
            }
          } catch (err) {
            log("status poll error", err);
          }
        }, STATUS_POLL_MS);
      } catch (err) {
        const message = (err as Error).message || "Recorder failed to start";
        log("startRecording failed", message);
        setError(message);
        setPhase("error");
        try {
          await fetch(
            `/api/sfu/recorder/${encodeURIComponent(sessionId)}/finalize`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-recorder-token": token,
              },
              body: JSON.stringify({
                durationMs: 0,
                reason: "error",
                errorMessage: message,
                sequenceCount: sequenceRef.current,
              }),
            },
          );
        } catch {
          // ignore
        }
      }
    };

    setPhase("navigating");
    const startTimer = setTimeout(() => void startRecording(), 1_000);

    const handleUnload = () => {
      navigator.sendBeacon?.(
        `/api/sfu/recorder/${encodeURIComponent(sessionId)}/finalize`,
        new Blob(
          [
            JSON.stringify({
              durationMs: Date.now() - startedAtRef.current,
              reason: "page-exit",
              sequenceCount: sequenceRef.current,
            }),
          ],
          { type: "application/json" },
        ),
      );
    };
    window.addEventListener("beforeunload", handleUnload);
    window.addEventListener("pagehide", handleUnload);

    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      window.removeEventListener("beforeunload", handleUnload);
      window.removeEventListener("pagehide", handleUnload);
      void stopRecording("page-exit");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, roomId, token]);

  const attendeeUrl = `/${encodeURIComponent(roomId)}?autojoin=1&hide=1&recorder=1&name=Recorder%20Bot`;

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        margin: 0,
        background: "#060606",
        color: "#FEFCD9",
        fontFamily: "monospace",
        position: "relative",
      }}
    >
      <iframe
        ref={iframeRef}
        src={attendeeUrl}
        allow="camera; microphone; display-capture; autoplay"
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          background: "#060606",
        }}
      />
      <div
        style={{
          position: "fixed",
          top: 6,
          left: 6,
          padding: "2px 6px",
          fontSize: 10,
          background: "rgba(0,0,0,0.6)",
          color: phase === "recording" ? "#3ddc84" : phase === "error" ? "#f95f4a" : "#FEFCD9",
          borderRadius: 4,
          pointerEvents: "none",
          zIndex: 9999,
        }}
      >
        bot · {phase}
        {error ? ` · ${error}` : ""}
      </div>
    </div>
  );
}
