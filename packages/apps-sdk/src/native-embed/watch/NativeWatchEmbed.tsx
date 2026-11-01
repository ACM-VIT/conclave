// The Watch Together renderer for the native app host (S60 13 c, ACT-8): the embedded YouTube player with its own
// playback controls (seek, live, volume, captions), following the room's playback record in the SDK `watch` doc.
// Search, Play Now, Up Next, Requests and Everyone Can Control are native (the card's Queue button opens the
// Activities Watch page) and reach this page as bridge commands; the page answers each with an `ack` after the status
// that shows the change, and adds the page data to every status under `app`. The doc syncs intent only: every
// participant's own player fetches the media from YouTube. The player follows the doc; a person allowed to control
// playback writes their play, pause and seek to the doc (the room app lock decides, as on web), and anyone else's
// local change is pulled back to the room's position. The video title is announced natively. Flat only.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import {
  advanceQueue,
  enqueue,
  expectedPosition,
  getPlayback,
  getVideoId,
  getWatchRequestResolution,
  moveQueueItem,
  playQueueItemNow,
  removeQueueItem,
  resolveWatchRequest,
  setVideo,
  writePlayback as writePlaybackDoc,
} from "../../apps/watch/core/doc/index";
import { useWatchDocState } from "../../apps/watch/web/hooks/useWatchDocState";
import { useWatchRequests } from "../../apps/watch/web/hooks/useWatchRequests";
import { planPlaybackCorrection } from "../../apps/watch/web/playbackSync";
import {
  APP_EDIT_COMMANDS,
  WATCH_LIMITS,
  isValidIdentifier,
  isValidVideoId,
  type Envelope,
  type NativeToEmbedType,
} from "../protocol";
import {
  payloadNumber,
  payloadString,
  type CommandResult,
  type HostStatus,
  type NativeEmbedSession,
  type WatchAppStatus,
} from "../session";
import { PLAYER_STATE, YouTubeFrameController, youtubeEmbedUrl, type PlayerEvent } from "./youtubeFrame";

const EDIT_COMMANDS: ReadonlySet<string> = new Set<string>(APP_EDIT_COMMANDS);
const FOLLOW_INTERVAL_MS = 500;
/** Our own play, pause, seek or load echo back as player events for a moment; they are not a person's intent. */
const PROGRAMMATIC_WINDOW_MS = 1500;
/** While the record has not changed, never hard-seek more often than this (the web's CORRECTION_COOLDOWN_MS). */
const CORRECTION_COOLDOWN_MS = 2500;
/** Asking a blocked player to play again is cheap but noisy; at most this often. */
const PLAY_RETRY_MS = 2000;
/** A jump in the player's own clock larger than this between two reports is a seek. */
const USER_SEEK_SECONDS = 3;

const useHostStatus = (session: NativeEmbedSession): HostStatus =>
  useSyncExternalStore(
    useCallback((listener: () => void) => session.subscribe(listener), [session]),
    () => session.hostStatus,
  );

const useSynced = (session: NativeEmbedSession): boolean =>
  useSyncExternalStore(
    useCallback((listener: () => void) => session.subscribe(listener), [session]),
    () => session.isSynced,
  );

/** The room's playback state as a primitive (a stable snapshot for useSyncExternalStore). */
const usePlaybackState = (doc: Y.Doc): "playing" | "paused" =>
  useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        doc.on("update", listener);
        return () => doc.off("update", listener);
      },
      [doc],
    ),
    () => getPlayback(doc).state,
  );

const clip = (value: string | null | undefined, limit: number): string => (value ?? "").slice(0, limit);

const recordKey = (doc: Y.Doc): string => {
  const record = getPlayback(doc);
  return `${record.state}|${record.positionSeconds}|${record.updatedAt}|${record.rate}|${getVideoId(doc) ?? ""}`;
};

export function NativeWatchEmbed({ session }: { session: NativeEmbedSession }) {
  const { doc, awareness } = session;
  const host = useHostStatus(session);
  const synced = useSynced(session);
  const readOnly = host.readOnly;
  const { videoId, videoTitle, queue } = useWatchDocState(doc);
  const playbackState = usePlaybackState(doc);
  const watchRequests = useWatchRequests({
    doc,
    awareness,
    self: { id: host.userId || null, name: host.userName || null },
  });

  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const syncedRef = useRef(synced);
  syncedRef.current = synced;
  const programmaticUntil = useRef(0);
  const lastCorrectionAt = useRef(0);
  const lastPlayAskAt = useRef(0);
  const lastRecordKey = useRef("");
  const loadedVideoId = useRef<string | null>(null);
  const lastReport = useRef<{ time: number; at: number }>({ time: 0, at: 0 });
  const followRef = useRef<() => void>(() => {});
  const playerEventRef = useRef<(event: PlayerEvent) => void>(() => {});

  const controller = useMemo(() => new YouTubeFrameController((event) => playerEventRef.current(event)), []);
  useEffect(() => () => controller.dispose(), [controller]);

  // The frame is created once when a video first shows (its URL carries that video and the room's position); later
  // videos switch through the player, never a reload. Idle removes it.
  const [frame, setFrame] = useState<{ videoId: string; start: number } | null>(null);
  const frameVideoRef = useRef<string | null>(null);
  frameVideoRef.current = frame ? frame.videoId : null;
  useEffect(() => {
    if (!synced || !videoId || !isValidVideoId(videoId)) {
      setFrame(null);
      return;
    }
    setFrame((existing) => existing ?? { videoId, start: expectedPosition(getPlayback(doc)) });
  }, [synced, videoId, doc]);

  const markProgrammatic = useCallback(() => {
    programmaticUntil.current = Date.now() + PROGRAMMATIC_WINDOW_MS;
  }, []);

  // The follow loop: the player converges on the room's record (load, play or pause, then drift).
  followRef.current = () => {
    if (!syncedRef.current) return;
    const current = getVideoId(doc);
    if (!current) {
      loadedVideoId.current = null;
      return;
    }
    if (!controller.ready) return;
    const record = getPlayback(doc);
    const now = Date.now();
    const key = recordKey(doc);
    const recordChanged = key !== lastRecordKey.current;
    lastRecordKey.current = key;
    const target = expectedPosition(record, now);
    if (loadedVideoId.current !== current) {
      // The frame was created for another video (or none yet): switch it.
      if (loadedVideoId.current !== null) {
        markProgrammatic();
        controller.load(current, target, record.state === "playing");
      }
      loadedVideoId.current = current;
      return;
    }
    const state = controller.state;
    const playing = state === PLAYER_STATE.playing || state === PLAYER_STATE.buffering;
    if (record.state === "playing" && !playing && state !== PLAYER_STATE.ended) {
      if (now - lastPlayAskAt.current >= PLAY_RETRY_MS) {
        lastPlayAskAt.current = now;
        markProgrammatic();
        controller.play();
      }
      return;
    }
    if (record.state === "paused" && playing) {
      markProgrammatic();
      controller.pause();
      return;
    }
    if (controller.isLive && record.liveEdge) return;
    if (!recordChanged && now - lastCorrectionAt.current < CORRECTION_COOLDOWN_MS) return;
    const plan = planPlaybackCorrection({
      current: controller.position(now),
      target,
      state: record.state,
      baseRate: record.rate,
      forceSeek: recordChanged,
    });
    if (plan.kind === "seek") {
      lastCorrectionAt.current = now;
      markProgrammatic();
      controller.seek(plan.target);
      controller.setRate(plan.rate);
    } else {
      controller.setRate(plan.rate);
    }
  };

  /** A person's own play, pause or seek, as the room's record (the SDK stamps `updatedAt`; the loop then settles). */
  const writePlayback = (state: "playing" | "paused") => {
    writePlaybackDoc(doc, { state, positionSeconds: controller.position(), rate: getPlayback(doc).rate });
  };

  // Player events: a person's own play, pause or seek becomes the room's record when they may control playback.
  playerEventRef.current = (event) => {
    const now = Date.now();
    const current = getVideoId(doc);
    if (event === "ready") {
      // The frame's first video came from its URL; the loop switches it if the room moved on meanwhile.
      loadedVideoId.current = frameVideoRef.current;
      followRef.current();
      return;
    }
    if (event === "error") return;
    const record = getPlayback(doc);
    const mayControl = !readOnlyRef.current && syncedRef.current && current !== null;
    if (event === "state") {
      if (controller.state === PLAYER_STATE.ended) {
        if (mayControl) advanceQueue(doc, current);
        return;
      }
      if (now < programmaticUntil.current || !mayControl) {
        followRef.current();
        return;
      }
      if (controller.state === PLAYER_STATE.paused && record.state === "playing") {
        writePlayback("paused");
      } else if (controller.state === PLAYER_STATE.playing && record.state === "paused") {
        writePlayback("playing");
      } else {
        followRef.current();
      }
      return;
    }
    // A time report: a jump in the player's own clock is a seek from its controls.
    const previous = lastReport.current;
    lastReport.current = { time: controller.currentTime, at: now };
    if (previous.at === 0 || now < programmaticUntil.current || !mayControl) return;
    const elapsed = controller.state === PLAYER_STATE.playing ? ((now - previous.at) / 1000) * controller.rate : 0;
    if (Math.abs(controller.currentTime - (previous.time + elapsed)) > USER_SEEK_SECONDS) {
      writePlayback(record.state);
    }
  };

  // The follow loop runs on a timer and on every doc change.
  useEffect(() => {
    const tick = () => followRef.current();
    const timer = setInterval(tick, FOLLOW_INTERVAL_MS);
    doc.on("update", tick);
    return () => {
      clearInterval(timer);
      doc.off("update", tick);
    };
  }, [doc]);

  const status = useMemo<WatchAppStatus>(
    () => ({
      kind: "watch",
      videoId: videoId && isValidVideoId(videoId) ? videoId : "",
      title: clip(videoTitle, WATCH_LIMITS.title),
      playback: videoId ? playbackState : "none",
      queue: queue
        .filter((item) => isValidIdentifier(item.id) && isValidVideoId(item.videoId))
        .slice(0, WATCH_LIMITS.queue)
        .map((item) => ({
          id: item.id,
          videoId: item.videoId,
          title: clip(item.title, WATCH_LIMITS.title),
          byName: clip(item.addedByName, WATCH_LIMITS.name),
        })),
      requests: watchRequests.requests
        .filter((request) => isValidIdentifier(request.id) && isValidVideoId(request.videoId))
        .slice(0, WATCH_LIMITS.requests)
        .map((request) => ({
          id: request.id,
          videoId: request.videoId,
          title: clip(request.title, WATCH_LIMITS.title),
          byId: clip(request.byId, WATCH_LIMITS.userId),
          byName: clip(request.byName, WATCH_LIMITS.name),
        })),
      myRequestId: watchRequests.myRequest && isValidIdentifier(watchRequests.myRequest.id) ? watchRequests.myRequest.id : "",
      requestDeclined: watchRequests.declined,
    }),
    [videoId, videoTitle, playbackState, queue, watchRequests.requests, watchRequests.myRequest, watchRequests.declined],
  );

  useEffect(() => {
    if (!synced) return;
    session.sendStatus({ app: status });
  }, [session, status, synced]);

  // Host commands. Each one applies (the doc update re-sends the status), then returns for the ack.
  const requestsRef = useRef(watchRequests);
  requestsRef.current = watchRequests;
  useEffect(() => {
    const handler = (envelope: Envelope<NativeToEmbedType>): CommandResult => {
      const payload = envelope.payload;
      if (!session.isSynced) return { ok: false, error: "notSynced" };
      if (EDIT_COMMANDS.has(envelope.type) && readOnlyRef.current) return { ok: false, error: "readOnly" };
      const current = session.hostStatus;
      const context = { userId: current.userId || null, userName: current.userName || null };
      switch (envelope.type) {
        case "playNow": {
          const itemId = payloadString(payload, "itemId");
          if (itemId !== "") {
            if (!isValidIdentifier(itemId)) return { ok: false, error: "badItem" };
            playQueueItemNow(doc, itemId);
            return { ok: true };
          }
          const nextVideoId = payloadString(payload, "videoId");
          if (!isValidVideoId(nextVideoId)) return { ok: false, error: "badVideo" };
          setVideo(doc, nextVideoId, { play: true, positionSeconds: 0, title: clip(payloadString(payload, "title"), WATCH_LIMITS.title) || null });
          return { ok: true };
        }
        case "enqueue": {
          const nextVideoId = payloadString(payload, "videoId");
          if (!isValidVideoId(nextVideoId)) return { ok: false, error: "badVideo" };
          const title = clip(payloadString(payload, "title"), WATCH_LIMITS.title) || null;
          // As on web: with nothing playing, adding starts it.
          if (!getVideoId(doc)) {
            setVideo(doc, nextVideoId, { play: true, positionSeconds: 0, title });
          } else {
            enqueue(doc, { videoId: nextVideoId, title }, context);
          }
          return { ok: true };
        }
        case "request": {
          const nextVideoId = payloadString(payload, "videoId");
          if (!isValidVideoId(nextVideoId)) return { ok: false, error: "badVideo" };
          requestsRef.current.submitRequest(nextVideoId, clip(payloadString(payload, "title"), WATCH_LIMITS.title) || null);
          return { ok: true };
        }
        case "approve":
        case "decline": {
          const requestId = payloadString(payload, "requestId");
          const request = requestsRef.current.requests.find((entry) => entry.id === requestId);
          if (!request) return { ok: false, error: "noRequest" };
          // With co-hosts the first decision wins; a later one is a no-op, not a duplicate.
          if (getWatchRequestResolution(doc, request.id)) return { ok: true };
          if (envelope.type === "approve") {
            resolveWatchRequest(doc, request.id, "added");
            enqueue(doc, { videoId: request.videoId, title: request.title }, { userId: request.byId, userName: request.byName });
          } else {
            resolveWatchRequest(doc, request.id, "declined");
          }
          return { ok: true };
        }
        case "cancelRequest":
          requestsRef.current.cancelRequest();
          return { ok: true };
        case "move": {
          // One step per Move up or Move down; an iOS drag sends its whole distance as `steps` (one transaction).
          const itemId = payloadString(payload, "itemId");
          const direction = payloadNumber(payload, "direction");
          const steps = payloadNumber(payload, "steps") ?? 1;
          if (!isValidIdentifier(itemId) || (direction !== -1 && direction !== 1)) return { ok: false, error: "badMove" };
          if (!Number.isInteger(steps) || steps < 1 || steps > WATCH_LIMITS.queue) return { ok: false, error: "badMove" };
          doc.transact(() => {
            for (let step = 0; step < steps; step += 1) moveQueueItem(doc, itemId, direction);
          });
          return { ok: true };
        }
        case "remove": {
          const itemId = payloadString(payload, "itemId");
          if (!isValidIdentifier(itemId)) return { ok: false, error: "badItem" };
          removeQueueItem(doc, itemId);
          return { ok: true };
        }
        // Relay messages and commands for another app retain the same rejection as unknown commands.
        case "snapshot":
        case "update":
        case "awareness":
        case "status":
        case "resync":
        case "close":
        case "setTool":
        case "setColor":
        case "setStrokeWidth":
        case "setFill":
        case "undo":
        case "redo":
        case "setPage":
        case "addPage":
        case "renamePage":
        case "deletePage":
        case "zoomToFit":
        case "export":
        case "addEntries":
        case "removeEntry":
        case "shuffle":
        case "sort":
        case "clearEntries":
        case "spin":
        case "setRemoveWinner":
        case "setSounds":
        case "clearResults":
        default:
          return { ok: false, error: "unknownCommand" };
      }
    };
    session.setCommandHandler(handler);
    return () => {
      session.setCommandHandler(null);
    };
  }, [session, doc]);

  const attachFrame = useCallback((element: HTMLIFrameElement | null) => controller.attach(element), [controller]);

  return (
    <div className="watch-page">
      {frame ? (
        <iframe
          ref={attachFrame}
          className="watch-frame"
          src={youtubeEmbedUrl(frame.videoId, frame.start, window.location.origin)}
          title={videoTitle ?? ""}
          allow="autoplay; encrypted-media; picture-in-picture"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      ) : null}
    </div>
  );
}

