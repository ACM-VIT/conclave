"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  sessionId: string;
  roomId: string;
  token: string;
  captureSourceTag?: string;
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

/**
 * Capture audio from every <audio>/<video> element inside the same-origin
 * meeting iframe by routing each `srcObject` MediaStream into a single
 * WebAudio destination. Returns the mixed destination stream.
 *
 * Returns an empty MediaStream if the iframe never produces audio (e.g. a
 * silent meeting). The caller composites the result with the video track.
 */
const captureIframeAudio = async (
  iframe: HTMLIFrameElement | null,
  audioBitrateKbps: number,
): Promise<MediaStream> => {
  const audioContext = new AudioContext({ sampleRate: 48_000 });
  const destination = audioContext.createMediaStreamDestination();
  const tappedElements = new WeakSet<HTMLMediaElement>();

  const tap = (element: HTMLMediaElement): void => {
    if (tappedElements.has(element)) return;
    const stream = element.srcObject as MediaStream | null;
    if (!stream || stream.getAudioTracks().length === 0) return;
    try {
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(destination);
      tappedElements.add(element);
      log("tapped audio source", element.tagName.toLowerCase(), stream.id);
    } catch (err) {
      log("tap failed", err);
    }
  };

  const scan = (root: Document | null): void => {
    if (!root) return;
    const els = root.querySelectorAll<HTMLMediaElement>("audio, video");
    els.forEach(tap);
  };

  const setupObserver = (doc: Document | null): void => {
    if (!doc) return;
    scan(doc);
    const observer = new MutationObserver(() => scan(doc));
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
    });
  };

  // Wait for the iframe's contentDocument to become accessible. The iframe is
  // same-origin (both pages served from the same Next.js host), so this is
  // permitted by the browser.
  if (iframe) {
    const waitForDoc = (): Promise<Document | null> =>
      new Promise((resolve) => {
        let attempts = 0;
        const probe = () => {
          attempts += 1;
          const doc = iframe.contentDocument;
          if (doc && doc.readyState !== "loading") {
            resolve(doc);
            return;
          }
          if (attempts > 100) {
            resolve(iframe.contentDocument);
            return;
          }
          setTimeout(probe, 200);
        };
        probe();
      });
    const iframeDoc = await waitForDoc();
    setupObserver(iframeDoc);
  }

  // Also scan the top-level document — defensive for the case where the bot is
  // ever invoked without an iframe wrapper.
  setupObserver(document);

  // Resume the audio context (it starts suspended in some Chrome configs).
  if (audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch (err) {
      log("audio context resume failed", err);
    }
  }

  void audioBitrateKbps; // documentation: bitrate is enforced on MediaRecorder
  return destination.stream;
};

export default function RecorderBotClient({
  sessionId,
  roomId,
  token,
  captureSourceTag,
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
    // Set the page title to the capture-source tag so that Chrome's
    // --auto-select-desktop-capture-source flag picks THIS tab when
    // getDisplayMedia is invoked. Without a matching title the headless
    // capture picker silently fails.
    if (captureSourceTag && typeof document !== "undefined") {
      document.title = captureSourceTag;
    }
  }, [captureSourceTag]);

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
        // Headless Chrome has no system audio device, so getDisplayMedia
        // with audio:true fails with "Could not start audio source". Request
        // video-only here; audio is captured below via WebAudio by tapping
        // every <audio>/<video> in the (same-origin) meeting iframe.
        //
        // `displaySurface: 'browser'` biases the source picker toward tab
        // capture (vs window/screen). Combined with the launch-time flag
        // `--auto-select-tab-capture-source-by-title=<tag>`, Chrome picks
        // this tab automatically since we set `document.title` to <tag>.
        let displayStream: MediaStream;
        try {
          displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              displaySurface: "browser",
              frameRate: fps,
              width,
              height,
            } as any,
            audio: false,
            preferCurrentTab: true,
            selfBrowserSurface: "include",
            systemAudio: "exclude",
            surfaceSwitching: "exclude",
          } as DisplayMediaStreamOptions);
        } catch (err) {
          throw new Error(
            "getDisplayMedia(video-only) failed: " + (err as Error).message,
          );
        }

        const audioStream = await captureIframeAudio(
          iframeRef.current,
          audioBitrateKbps,
        );

        const combined = new MediaStream();
        for (const t of displayStream.getVideoTracks()) combined.addTrack(t);
        for (const t of audioStream.getAudioTracks()) combined.addTrack(t);
        mediaStreamRef.current = combined;

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

        const recorder = new MediaRecorder(combined, {
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
          `recording started (${combined.getVideoTracks().length} v, ${combined.getAudioTracks().length} a, mime=${mimeType})`,
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
