import type { MediaDeviceFailures } from "./utils";

interface AcquireLocalTracksOptions {
  audio: boolean;
  video: boolean;
  request: (audio: boolean, video: boolean) => Promise<MediaStream>;
}

export async function acquireLocalTracks({
  audio,
  video,
  request,
}: AcquireLocalTracksOptions): Promise<{ streams: MediaStream[]; failures: MediaDeviceFailures }> {
  const streams: MediaStream[] = [];
  const failures: MediaDeviceFailures = {};
  if (!audio && !video) return { streams, failures };
  try {
    streams.push(await request(audio, video));
    return { streams, failures };
  } catch (error) {
    if (!audio || !video) {
      failures[audio ? "microphone" : "camera"] = error;
      return { streams, failures };
    }
  }
  try {
    streams.push(await request(true, false));
  } catch (error) {
    failures.microphone = error;
  }
  try {
    streams.push(await request(false, true));
  } catch (error) {
    failures.camera = error;
  }
  return { streams, failures };
}

const firstLiveTrack = (tracks: MediaStreamTrack[], kind: "audio" | "video") =>
  tracks.find((track) => track.kind === kind && track.readyState === "live") ?? null;

interface SettleLocalTracksOptions {
  acquired: MediaStreamTrack[];
  reusable: { audio: MediaStreamTrack | null; video: MediaStreamTrack | null };
  prepareAudio: (track: MediaStreamTrack) => Promise<MediaStreamTrack>;
}

export async function settleLocalTracks({ acquired, reusable, prepareAudio }: SettleLocalTracksOptions) {
  const video = firstLiveTrack(acquired, "video") ?? reusable.video;
  const freshAudio = firstLiveTrack(acquired, "audio");
  if (!freshAudio) return { audio: reusable.audio, video, audioFailure: undefined };
  try {
    return { audio: await prepareAudio(freshAudio), video, audioFailure: undefined };
  } catch (audioFailure) {
    return { audio: null, video, audioFailure };
  }
}
