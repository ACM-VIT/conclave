import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDisplayMedia,
  captureUserMedia,
  onCapturesReleased,
  releaseAllCaptures,
} from "../src/app/lib/media-captures";
import { getUserMediaWithTimeout } from "../src/app/lib/media-capture-timeout";

type FakeTrack = { id: string; readyState: MediaStreamTrackState; onended: null; stop: () => void };

const created: FakeTrack[] = [];
let grants: Array<() => void> = [];
let hold = false;

const grant = (source: string) =>
  new Promise<MediaStream>((resolve) => {
    const give = () => {
      const track: FakeTrack = {
        id: `${source}-${created.length + 1}`,
        readyState: "live",
        onended: null,
        stop() {
          track.readyState = "ended";
        },
      };
      created.push(track);
      resolve({ getTracks: () => [track] } as unknown as MediaStream);
    };
    if (hold) grants.push(give);
    else give();
  });

const live = () => created.filter((track) => track.readyState === "live").map((track) => track.id);

beforeEach(() => {
  created.length = 0;
  grants = [];
  hold = false;
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: () => grant("camera"),
      getDisplayMedia: () => grant("screen"),
    },
  });
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});

afterEach(() => {
  releaseAllCaptures();
  vi.unstubAllGlobals();
});

describe("the capture ledger", () => {
  it("stops every camera, microphone and screen capture it handed out", async () => {
    await captureUserMedia({ video: true });
    await captureDisplayMedia({ video: true });
    await getUserMediaWithTimeout({ audio: true }, { label: "Microphone", timeoutMs: 60000 });
    expect(live()).toHaveLength(3);

    releaseAllCaptures();

    expect(live()).toEqual([]);
  });

  it("stops a capture granted after the release and tells its caller the call ended", async () => {
    hold = true;
    const camera = captureUserMedia({ video: true });
    const screen = captureDisplayMedia({ video: true });
    const meeting = getUserMediaWithTimeout({ audio: true }, { label: "Microphone", timeoutMs: 60000 });

    releaseAllCaptures();
    grants.forEach((give) => give());

    for (const request of [camera, screen, meeting]) {
      await expect(request).rejects.toMatchObject({ name: "AbortError" });
    }
    expect(created).toHaveLength(3);
    expect(live()).toEqual([]);
  });

  it("serves captures asked for after a release, and releases them at the next ending", async () => {
    releaseAllCaptures();
    await captureUserMedia({ video: true });
    expect(live()).toHaveLength(1);

    releaseAllCaptures();

    expect(live()).toEqual([]);
  });

  it("tells every capture owner, and still stops every track when one owner fails", async () => {
    const owners = [vi.fn(), vi.fn(() => { throw new Error("owner failed"); }), vi.fn()];
    const unsubscribe = owners.map((owner) => onCapturesReleased(owner));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await captureUserMedia({ video: true });

    releaseAllCaptures();

    owners.forEach((owner) => expect(owner).toHaveBeenCalledOnce());
    expect(live()).toEqual([]);
    expect(consoleError).toHaveBeenCalledOnce();
    unsubscribe.forEach((stop) => stop());
    releaseAllCaptures();
    owners.forEach((owner) => expect(owner).toHaveBeenCalledOnce());
    consoleError.mockRestore();
  });
});
