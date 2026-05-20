"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AudioLines,
  Download,
  Film,
  Loader2,
  Monitor,
  RefreshCw,
  Video,
} from "lucide-react";
import {
  formatBytes,
  formatDuration,
  type RecordingSessionMetadata,
  type RecordingTrackArtifact,
} from "@/lib/recordings";

type Props = {
  webinarId: string;
  webinarTitle?: string;
};

const COMPOSITE_STATUS_TONE: Record<
  NonNullable<RecordingSessionMetadata["composite"]>["status"],
  string
> = {
  pending: "border-[#FEFCD9]/15 text-[#FEFCD9]/50",
  running: "border-amber-300/40 bg-amber-300/10 text-amber-200",
  completed: "border-emerald-300/40 bg-emerald-300/10 text-emerald-200",
  failed: "border-[#F95F4A]/40 bg-[#F95F4A]/10 text-[#F95F4A]",
};

const formatStartedAt = (timestamp: number): string =>
  new Date(timestamp).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const TrackIcon = ({ track }: { track: RecordingTrackArtifact }) => {
  if (track.trackKind === "audio") return <AudioLines className="h-3.5 w-3.5" />;
  if (track.trackKind === "screen") return <Monitor className="h-3.5 w-3.5" />;
  return <Video className="h-3.5 w-3.5" />;
};

const downloadHref = (
  webinarId: string,
  sessionId: string,
  filename: string,
): string =>
  `/api/webinars/scheduled/${encodeURIComponent(webinarId)}/recordings/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(filename)}`;

export default function WebinarRecordingsPanel({
  webinarId,
  webinarTitle,
}: Props) {
  const [recordings, setRecordings] = useState<RecordingSessionMetadata[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/webinars/scheduled/${encodeURIComponent(webinarId)}/recordings`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(
          data && typeof data === "object" && "error" in data
            ? String((data as { error?: string }).error || "Failed to load")
            : "Failed to load recordings",
        );
      }
      const data = (await response.json()) as {
        recordings?: RecordingSessionMetadata[];
      };
      setRecordings(data?.recordings ?? []);
    } catch (err) {
      setError((err as Error).message || "Failed to load");
      setRecordings([]);
    } finally {
      setIsLoading(false);
    }
  }, [webinarId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!webinarId) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-[#FEFCD9]/10 bg-black/30 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-medium text-[#FEFCD9]">
          <Film className="h-4 w-4 text-[#F95F4A]" />
          Recordings
          {webinarTitle ? (
            <span className="text-[#FEFCD9]/55 font-normal">
              · {webinarTitle}
            </span>
          ) : null}
        </h2>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex items-center gap-1 rounded-full border border-[#FEFCD9]/10 px-2.5 py-1 text-[10px] text-[#FEFCD9]/65 hover:border-[#FEFCD9]/25 hover:text-[#FEFCD9]"
          style={{ fontFamily: "'PolySans Mono', monospace" }}
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </div>

      {error ? (
        <p className="mb-3 text-[11px] text-[#F95F4A]">{error}</p>
      ) : null}

      {isLoading ? (
        <div className="flex items-center gap-2 py-4 text-xs text-[#FEFCD9]/50">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading…
        </div>
      ) : recordings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#FEFCD9]/10 bg-black/20 px-3 py-4 text-center text-[11px] text-[#FEFCD9]/45">
          No recordings yet. Start recording from the meeting console to capture
          a session.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {recordings.map((session) => {
            const totalDuration =
              (session.endedAt ?? Date.now()) - session.startedAt;
            const composite = session.composite;
            const viewTrack = session.tracks.find(
              (track) => track.producerUserId === "view-recorder",
            );
            const otherTracks = session.tracks.filter(
              (track) => track.producerUserId !== "view-recorder",
            );
            return (
              <div
                key={session.id}
                className="rounded-lg border border-[#FEFCD9]/10 bg-black/35 p-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.15em] text-[#FEFCD9]/45" style={{ fontFamily: "'PolySans Mono', monospace" }}>
                      {formatStartedAt(session.startedAt)} · {formatDuration(totalDuration)}
                    </p>
                    <p className="mt-0.5 text-[10px] text-[#FEFCD9]/40">
                      {session.tracks.length} track
                      {session.tracks.length === 1 ? "" : "s"} · started by{" "}
                      <span className="text-[#FEFCD9]/65">{session.startedBy}</span>
                      {session.status === "failed" && session.errorMessage ? (
                        <span className="ml-2 text-[#F95F4A]/80">
                          {session.errorMessage}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  {composite ? (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-[0.15em] ${COMPOSITE_STATUS_TONE[composite.status]}`}
                      style={{ fontFamily: "'PolySans Mono', monospace" }}
                    >
                      Composite · {composite.status}
                    </span>
                  ) : null}
                </div>

                {viewTrack && viewTrack.filename && viewTrack.status !== "failed" ? (
                  <a
                    href={downloadHref(webinarId, session.id, viewTrack.filename)}
                    className="mt-2 inline-flex items-center gap-2 rounded-md border border-[#F95F4A]/40 bg-[#F95F4A]/10 px-3 py-2 text-xs text-[#F95F4A] transition hover:border-[#F95F4A]/60 hover:bg-[#F95F4A]/20"
                  >
                    <Film className="h-3.5 w-3.5" />
                    Meeting recording · {formatBytes(viewTrack.byteSize)} · {formatDuration(viewTrack.durationMs)}
                    <Download className="h-3 w-3 ml-1" />
                  </a>
                ) : null}

                {composite?.status === "completed" && composite.filename ? (
                  <a
                    href={downloadHref(webinarId, session.id, composite.filename)}
                    className="mt-2 inline-flex items-center gap-1 rounded-md border border-emerald-300/40 bg-emerald-300/10 px-2.5 py-1 text-[11px] text-emerald-200 transition hover:border-emerald-300/60"
                  >
                    <Download className="h-3 w-3" />
                    Composite ({formatBytes(composite.byteSize)})
                  </a>
                ) : null}

                <ul className="mt-2 flex flex-col gap-1">
                  {otherTracks.map((track) => (
                    <li
                      key={track.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-[#FEFCD9]/10 bg-black/40 px-2 py-1.5"
                    >
                      <div className="flex items-center gap-2 text-[11px] text-[#FEFCD9]/80">
                        <TrackIcon track={track} />
                        <span className="truncate">
                          {track.displayName || track.producerUserId}
                        </span>
                        <span className="text-[#FEFCD9]/35">·</span>
                        <span className="text-[#FEFCD9]/50">
                          {track.codec || track.trackKind}
                        </span>
                        <span className="text-[#FEFCD9]/35">·</span>
                        <span className="text-[#FEFCD9]/50">
                          {formatDuration(track.durationMs)}
                        </span>
                        <span className="text-[#FEFCD9]/35">·</span>
                        <span className="text-[#FEFCD9]/50">
                          {formatBytes(track.byteSize)}
                        </span>
                        {track.status === "failed" ? (
                          <span className="rounded-full border border-[#F95F4A]/40 bg-[#F95F4A]/10 px-1.5 text-[9px] text-[#F95F4A]">
                            failed
                          </span>
                        ) : null}
                      </div>
                      {track.filename && track.status !== "failed" ? (
                        <a
                          href={downloadHref(
                            webinarId,
                            session.id,
                            track.filename,
                          )}
                          className="inline-flex items-center gap-1 rounded-md border border-[#FEFCD9]/10 px-2 py-0.5 text-[10px] text-[#FEFCD9]/65 hover:border-[#FEFCD9]/25 hover:text-[#FEFCD9]"
                        >
                          <Download className="h-3 w-3" />
                          Download
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
