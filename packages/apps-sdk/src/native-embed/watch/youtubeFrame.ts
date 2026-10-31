// The Watch Together player frame for the native embed (ACT-8): one privacy-enhanced YouTube embed
// (`https://www.youtube-nocookie.com/embed/<id>?enablejsapi=1`) driven through the embed player's own postMessage
// channel, the same JSON messages the YouTube IFrame API sends. No YouTube script runs in this page (its CSP allows
// only its own inline hashes and frames only WATCH_FRAME_ORIGIN), so nothing from the network can reach the native
// bridge; the cross-origin frame cannot post to it either (native checks the origin and the main frame). The player
// keeps YouTube's own controls (seek, live, volume, captions); its play button is the tap-to-start prompt when the
// platform blocks autoplay (S60 13 c, WEB APP-32).

import { WATCH_FRAME_ORIGIN, isRecord, isValidVideoId } from "../protocol";

/** YouTube player states (IFrame API `PlayerState`). */
export const PLAYER_STATE = {
  unstarted: -1,
  ended: 0,
  playing: 1,
  paused: 2,
  buffering: 3,
  cued: 5,
} as const;

export type PlayerEvent = "ready" | "state" | "time" | "error";

const LISTEN_INTERVAL_MS = 250;
const LISTEN_ATTEMPTS = 60;
const CHANNEL = "widget";
const FRAME_ID = 1;

/** The embed URL for a video. `origin` is passed only when it is an https origin (the player rejects others). */
export const youtubeEmbedUrl = (videoId: string, startSeconds: number, origin: string): string => {
  if (!isValidVideoId(videoId)) return "about:blank";
  const params = new URLSearchParams({
    enablejsapi: "1",
    controls: "1",
    playsinline: "1",
    rel: "0",
    iv_load_policy: "3",
    fs: "0",
    autoplay: "1",
    start: String(Math.max(0, Math.floor(startSeconds))),
  });
  if (origin.startsWith("https://")) {
    params.set("origin", origin);
    params.set("widget_referrer", origin);
  }
  return `${WATCH_FRAME_ORIGIN}/embed/${videoId}?${params.toString()}`;
};

export class YouTubeFrameController {
  ready = false;
  state: number = PLAYER_STATE.unstarted;
  currentTime = 0;
  duration = 0;
  rate = 1;
  isLive = false;
  errorCode = 0;
  /** When the last time report arrived (ms epoch), so a caller can extrapolate the position between reports. */
  lastTimeAt = 0;

  private frame: HTMLIFrameElement | null = null;
  private listenTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listener: (event: PlayerEvent) => void;

  constructor(listener: (event: PlayerEvent) => void) {
    this.listener = listener;
    window.addEventListener("message", this.handleMessage);
  }

  /** The iframe ref callback: a new frame restarts the handshake; null detaches. */
  attach(frame: HTMLIFrameElement | null): void {
    if (frame === this.frame) return;
    this.stopListening();
    if (this.frame) this.frame.removeEventListener("load", this.startListening);
    this.frame = frame;
    this.ready = false;
    this.state = PLAYER_STATE.unstarted;
    this.currentTime = 0;
    this.duration = 0;
    this.lastTimeAt = 0;
    if (frame) frame.addEventListener("load", this.startListening);
  }

  dispose(): void {
    this.attach(null);
    window.removeEventListener("message", this.handleMessage);
  }

  /** The position now: the last report plus the time since, while playing. */
  position(now: number = Date.now()): number {
    if (this.state !== PLAYER_STATE.playing || this.lastTimeAt === 0) return this.currentTime;
    return this.currentTime + (Math.max(0, now - this.lastTimeAt) / 1000) * this.rate;
  }

  play(): void {
    this.command("playVideo", []);
  }

  pause(): void {
    this.command("pauseVideo", []);
  }

  seek(seconds: number): void {
    this.command("seekTo", [Math.max(0, seconds), true]);
    this.currentTime = Math.max(0, seconds);
    this.lastTimeAt = Date.now();
  }

  setRate(rate: number): void {
    if (rate === this.rate) return;
    this.command("setPlaybackRate", [rate]);
  }

  /** Switches the frame to another video: playing loads and starts it, paused only cues it. */
  load(videoId: string, startSeconds: number, play: boolean): void {
    if (!isValidVideoId(videoId)) return;
    this.command(play ? "loadVideoById" : "cueVideoById", [{ videoId, startSeconds: Math.max(0, startSeconds) }]);
    this.currentTime = Math.max(0, startSeconds);
    this.lastTimeAt = 0;
  }

  private command(func: string, args: unknown[]): void {
    this.post({ event: "command", func, args, id: FRAME_ID, channel: CHANNEL });
  }

  private post(message: Record<string, unknown>): void {
    const target = this.frame?.contentWindow;
    if (!target) return;
    target.postMessage(JSON.stringify(message), WATCH_FRAME_ORIGIN);
  }

  private readonly startListening = (): void => {
    this.stopListening();
    let attempts = 0;
    const listen = () => {
      attempts += 1;
      if (this.ready || attempts > LISTEN_ATTEMPTS) {
        this.stopListening();
        return;
      }
      this.post({ event: "listening", id: FRAME_ID, channel: CHANNEL });
    };
    listen();
    this.listenTimer = setInterval(listen, LISTEN_INTERVAL_MS);
  };

  private stopListening(): void {
    if (this.listenTimer !== null) clearInterval(this.listenTimer);
    this.listenTimer = null;
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.stopListening();
    this.command("addEventListener", ["onStateChange"]);
    this.command("addEventListener", ["onError"]);
    this.listener("ready");
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    const frame = this.frame;
    if (!frame || event.source !== frame.contentWindow || event.origin !== WATCH_FRAME_ORIGIN) return;
    let data: unknown = event.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (!isRecord(data)) return;
    switch (data.event) {
      case "onReady":
        this.markReady();
        return;
      case "initialDelivery":
      case "infoDelivery": {
        if (data.event === "initialDelivery") this.markReady();
        const info = data.info;
        if (!isRecord(info)) return;
        let changedState = false;
        if (typeof info.playerState === "number" && info.playerState !== this.state) {
          this.state = info.playerState;
          changedState = true;
        }
        if (typeof info.playbackRate === "number" && info.playbackRate > 0) this.rate = info.playbackRate;
        if (typeof info.duration === "number" && Number.isFinite(info.duration)) this.duration = info.duration;
        const videoData = info.videoData;
        if (isRecord(videoData) && typeof videoData.isLive === "boolean") this.isLive = videoData.isLive;
        if (typeof info.currentTime === "number" && Number.isFinite(info.currentTime)) {
          this.currentTime = info.currentTime;
          this.lastTimeAt = Date.now();
          this.listener("time");
        }
        if (changedState) this.listener("state");
        return;
      }
      case "onStateChange":
        if (typeof data.info === "number") {
          this.state = data.info;
          if (data.info !== PLAYER_STATE.playing) this.lastTimeAt = 0;
          this.listener("state");
        }
        return;
      case "onError":
        this.errorCode = typeof data.info === "number" ? data.info : -1;
        this.listener("error");
        return;
      default:
        return;
    }
  };
}
