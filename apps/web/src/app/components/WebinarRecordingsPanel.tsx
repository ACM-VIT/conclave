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
  pending: "bg-[#FEFCD9]/10 text-[#FEFCD9]/55",
  running: "bg-amber-300/15 text-amber-200",
  completed: "bg-emerald-300/15 text-emerald-200",
  failed: "bg-[#F95F4A]/15 text-[#F95F4A]",
};

const formatStartedAt = (timestamp: number): string =>
  new Date(timestamp).toLocaleString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const TrackIcon = ({ track }: { track: RecordingTrackArtifact }) => {
  if (track.trackKind === "audio")
    return <AudioLines className="h-4 w-4" />;
  if (track.trackKind === "screen")
    return <Monitor className="h-4 w-4" />;
  return <Video className="h-4 w-4" />;
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

  if (!webinarId) return null;

  return (
    <section className="rounded-2xl border border-[#FEFCD9]/10 bg-black/30 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#F95F4A]/15 text-[#F95F4A]">
            <Film className="h-4 w-4" />
          </span>
          <div>
            <h3
              className="text-xl text-[#FEFCD9] tracking-tight"
              style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
            >
              recordings
            </h3>
            {webinarTitle && (
              <p className="text-xs text-[#FEFCD9]/55 mt-0.5">
                for {webinarTitle}
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex items-center gap-1.5 text-sm text-[#FEFCD9]/55 hover:text-[#FEFCD9] transition-colors"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-[#F95F4A]/30 bg-[#F95F4A]/5 px-4 py-2.5 text-sm text-[#F95F4A]">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="mt-6 flex items-center gap-3 text-sm text-[#FEFCD9]/45">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : recordings.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-[#FEFCD9]/15 bg-black/20 px-6 py-10 text-center">
          <p className="text-sm text-[#FEFCD9]/55">
            No recordings yet. Start one from the meeting controls when you're
            ready to capture a session.
          </p>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-4">
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
              <article
                key={session.id}
                className="rounded-xl border border-[#FEFCD9]/10 bg-black/30 p-5"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <p className="text-sm text-[#FEFCD9]/80">
                      {formatStartedAt(session.startedAt)}
                    </p>
                    <p className="mt-0.5 text-xs text-[#FEFCD9]/45">
                      {formatDuration(totalDuration)} · {session.tracks.length}{" "}
                      track{session.tracks.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  {composite && (
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ${COMPOSITE_STATUS_TONE[composite.status]}`}
                    >
                      Composite · {composite.status}
                    </span>
                  )}
                </div>

                {session.status === "failed" && session.errorMessage && (
                  <p className="mt-2 text-xs text-[#F95F4A]/85">
                    {session.errorMessage}
                  </p>
                )}

                {viewTrack && viewTrack.filename && viewTrack.status !== "failed" && (
                  <a
                    href={downloadHref(webinarId, session.id, viewTrack.filename)}
                    target="_blank"
                    rel="noopener noreferrer"
                    download={viewTrack.filename}
                    className="mt-4 inline-flex items-center gap-2.5 rounded-lg bg-[#F95F4A] px-4 py-2.5 text-sm text-white transition-all hover:bg-[#e8553f]"
                  >
                    <Film className="h-4 w-4" />
                    Download the recording
                    <span className="text-xs text-white/70">
                      · {formatBytes(viewTrack.byteSize)} ·{" "}
                      {formatDuration(viewTrack.durationMs)}
                    </span>
                    <Download className="h-3.5 w-3.5" />
                  </a>
                )}

                {composite?.status === "completed" && composite.filename && (
                  <a
                    href={downloadHref(webinarId, session.id, composite.filename)}
                    target="_blank"
                    rel="noopener noreferrer"
                    download={composite.filename}
                    className="mt-2 inline-flex items-center gap-2 rounded-lg border border-emerald-300/35 bg-emerald-300/5 px-3 py-1.5 text-sm text-emerald-200 transition-colors hover:border-emerald-300/55"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Composite ({formatBytes(composite.byteSize)})
                  </a>
                )}

                {otherTracks.length > 0 && (
                  <details className="mt-4 group">
                    <summary className="cursor-pointer list-none text-xs text-[#FEFCD9]/50 transition-colors hover:text-[#FEFCD9]/75">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block transition-transform group-open:rotate-90">
                          ›
                        </span>
                        Per-track sources ({otherTracks.length})
                      </span>
                    </summary>
                    <ul className="mt-3 flex flex-col gap-1.5">
                      {otherTracks.map((track) => (
                        <li
                          key={track.id}
                          className="flex items-center justify-between gap-3 rounded-lg border border-[#FEFCD9]/10 bg-black/30 px-3 py-2"
                        >
                          <div className="flex min-w-0 items-center gap-2 text-sm text-[#FEFCD9]/75">
                            <TrackIcon track={track} />
                            <span className="truncate">
                              {track.displayName || track.producerUserId}
                            </span>
                            <span className="text-xs text-[#FEFCD9]/40">
                              {track.codec || track.trackKind} ·{" "}
                              {formatDuration(track.durationMs)} ·{" "}
                              {formatBytes(track.byteSize)}
                            </span>
                            {track.status === "failed" && (
                              <span className="rounded-full bg-[#F95F4A]/15 px-2 text-xs text-[#F95F4A]">
                                failed
                              </span>
                            )}
                          </div>
                          {track.filename && track.status !== "failed" && (
                            <a
                              href={downloadHref(
                                webinarId,
                                session.id,
                                track.filename,
                              )}
                              target="_blank"
                              rel="noopener noreferrer"
                              download={track.filename}
                              className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-[#FEFCD9]/55 hover:text-[#FEFCD9]"
                            >
                              <Download className="h-3 w-3" />
                              Download
                            </a>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
