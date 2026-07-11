import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactPlayer from "react-player";
import { useApps } from "../../../../sdk/hooks/useApps";
import { useAppDoc } from "../../../../sdk/hooks/useAppDoc";
import {
  advanceQueue,
  enqueue,
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

// Hide the floating controls after this much pointer idle while playing.
const CONTROLS_IDLE_MS = 2600;

/**
 * Watch together: synced YouTube playback on the Conclave apps SDK. Nobody
 * streams video to anyone. YouTube serves each participant directly and the
 * shared Yjs doc syncs intent only.
 *
 * The player is react-player v3 with native controls OFF and a click shield
 * over the iframe, so ALL playback intent flows through our custom UI, which
 * writes the doc first; the player follows declaratively. This removes the
 * whole class of native-control/echo bugs by construction.
 */
export function WatchWebApp() {
  const { user, isAdmin, isReadOnly: appReadOnly, setLocked } = useApps();
  const { doc, locked, awareness } = useAppDoc("watch");
  // Read-only when the app itself is read-only (observer) or the room is locked
  // and the user is not an admin. Playback still follows the doc either way.
  const isReadOnly = Boolean(appReadOnly) || (locked && !isAdmin);
  // Locked non-admins cannot edit, but they CAN ask: their picks become queue
  // requests the host approves. True observers get neither.
  const canRequest = !appReadOnly && locked && !isAdmin;

  const watchRequests = useWatchRequests({
    doc,
    awareness,
    self: { id: user?.id ?? null, name: user?.name ?? null },
  });

  const { videoId, videoTitle, queue } = useWatchDocState(doc);

  // YouTube reports a growing finite duration for active broadcasts, so the
  // player cannot identify live content from duration alone. Keep metadata
  // keyed to its video to ensure a slow response never labels the next item.
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
      // Once a status is known to be transient, keep checking through an
      // occasional failed request. An initial unavailable proxy still falls
      // back to the iframe without starting a pointless polling loop.
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
  });

  // Start a video: play immediately when idle, append to the queue otherwise.
  // Playback starts instantly with no title; the title backfills into the doc
  // a moment later (best effort, guarded so a slow fetch cannot mislabel).
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
          void fetchVideoTitle(nextVideoId).then((title) => {
            if (title) setVideoTitle(doc, nextVideoId, title);
          });
        }
        return;
      }
      const item = enqueue(
        doc,
        { videoId: nextVideoId, title: knownTitle ?? null },
        { userId: user?.id ?? null, userName: user?.name ?? null },
      );
      if (!knownTitle) {
        void fetchVideoTitle(nextVideoId).then((title) => {
          if (title) setQueueItemTitle(doc, item.id, title);
        });
      }
    },
    [doc, isReadOnly, user?.id, user?.name],
  );

  // The empty-state browse surface always starts playback (it only renders
  // when idle).
  const handleStart = useCallback(
    (nextVideoId: string, knownTitle?: string | null) => {
      if (isReadOnly) return;
      // Guard against a race where a video appeared between render and submit.
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
        void fetchVideoTitle(nextVideoId).then((title) => {
          if (title) setVideoTitle(doc, nextVideoId, title);
        });
      }
    },
    [doc, handleAdd, isReadOnly],
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
        void fetchVideoTitle(item.videoId).then((title) => {
          if (title) setVideoTitle(doc, item.videoId, title);
        });
      }
    },
    [doc, isReadOnly, queue],
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

  // The queue rail collapses to give the video the whole app; a chip brings it
  // back. A local preference, never synced, and it doubles as theater view.
  const [railOpen, setRailOpen] = useState(true);
  const handleToggleRail = useCallback(() => {
    setRailOpen((prev) => !prev);
  }, []);

  // Personal browse mode over the running video: playback (and audio) carry on
  // underneath while you shop trending or search for the queue.
  const [browsing, setBrowsing] = useState(false);
  const handleBrowsePick = useCallback(
    (pickedId: string, pickedTitle?: string | null) => {
      if (appReadOnly) return;
      if (canRequest) {
        watchRequests.submitRequest(pickedId, pickedTitle);
        // Close so the requester lands on their pending row in the rail.
        setBrowsing(false);
        setRailOpen(true);
        return;
      }
      // Editors stay in browse to add several in a row; items appear in the
      // rail as they land.
      handleAdd(pickedId, pickedTitle);
    },
    [appReadOnly, canRequest, handleAdd, watchRequests],
  );

  const acceptRequest = useCallback(
    (request: WatchRequest) => {
      // With co-hosts, two admins can race on the same request; the first
      // resolution wins and later clicks become no-ops instead of duplicates.
      if (getWatchRequestResolution(doc, request.id)) return;
      resolveWatchRequest(doc, request.id, "added");
      const item = enqueue(
        doc,
        { videoId: request.videoId, title: request.title },
        { userId: request.byId, userName: request.byName },
      );
      if (!request.title) {
        void fetchVideoTitle(request.videoId).then((title) => {
          if (title) setQueueItemTitle(doc, item.id, title);
        });
      }
    },
    [doc],
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
  // A video that ended into an EMPTY queue parks paused at its final frame,
  // and the ENDED event that normally advances has already fired. So when
  // something lands in the queue afterwards (an add, another client, an
  // accepted request), any client with edit rights advances; advanceQueue's
  // compare-and-swap lets exactly one writer win across the room.
  const videoOver =
    hasVideo &&
    !player.isLive &&
    !isPlaying &&
    player.duration > 0 &&
    player.currentTime >= player.duration - 1.5;
  useEffect(() => {
    if (isReadOnly || !videoOver || queue.length === 0 || !videoId) return;
    advanceQueue(doc, videoId);
  }, [doc, isReadOnly, queue.length, videoId, videoOver]);

  const endedIdle = videoOver && queue.length === 0;

  // Pending queue requests, shown to everyone; the host gets the verdict
  // buttons, the requester gets a cancel, and a decline leaves a short note.
  const requestsSection =
    watchRequests.requests.length > 0 || watchRequests.declined ? (
      <div className="border-b border-white/[0.06] px-3 pb-2.5">
        {watchRequests.requests.length > 0 ? (
          <p className="pb-1.5 text-[11px] font-medium text-[#a1a1aa]">
            Requests
          </p>
        ) : null}
        <ul className="flex flex-col gap-1">
          {watchRequests.requests.map((request) => {
            const mine = watchRequests.myRequest?.id === request.id;
            return (
              <li
                key={request.id}
                className="flex items-center gap-2 rounded-lg border border-white/[0.06] px-2 py-1.5"
                style={{ backgroundColor: "#101014" }}
              >
                <div
                  className="h-8 w-14 shrink-0 overflow-hidden rounded border border-white/[0.06]"
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
                  <p className="truncate text-[11.5px] font-medium text-[#e4e4e7]">
                    {request.title ?? request.videoId}
                  </p>
                  <p className="mt-0.5 truncate text-[10px] text-[#71717a]">
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
                      className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-white transition-opacity hover:opacity-90"
                      style={{ backgroundColor: "#22A578" }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => declineRequest(request)}
                      aria-label="Decline request"
                      title="Decline"
                      className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border border-white/10 text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
                    className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#71717a] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                ) : (
                  <span className="shrink-0 text-[10px] text-[#71717a]">
                    Pending
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {watchRequests.declined ? (
          <p className="pt-1.5 text-[11px] text-[#71717a]">
            Your request was declined
          </p>
        ) : null}
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
      headerAccessory={
        <>
          {!appReadOnly ? (
            <button
              type="button"
              onClick={() => setBrowsing((prev) => !prev)}
              aria-label={browsing ? "Back to video" : "Browse videos"}
              aria-pressed={browsing}
              title={browsing ? "Back to video" : "Browse videos"}
              className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors ${
                browsing
                  ? "bg-white/[0.1] text-[#fafafa]"
                  : "text-[#71717a] hover:bg-white/[0.06] hover:text-[#fafafa]"
              }`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
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

  // Floating controls visibility: always there while paused, prompting, or
  // errored; while playing they fade after a short pointer idle and any pointer
  // movement brings them back. A single opacity transition, no loops.
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
    // In mini form the whole tile is the "go back" affordance.
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
      {/* Player column */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className="relative min-h-0 flex-1 overflow-hidden bg-black"
          onPointerMove={pokeControls}
          onPointerDown={pokeControls}
        >
          {hasVideo ? (
            /* Hard clipping container: the youtube-video custom element sizes
               itself by its intrinsic 16:9 ratio when left in normal flow,
               overflowing the stage. Pinning it inside an absolute box and
               forcing block 100% sizing keeps the video exactly in its frame.
               While browsing, this same box shrinks into a floating mini
               player (the ONE iframe simply moves), so playback stays visible
               and tapping it returns to the full view. */
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
              {/* Click shield: the iframe never receives input, so the hidden
                  native UI can never inject intent. A stage tap only reveals
                  controls; shared play/pause requires the explicit button. */}
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

          {/* The video finished with nothing queued: offer the way back to
              browsing without hunting for the rail button. */}
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
                Browse more videos
              </button>
            </div>
          ) : null}

          {/* Personal browse mode: an opaque layer over the (still running)
              player. Your playback keeps going; you are just shopping. */}
          {hasVideo && browsing ? (
            <div
              className="absolute inset-0 z-30 flex flex-col"
              style={{ backgroundColor: "#0d0d10" }}
            >
              <div className="flex shrink-0 items-center justify-between px-4 pt-3">
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
                {canRequest ? (
                  <span className="text-[11px] text-[#71717a]">
                    Picks are sent to the host to approve
                  </span>
                ) : null}
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

          {/* The queue rail handle: a slim tab at the vertical center of the
              stage's right edge, pointing the way it will move the rail. */}
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

          {/* Floating custom controls: the only playback UI there is. */}
          {hasVideo ? (
            <div
              className={`absolute bottom-5 left-1/2 z-10 w-[min(34rem,calc(100%-1.5rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-white/10 transition-opacity duration-200 ${
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
                <div className="flex items-center gap-1.5 border-t border-white/[0.06] px-3 py-1.5 text-[11px] text-[#8b8b93]">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  Host has locked controls
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* Queue column, only once something is playing. On narrow layouts it
          sits under the player with a capped height; on wide layouts it is a
          fixed side rail. Collapsing animates the width (or height) shut while
          the fixed-width inner keeps the content from reflowing mid-slide. */}
      {hasVideo ? (
        <aside
          className={`flex min-h-0 shrink-0 flex-col overflow-hidden border-white/10 transition-all duration-300 ease-out lg:max-h-none ${
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
