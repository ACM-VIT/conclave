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
