"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { color } from "@conclave/ui-tokens";
import { adminRequest } from "./adminApi";
import type { TranscriptSpectatorSegment, TranscriptSpectatorToken } from "./types";
import { Dot, Section, btnTiny } from "./ui";

const MAX_SEGMENTS = 400;

type SpectatorState = "idle" | "connecting" | "live" | "ended" | "error";

const formatClock = (at: number): string =>
  new Date(at).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });

const toWorkerWsUrl = (token: TranscriptSpectatorToken): string => {
  const base = token.workerUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/rooms/${encodeURIComponent(token.roomId)}/ws`);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  url.searchParams.set("token", token.token);
  return url.toString();
};

const upsertSegment = (
  previous: TranscriptSpectatorSegment[],
  segment: TranscriptSpectatorSegment,
): TranscriptSpectatorSegment[] => {
  const index = previous.findIndex((entry) => entry.itemId === segment.itemId);
  const next =
    index === -1
      ? [...previous, segment]
      : previous.map((entry, i) => (i === index ? segment : entry));
  next.sort((a, b) => a.sequence - b.sequence);
  if (next.length > MAX_SEGMENTS) next.splice(0, next.length - MAX_SEGMENTS);
  return next;
};

/**
 * Read-only live transcript for a room, straight from the transcription
 * worker: the SFU mints a spectator token (all capabilities off) and this
 * component only ever listens. Nothing about the meeting changes.
 */
export function TranscriptSpectator({
  roomId,
  clientId,
  instanceUrl,
}: {
  roomId: string;
  clientId: string;
  instanceUrl: string;
}) {
  const [state, setState] = useState<SpectatorState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSpectatorSegment[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const stop = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    setState("idle");
    setSegments([]);
    setSessionStatus(null);
    setError(null);
  }, []);

  useEffect(() => stop, [stop]);
  // A different room means a different session; never show stale lines.
  useEffect(() => {
    stop();
  }, [roomId, stop]);

  useEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [segments]);

  const start = useCallback(async () => {
    if (socketRef.current) return;
    setState("connecting");
    setError(null);
    try {
      const token = await adminRequest<TranscriptSpectatorToken>(
        `rooms/${encodeURIComponent(roomId)}/transcript-token`,
        { method: "GET", clientId, instanceUrl },
      );
      const socket = new WebSocket(toWorkerWsUrl(token));
      socketRef.current = socket;

      socket.onopen = () => setState("live");
      socket.onclose = () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
          setState((prev) => (prev === "live" ? "ended" : prev === "connecting" ? "error" : prev));
          setError((prev) => prev ?? "Transcript stream closed");
        }
      };
      socket.onerror = () => {
        setError("Could not reach the transcript worker");
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            session?: { status?: string };
            segments?: TranscriptSpectatorSegment[];
            segment?: TranscriptSpectatorSegment;
          };
          if (message.type === "snapshot") {
            setSessionStatus(message.session?.status ?? null);
            setSegments(
              Array.isArray(message.segments)
                ? message.segments.slice(-MAX_SEGMENTS)
                : [],
            );
          } else if (message.type === "session.state") {
            setSessionStatus(message.session?.status ?? null);
          } else if (message.type === "segment.final" && message.segment) {
            setSegments((prev) => upsertSegment(prev, message.segment!));
          }
        } catch {
          // Unknown frames (deltas, minutes, qa) are fine to skip: finalized
          // lines land via segment.final within a few seconds.
        }
      };
    } catch (err) {
      setState("error");
      setError((err as Error).message);
    }
  }, [clientId, instanceUrl, roomId]);

  return (
    <Section
      title="Transcript"
      action={
        state === "idle" ? (
          <button type="button" className={btnTiny} onClick={() => void start()}>
            Watch
          </button>
        ) : (
          <div className="flex items-center gap-2">
            {state === "live" ? (
              <span className="flex items-center gap-1.5 text-[11px]" style={{ color: color.success }}>
                <Dot tone={color.success} />
                {sessionStatus === "live" ? "transcribing" : (sessionStatus ?? "connected")}
              </span>
            ) : null}
            <button type="button" className={btnTiny} onClick={stop}>
              Stop
            </button>
          </div>
        )
      }
    >
      {state === "idle" ? (
        <p className="text-[12px]" style={{ color: color.textFaint }}>
          Watch the room's live transcript, read-only.
        </p>
      ) : state === "connecting" ? (
        <p className="text-[12px]" style={{ color: color.textFaint }}>
          Connecting
        </p>
      ) : error && segments.length === 0 ? (
        <p className="text-[12px]" style={{ color: color.danger }}>
          {error}
        </p>
      ) : segments.length === 0 ? (
        <p className="text-[12px]" style={{ color: color.textFaint }}>
          Connected. Nothing to show until someone speaks with transcription on.
        </p>
      ) : (
        <div
          ref={scrollRef}
          className="max-h-72 space-y-1.5 overflow-y-auto rounded-lg border p-3"
          style={{ borderColor: color.border, backgroundColor: color.surface }}
        >
          {segments.map((segment) => (
            <p key={segment.itemId} className="text-[12.5px] leading-relaxed [overflow-wrap:anywhere]">
              <span style={{ color: color.textFaint, fontVariantNumeric: "tabular-nums" }}>
                {formatClock(segment.updatedAt)}
              </span>{" "}
              <span className="font-medium" style={{ color: color.text }}>
                {segment.speakerDisplayName}
              </span>{" "}
              <span style={{ color: color.textMuted }}>{segment.text}</span>
            </p>
          ))}
        </div>
      )}
    </Section>
  );
}
