import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactPlayer from "react-player";
import type * as Y from "yjs";
import { useApps } from "../../../../sdk/hooks/useApps";
import { useAppDoc } from "../../../../sdk/hooks/useAppDoc";
import {
  enqueue,
  getPlayback,
  getVideoId,
  getWatchRequestResolution,
  moveQueueItem,
  playQueueItemNow,
  removeQueueItem,
  resolveWatchRequest,
  setQueueItemTitle,
  setVideo,
  setVideoTitle,
} from "../../core/doc/index";
import { useSyncedPlayback } from "../hooks/useSyncedPlayback";
import { useWatchDocState } from "../hooks/useWatchDocState";
import {
  useWatchRequests,
  type WatchRequest,
} from "../hooks/useWatchRequests";
import {
  fetchVideoMetadata,
  fetchVideoTitle,
  liveHintForMetadata,
  thumbnailUrl,
  type WatchVideoMetadata,
} from "../youtubeMeta";
import { GestureOverlay } from "./GestureOverlay";
import { HostPill } from "./HostPill";
import { WatchControls } from "./WatchControls";
import { WatchEmptyState } from "./WatchEmptyState";
import { WatchQueue } from "./WatchQueue";

const CONTROLS_IDLE_MS = 2600;

export function WatchWebApp() {
  const { user, isAdmin, isReadOnly: appReadOnly, setLocked, documents } = useApps();
  const { doc, locked, awareness } = useAppDoc("watch");
  const writeOnce = useCallback(
    (key: string, write: (live: Y.Doc) => void) => documents.writeOnce("watch", key, write),
    [documents],
  );
  const saveVideoTitleWhenKnown = useCallback(
    (videoId: string) => {
      const key = `video-title:${videoId}:${getPlayback(doc).updatedAt}`;
      void fetchVideoTitle(videoId).then((title) => {
        if (title) writeOnce(key, (live) => setVideoTitle(live, videoId, title));
      });
    },
    [doc, writeOnce],
  );
  const saveItemTitleWhenKnown = useCallback(
    (itemId: string, videoId: string) => {
      void fetchVideoTitle(videoId).then((title) => {
        if (title) writeOnce(`item-title:${itemId}`, (live) => setQueueItemTitle(live, itemId, title));
      });
    },
    [writeOnce],
  );
  const isReadOnly = Boolean(appReadOnly) || (locked && !isAdmin);
  const canRequest = !appReadOnly && locked && !isAdmin;

  const watchRequests = useWatchRequests({
    doc,
    awareness,
    self: { id: user?.id ?? null, name: user?.name ?? null },
  });

  const { videoId, videoTitle, queue } = useWatchDocState(doc);

  const [videoMetadata, setVideoMetadata] =
    useState<WatchVideoMetadata | null>(null);
  useEffect(() => {
    if (!videoId) {
      setVideoMetadata(null);
      return;
    }
    let cancelled = false;
    let revalidateTimer: ReturnType<typeof setTimeout> | null = null;
    let nextRevalidateAfterMs: number | null = null;
    setVideoMetadata(null);

    const refreshMetadata = async () => {
      const metadata = await fetchVideoMetadata(videoId);
      if (cancelled) return;
      if (metadata?.videoId === videoId) {
        setVideoMetadata(metadata);
        nextRevalidateAfterMs = metadata.revalidateAfterMs;
      }
      if (nextRevalidateAfterMs !== null) {
        revalidateTimer = setTimeout(() => {
          void refreshMetadata();
        }, nextRevalidateAfterMs);
      }
    };

    void refreshMetadata();
    return () => {
      cancelled = true;
      if (revalidateTimer) clearTimeout(revalidateTimer);
    };
  }, [videoId]);
  const liveHint = liveHintForMetadata(
    videoMetadata?.videoId === videoId ? videoMetadata : null,
  );

  const player = useSyncedPlayback({
    doc,
    videoId,
    readOnly: isReadOnly,
    liveHint,
    writeOnce,
  });

  const handleAdd = useCallback(
    (nextVideoId: string, knownTitle?: string | null) => {
      if (isReadOnly) return;
      const current = getVideoId(doc);
      if (!current) {
        setVideo(doc, nextVideoId, {
          play: true,
          positionSeconds: 0,
          title: knownTitle ?? null,
        });
        if (!knownTitle) {
          saveVideoTitleWhenKnown(nextVideoId);
        }
        return;
      }
      const item = enqueue(
        doc,
        { videoId: nextVideoId, title: knownTitle ?? null },
        { userId: user?.id ?? null, userName: user?.name ?? null },
      );
      if (!knownTitle) {
        saveItemTitleWhenKnown(item.id, nextVideoId);
      }
    },
    [doc, isReadOnly, user?.id, user?.name, saveVideoTitleWhenKnown, saveItemTitleWhenKnown],
  );

  const handleStart = useCallback(
    (nextVideoId: string, knownTitle?: string | null) => {
      if (isReadOnly) return;
      if (getVideoId(doc)) {
        handleAdd(nextVideoId, knownTitle);
        return;
      }
      setVideo(doc, nextVideoId, {
        play: true,
        positionSeconds: 0,
        title: knownTitle ?? null,
      });
      if (!knownTitle) {
        saveVideoTitleWhenKnown(nextVideoId);
      }
    },
    [doc, handleAdd, isReadOnly, saveVideoTitleWhenKnown],
  );

  const handleRemove = useCallback(
    (itemId: string) => {
      if (isReadOnly) return;
      removeQueueItem(doc, itemId);
    },
    [doc, isReadOnly],
  );

  const handlePlayNow = useCallback(
    (itemId: string) => {
      if (isReadOnly) return;
      const item = queue.find((entry) => entry.id === itemId);
      playQueueItemNow(doc, itemId);
      if (item && !item.title) {
        saveVideoTitleWhenKnown(item.videoId);
      }
    },
    [doc, isReadOnly, queue, saveVideoTitleWhenKnown],
  );

  const handleMove = useCallback(
    (itemId: string, direction: -1 | 1) => {
      if (isReadOnly) return;
      moveQueueItem(doc, itemId, direction);
    },
    [doc, isReadOnly],
  );

  const handleSetLocked = useCallback(
    (nextLocked: boolean) => {
      void setLocked(nextLocked);
    },
    [setLocked],
  );

  const [railOpen, setRailOpen] = useState(true);
  const handleToggleRail = useCallback(() => {
    setRailOpen((prev) => !prev);
  }, []);

  const [browsing, setBrowsing] = useState(false);
  const handleBrowsePick = useCallback(
    (pickedId: string, pickedTitle?: string | null) => {
      if (appReadOnly) return;
      if (canRequest) {
        watchRequests.submitRequest(pickedId, pickedTitle);
        setBrowsing(false);
        setRailOpen(true);
        return;
      }
      handleAdd(pickedId, pickedTitle);
    },
    [appReadOnly, canRequest, handleAdd, watchRequests],
  );

  const acceptRequest = useCallback(
    (request: WatchRequest) => {
      if (getWatchRequestResolution(doc, request.id)) return;
      const item = doc.transact(() => {
        resolveWatchRequest(doc, request.id, "added");
        return enqueue(
          doc,
          { videoId: request.videoId, title: request.title },
          { userId: request.byId, userName: request.byName },
        );
      });
      if (!request.title) {
        saveItemTitleWhenKnown(item.id, request.videoId);
      }
    },
    [doc, saveItemTitleWhenKnown],
  );

  const declineRequest = useCallback(
    (request: WatchRequest) => {
      if (getWatchRequestResolution(doc, request.id)) return;
      resolveWatchRequest(doc, request.id, "declined");
    },
    [doc],
  );

  const hasVideo = Boolean(videoId);
  const isPlaying = player.playbackState === "playing";
  const videoOver =
    hasVideo &&
    !player.isLive &&
    !isPlaying &&
    player.duration > 0 &&
    player.currentTime >= player.duration - 1.5;
  const finishPlay = player.onEnded;
  useEffect(() => {
    if (isReadOnly || !videoOver || queue.length === 0 || !videoId) return;
    finishPlay();
  }, [finishPlay, isReadOnly, queue.length, videoId, videoOver]);

  const endedIdle = videoOver && queue.length === 0;

  const requestsSection =
    watchRequests.requests.length > 0 || watchRequests.declined ? (
      <div className="border-b border-white/[0.06] px-3 py-2.5">
        {watchRequests.requests.length > 0 ? (
          <div className="flex items-center gap-1.5 pb-2">
            <h3 className="text-[12px] font-medium text-[#fafafa]">Requests</h3>
            <span className="rounded-full border border-white/10 px-1.5 py-0.5 text-[10.5px] tabular-nums text-[#a1a1aa]">
              {watchRequests.requests.length}
            </span>
          </div>
        ) : null}
        <ul className="flex flex-col gap-1">
          {watchRequests.requests.map((request) => {
            const mine = watchRequests.myRequest?.id === request.id;
            return (
              <li
                key={request.id}
                className="flex items-center gap-2.5 rounded-lg border border-white/[0.06] py-1.5 pl-1.5 pr-1"
                style={{ backgroundColor: "#101014" }}
              >
                <div
                  className="h-9 w-16 shrink-0 overflow-hidden rounded-md border border-white/[0.06]"
                  style={{ backgroundColor: "#0a0a0b" }}
                >
                  <img
                    src={thumbnailUrl(request.videoId)}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                    draggable={false}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p
                    className="text-[12px] font-medium leading-snug text-[#e4e4e7]"
                    style={{
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {request.title ?? request.videoId}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-[#71717a]">
                    {mine ? "Your request" : (request.byName ?? "Someone")}
                  </p>
                </div>
                {isAdmin && !appReadOnly ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => acceptRequest(request)}
                      aria-label="Add to queue"
                      title="Add to queue"
                      className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-white transition-opacity hover:opacity-90"
                      style={{ backgroundColor: "#F95F4A" }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => declineRequest(request)}
                      aria-label="Decline request"
                      title="Decline"
                      className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-white/10 text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ) : mine ? (
                  <button
                    type="button"
                    onClick={watchRequests.cancelRequest}
                    aria-label="Cancel request"
                    title="Cancel request"
                    className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                ) : (
                  <span className="shrink-0 pr-1.5 text-[11px] text-[#71717a]">
                    Waiting
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {watchRequests.declined ? (
          <p className="pt-1.5 text-[12px] text-[#a1a1aa]" role="status">
            The host declined your request.
          </p>
        ) : null}
      </div>
    ) : null;

  const requestSection = canRequest ? (
    <div>
      <button
        type="button"
        onClick={() => setBrowsing(true)}
        className="flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-white/10 text-[12.5px] font-medium text-[#fafafa] transition-colors hover:bg-white/[0.06]"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        {watchRequests.myRequest ? "Request a different video" : "Request a video"}
      </button>
      <p className="mt-1.5 text-[11px] text-[#71717a]">
        {watchRequests.myRequest
          ? "Your request is waiting for the host."
          : "The host approves requests."}
      </p>
    </div>
  ) : null;

  const railContent = (
    <WatchQueue
      items={queue}
      nowPlaying={videoId ? { videoId, title: videoTitle } : null}
      readOnly={isReadOnly}
      onAdd={handleAdd}
      onRemove={handleRemove}
      onPlayNow={handlePlayNow}
      onMove={handleMove}
      requestsSection={requestsSection}
      addSection={requestSection}
      headerAccessory={
        <>
          {!appReadOnly && !canRequest ? (
            <button
              type="button"
              onClick={() => setBrowsing((prev) => !prev)}
              aria-pressed={browsing}
              title={browsing ? "Back to video" : "Browse videos"}
              className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-medium transition-colors ${
                browsing
                  ? "bg-white/[0.1] text-[#fafafa]"
                  : "text-[#a1a1aa] hover:bg-white/[0.06] hover:text-[#fafafa]"
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
              Browse
            </button>
          ) : null}
          <HostPill
            locked={locked}
            isAdmin={Boolean(isAdmin)}
            onSetLocked={handleSetLocked}
          />
        </>
      }
    />
  );

  const [pointerFresh, setPointerFresh] = useState(true);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pokeControls = useCallback(() => {
    setPointerFresh(true);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      setPointerFresh(false);
    }, CONTROLS_IDLE_MS);
  }, []);
  useEffect(() => {
    pokeControls();
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [pokeControls, isPlaying]);
  const controlsVisible =
    pointerFresh ||
    !isPlaying ||
    player.gestureNeed !== "none" ||
    Boolean(player.error);

  const handleShieldClick = useCallback(() => {
    if (browsing) {
      setBrowsing(false);
      return;
    }
    pokeControls();
  }, [browsing, pokeControls]);

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden lg:flex-row"
      style={{
        backgroundColor: "#0d0d10",
        fontFamily: "'PolySans Trial', sans-serif",
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className="relative min-h-0 flex-1 overflow-hidden bg-black"
          onPointerMove={pokeControls}
          onPointerDown={pokeControls}
        >
          {hasVideo ? (
            <div
              className={
                browsing
                  ? "group/mini absolute bottom-4 right-4 z-40 aspect-video w-64 overflow-hidden rounded-xl border border-white/10 shadow-[0_16px_48px_rgba(0,0,0,0.5)] md:w-72"
                  : "absolute inset-0 overflow-hidden"
              }
            >
              <ReactPlayer
                ref={player.attachPlayer}
                src={`https://www.youtube.com/watch?v=${videoId}`}
                playing={player.playing}
                muted={player.mutedProp}
                volume={player.volumeProp}
                playbackRate={player.rate}
                controls={false}
                playsInline
                width="100%"
                height="100%"
                style={{
                  display: "block",
                  width: "100%",
                  height: "100%",
                  backgroundColor: "#000",
                }}
                onReady={player.onReady}
                onTimeUpdate={player.onTimeUpdate}
                onDurationChange={player.onDurationChange}
                onPlaying={player.onPlaying}
                onEnded={player.onEnded}
                onError={player.onError}
                fallback={
                  <div
                    className="absolute inset-0"
                    style={{ backgroundColor: "#000" }}
                  />
                }
              />
              <button
                type="button"
                aria-label={browsing ? "Back to video" : "Show playback controls"}
                onClick={handleShieldClick}
                className="absolute inset-0 m-0 cursor-default border-0 p-0"
                style={{ backgroundColor: "transparent" }}
              />
              {browsing ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border border-white/10 opacity-0 transition-opacity group-hover/mini:opacity-100"
                  style={{ backgroundColor: "rgba(10, 10, 11, 0.85)" }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fafafa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 3 21 3 21 9" />
                    <polyline points="9 21 3 21 3 15" />
                    <line x1="21" y1="3" x2="14" y2="10" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                </span>
              ) : null}
            </div>
          ) : null}

          {!hasVideo ? (
            <div className="absolute inset-0" style={{ backgroundColor: "#0d0d10" }}>
              <WatchEmptyState onStart={handleStart} readOnly={isReadOnly} />
            </div>
          ) : null}

          {hasVideo && player.error ? (
            <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-4">
              <div
                className="rounded-full border border-white/10 px-3.5 py-2 text-[12.5px] font-medium text-[#fafafa]"
                style={{ backgroundColor: "rgba(10, 10, 11, 0.85)" }}
                role="status"
              >
                {player.error}
              </div>
            </div>
          ) : null}

          {hasVideo ? (
            <GestureOverlay
              need={player.gestureNeed}
              onResolve={player.resolveGesture}
              title={videoTitle}
            />
          ) : null}

          {endedIdle && !browsing && !appReadOnly ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center">
              <button
                type="button"
                onClick={() => setBrowsing(true)}
                className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/10 px-4 text-[13px] font-medium text-[#fafafa] transition-colors hover:bg-white/[0.06]"
                style={{
                  backgroundColor: "rgba(10, 10, 11, 0.85)",
                  backdropFilter: "blur(8px)",
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#F95F4A" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                Find another video
              </button>
            </div>
          ) : null}

          {hasVideo && browsing ? (
            <div
              className="absolute inset-0 z-30 flex flex-col"
              style={{ backgroundColor: "#0d0d10" }}
            >
              <div className="flex shrink-0 items-center px-4 pt-3">
                <button
                  type="button"
                  onClick={() => setBrowsing(false)}
                  className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-white/10 px-3 text-[12px] font-medium text-[#fafafa] transition-colors hover:bg-white/[0.06]"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  Back to video
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <WatchEmptyState
                  mode={canRequest ? "request" : "add"}
                  readOnly={false}
                  onStart={handleBrowsePick}
                />
              </div>
            </div>
          ) : null}

          {hasVideo && !browsing ? (
            <button
              type="button"
              onClick={handleToggleRail}
              aria-label={railOpen ? "Hide the queue" : "Show the queue"}
              title={railOpen ? "Hide the queue" : "Show the queue"}
              className="absolute right-0 top-1/2 z-20 flex h-14 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-l-lg border border-r-0 border-white/10 text-[#71717a] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
              style={{
                backgroundColor: "rgba(10, 10, 11, 0.85)",
                backdropFilter: "blur(8px)",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {railOpen ? (
                  <polyline points="9 18 15 12 9 6" />
                ) : (
                  <polyline points="15 18 9 12 15 6" />
                )}
              </svg>
            </button>
          ) : null}

          {hasVideo ? (
            <div
              className={`absolute bottom-5 left-1/2 z-10 w-[min(34rem,calc(100%-1.5rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-white/10 transition-opacity duration-[120ms] ${
                controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
              }`}
              style={{
                backgroundColor: "rgba(10, 10, 11, 0.88)",
                backdropFilter: "blur(8px)",
              }}
            >
              <WatchControls
                playbackState={player.playbackState}
                currentTime={player.currentTime}
                duration={player.duration}
                isLive={player.isLive}
                isAtLiveEdge={player.isAtLiveEdge}
                muted={player.muted}
                volume={player.volume}
                readOnly={isReadOnly}
                cinema={!railOpen}
                onToggleCinema={() => {
                  handleToggleRail();
                  pokeControls();
                }}
                captionsAvailable={player.captionsAvailable}
                captionsOn={player.captionsOn}
                captionTracks={player.captionTracks}
                captionSizeAvailable={player.captionSizeAvailable}
                captionFontSize={player.captionFontSize}
                onSetCaptionTrack={(language) => {
                  player.setCaptionTrack(language);
                  pokeControls();
                }}
                onSetCaptionFontSize={(size) => {
                  player.setCaptionFontSize(size);
                  pokeControls();
                }}
                onPlay={player.play}
                onPause={player.pause}
                onSeek={player.seek}
                onGoLive={player.goLive}
                onToggleMute={player.toggleMute}
                onVolumeChange={player.setVolume}
              />
              {isReadOnly ? (
                <div className="flex items-center gap-1.5 border-t border-white/[0.06] px-3 py-1.5 text-[11.5px] text-[#a1a1aa]">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  Only the host can play, pause or seek. Volume and captions are yours.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {hasVideo ? (
        <aside
          className={`flex min-h-0 shrink-0 flex-col overflow-hidden border-white/10 transition-[max-height,width,border-top-width,border-left-width] duration-[120ms] ease-out lg:max-h-none ${
            railOpen
              ? "max-h-[38%] border-t lg:w-72 lg:border-l lg:border-t-0"
              : "max-h-0 lg:w-0"
          }`}
          style={{ backgroundColor: "#0f0f13" }}
          aria-hidden={!railOpen}
        >
          <div className="flex h-full min-h-0 w-full flex-col lg:w-72">
            {railContent}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
