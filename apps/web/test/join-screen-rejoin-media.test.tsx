// @vitest-environment node
import { PropertySymbol, Window } from "happy-dom";
import { act, lazy, StrictMode, Suspense, useEffect, useState, type ComponentProps } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import JoinScreen from "../src/app/components/JoinScreen";
import { releaseAllCaptures } from "../src/app/lib/media-captures";
import { clearRejoinIntent, readRejoinIntent, saveRejoinIntent } from "../src/app/lib/rejoin-intent";
import { DEFAULT_VIDEO_EFFECTS } from "../src/app/lib/video-effects";

vi.mock("@/lib/auth-client", () => ({
  signOut: vi.fn(),
  useSession: () => ({ data: null }),
}));
vi.mock("@/lib/site-url", () => import("../src/lib/site-url"));
vi.mock("@/lib/meeting-links", () => import("../src/lib/meeting-links"));
vi.mock("@/lib/sfu-client-id", () => import("../src/lib/sfu-client-id"));
vi.mock("@/app/lib/utils", () => import("../src/app/lib/utils"));
vi.mock("next/dynamic", () => ({ default: lazy }));
vi.mock("../src/app/lib/video-effects-lazy", () => ({
  prewarmVideoEffectsAssetsDeferred: () => Promise.resolve(),
}));

const target = { roomId: "rejoin-room", clientId: "conclave" };
const carried = { isMicOn: true, isCameraOn: true, isAudioOnly: false };
const noop = () => {};

let browser: Window;
let container: HTMLDivElement;
let root: Root;

function capture(...kinds: ("audio" | "video")[]) {
  return new MediaStream(kinds.map((kind) => {
    const track = new browser.MediaStreamTrack(PropertySymbol.illegalConstructor);
    track[PropertySymbol.kind] = kind;
    return track as unknown as MediaStreamTrack;
  }));
}

const getUserMedia = vi.fn(async ({ audio, video }: MediaStreamConstraints) => {
  const kinds: ("audio" | "video")[] = [];
  if (audio) kinds.push("audio");
  if (video) kinds.push("video");
  return capture(...kinds);
});
const commitMedia = vi.fn<NonNullable<ComponentProps<typeof JoinScreen>["onPrejoinMediaCommit"]>>();

beforeEach(async () => {
  browser = new Window({ url: "https://conclave.example/rejoin-room" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", browser.document);
  vi.stubGlobal("navigator", { userAgent: browser.navigator.userAgent, mediaDevices: { getUserMedia } });
  vi.stubGlobal("Audio", browser.Audio);
  const { MediaStream: HappyMediaStream } = browser;
  class CaptureStream extends HappyMediaStream {
    getTracks() {
      return [...this.getAudioTracks(), ...this.getVideoTracks()];
    }
  }
  vi.stubGlobal("MediaStream", CaptureStream);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
  getUserMedia.mockReset();
  commitMedia.mockClear();
  saveRejoinIntent(target, carried);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  vi.unstubAllGlobals();
});

function RoomPage({
  home = false,
  suppliedRoomId,
  onJoin = noop,
  onLookup = noop,
}: {
  home?: boolean;
  suppliedRoomId?: string;
  onJoin?: (id: string) => void;
  onLookup?: (id?: string) => void;
}) {
  const pageTarget = suppliedRoomId
    ? { roomId: suppliedRoomId, clientId: "acme" }
    : home ? { roomId: "default-room", clientId: "acme" } : target;
  const [roomId, setRoomId] = useState(pageTarget.roomId);
  const [pendingMedia, setPendingMedia] = useState(() => readRejoinIntent(pageTarget));
  const [joined, setJoined] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    if (home && !roomId) setRoomId(window.location.pathname.slice(1));
  }, [home, roomId]);
  if (joined) return <button onClick={() => setJoined(false)}>Leave call</button>;
  return (
    <Suspense fallback={null}>
      <JoinScreen
        roomId={roomId}
        onRoomIdChange={setRoomId}
        onJoinRoom={(id) => {
          onJoin(id);
          setJoined(true);
        }}
        isLoading={false}
        user={{ id: "member", name: "Guest" }}
        userEmail=""
        connectionState="idle"
        isAdmin={isAdmin}
        enableRoomRouting={!suppliedRoomId}
        forceJoinOnly={!home && !suppliedRoomId}
        clientId={pageTarget.clientId}
        showPermissionHint={false}
        rooms={[]}
        roomsStatus="idle"
        onRefreshRooms={onLookup}
        displayNameInput=""
        onDisplayNameInputChange={noop}
        onUserChange={noop}
        onIsAdminChange={setIsAdmin}
        onPrejoinMediaCommit={commitMedia}
        initialMedia={pendingMedia}
        onInitialMediaUsed={() => setPendingMedia(null)}
        videoEffects={DEFAULT_VIDEO_EFFECTS}
        onVideoEffectsChange={noop}
      />
    </Suspense>
  );
}

const openRoom = (home = false) =>
  act(async () =>
    root.render(
      <StrictMode>
        <RoomPage home={home} />
      </StrictMode>,
    ),
  );

function button(label: string, scope: ParentNode = container) {
  return Array.from(scope.querySelectorAll("button")).find(
    (el) => (el.getAttribute("aria-label") ?? el.textContent?.trim()) === label,
  );
}

async function click(label: string, scope: ParentNode = container) {
  const el = button(label, scope);
  if (!el || el.disabled) throw new Error(`No enabled "${label}" button`);
  await act(async () => el.click());
}

it("joins the exact room ID supplied by a non-routing integration", async () => {
  const join = vi.fn();
  await act(async () => root.render(<RoomPage suppliedRoomId="team_room" onJoin={join} />));

  expect(button("Join")?.disabled).toBe(false);
  await click("Join");

  expect(join).toHaveBeenCalledExactlyOnceWith("team_room");
});

it("keeps the cross-client destination after leaving a meeting on the home page", async () => {
  const lookup = vi.fn();
  await act(async () => root.render(<RoomPage home onLookup={lookup} />));
  await click("New meeting");
  const previousRoom = browser.location.pathname.slice(1);
  expect(previousRoom).not.toBe("rejoin-room");
  await click("Leave call");
  const input = container.querySelector<HTMLInputElement>('input[placeholder="Enter a code or link"]')!;
  expect(input.value).toBe(previousRoom);
  const previousLookups = lookup.mock.calls.slice();
  lookup.mockClear();
  const destination = "https://conclave.example/next-room?clientId=another-client";

  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, destination);
    input.dispatchEvent(new browser.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new browser.Event("focusout", { bubbles: true }) as unknown as Event);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

  expect(input.value).toBe(destination);
  expect(browser.location.pathname).toBe(`/${previousRoom}`);
  expect(previousLookups).toContainEqual(["default-room"]);
  expect(lookup.mock.calls.every(([id]) => id === undefined)).toBe(true);
});

it("moves the address to the room the home page joins after leaving another", async () => {
  const join = vi.fn();
  await act(async () => root.render(<RoomPage home onJoin={join} />));
  await click("New meeting");
  const previousRoom = browser.location.pathname.slice(1);
  await click("Leave call");
  const input = container.querySelector<HTMLInputElement>('input[placeholder="Enter a code or link"]')!;

  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "next-room");
    input.dispatchEvent(new browser.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new browser.Event("focusout", { bubbles: true }) as unknown as Event);
  });
  await click("Join");

  expect(previousRoom).not.toBe("next-room");
  expect(join).toHaveBeenLastCalledWith("next-room");
  expect(browser.location.pathname).toBe("/next-room");
});

it("does not reopen either device on the join card after leaving a call", async () => {
  await openRoom();
  await click("Turn off camera");
  await click("Turn off microphone");
  await click("Join");
  await click("Leave call");
  expect(button("Turn on camera")).toBeDefined();
  expect(button("Turn on microphone")).toBeDefined();
  expect(getUserMedia).toHaveBeenCalledTimes(2);
});

it.each(["effects panel", "main controls"])(
  "keeps the camera off after a choice in the %s while mic restore is pending",
  async (surface) => {
    const mic = Promise.withResolvers<ReturnType<typeof capture>>();
    getUserMedia.mockImplementationOnce(() => mic.promise);
    await openRoom();
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: expect.anything() });

    let scope: ParentNode = container;
    const turnOn = surface === "effects panel" ? "Turn on camera to preview" : "Turn on camera";
    if (surface === "effects panel") {
      await click("Backgrounds and effects");
      await act(async () => vi.dynamicImportSettled());
      const panel = container.querySelector("[data-video-effects-has-live-video]");
      if (!panel) throw new Error("Backgrounds and effects did not open");
      scope = panel;
    }
    await click(turnOn, scope);
    await click("Turn off camera", scope);
    const stale = capture("audio");
    await act(async () => mic.resolve(stale));

    expect(button(turnOn, scope)).toBeDefined();
    expect(button("Turn on microphone")).toBeDefined();
    expect(stale.getAudioTracks()[0].readyState).toBe("ended");
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  },
);

function holdCapture() {
  const pending = Promise.withResolvers<MediaStream>();
  getUserMedia.mockImplementationOnce(() => pending.promise);
  return pending;
}

function showPermissionsPrompt() {
  const permission = Object.assign(new browser.EventTarget(), { state: "prompt" });
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia },
    permissions: { query: async () => permission },
  });
}

it.each(["audio", "video"] as const)(
  "hands off live tracks even if the superseded %s restore rejects",
  async (kind) => {
    showPermissionsPrompt();
    saveRejoinIntent(target, { ...carried, isMicOn: kind === "audio", isCameraOn: kind === "video" });
    const stale = holdCapture();
    await openRoom();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await click("Allow microphone and camera");
    await act(async () => stale.reject(new DOMException("Device busy", "NotReadableError")));
    await click("Join");
    expect(commitMedia).toHaveBeenCalledExactlyOnceWith({
      stream: expect.any(MediaStream),
      isMicOn: true,
      isCameraOn: true,
      isAudioOnly: false,
      skipMutedMicWarmup: true,
    });
    expect(commitMedia.mock.lastCall?.[0].stream?.getTracks().map((track) => track.kind).sort())
      .toEqual(["audio", "video"]);
  },
);

it("joins after a successful permission choice while the earlier prompt is still pending", async () => {
  showPermissionsPrompt();
  const stale = holdCapture();
  await openRoom();
  await click("Allow microphone and camera");
  await click("Join");
  expect(commitMedia).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    isMicOn: true,
    isCameraOn: true,
  }));
  await act(async () => stale.resolve(capture("audio")));
  expect(getUserMedia).toHaveBeenCalledTimes(2);
});

it("joins with the already live microphone without waiting for camera restore", async () => {
  const stale = Promise.withResolvers<MediaStream>();
  getUserMedia.mockImplementationOnce(async () => capture("audio"));
  getUserMedia.mockImplementationOnce(() => stale.promise);
  await openRoom();
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  await click("Join");
  expect(commitMedia).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    isMicOn: true,
    isCameraOn: false,
  }));
  const late = capture("video");
  await act(async () => stale.resolve(late));
  expect(late.getVideoTracks()[0].readyState).toBe("ended");
  expect(commitMedia.mock.lastCall?.[0].stream?.getAudioTracks()[0].readyState).toBe("live");
});

it("allows Enter to join audio-only without waiting for mic or camera restore", async () => {
  const stale = holdCapture();
  await openRoom();
  await click("Audio only: join without video");
  expect(button("Join")?.disabled).toBe(false);
  const code = container.querySelector('input[placeholder="Enter a code or link"]');
  expect(code).not.toBeNull();
  await act(async () => code!.dispatchEvent(
    new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event,
  ));
  expect(commitMedia).toHaveBeenCalledExactlyOnceWith({
    stream: null, isAudioOnly: true, isMicOn: false, isCameraOn: false, skipMutedMicWarmup: true,
  });
  const late = capture("audio");
  await act(async () => stale.resolve(late));
  expect(late.getAudioTracks()[0].readyState).toBe("ended");
  expect(getUserMedia).toHaveBeenCalledTimes(1);
});

it("starts fresh camera capture after audio-only is switched on and off during restore", async () => {
  saveRejoinIntent(target, { ...carried, isMicOn: false });
  const stale = holdCapture();
  await openRoom();
  await click("Audio only: join without video");
  await click("Audio only: join without video");
  await click("Turn on camera");
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  const late = capture("video");
  await act(async () => stale.resolve(late));
  expect(late.getVideoTracks()[0].readyState).toBe("ended");
  expect(button("Turn off camera")).toBeDefined();
  await click("Join");
  expect(commitMedia.mock.lastCall?.[0].stream?.getVideoTracks()).toHaveLength(1);
});

it("starts a new meeting on a non-default tenant while restore is pending", async () => {
  saveRejoinIntent({ roomId: "default-room", clientId: "acme" }, carried);
  const stale = holdCapture();
  await openRoom(true);
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  await click("New meeting");
  expect(button("Leave call")).toBeDefined();
  expect(commitMedia).toHaveBeenCalledExactlyOnceWith({
    stream: null, isAudioOnly: false, isMicOn: false, isCameraOn: false, skipMutedMicWarmup: true,
  });
  const late = capture("audio");
  await act(async () => stale.resolve(late));
  expect(late.getAudioTracks()[0].readyState).toBe("ended");
  expect(getUserMedia).toHaveBeenCalledTimes(1);
});

it("shows both devices off, and joins with them off, once the call has released every capture", async () => {
  await openRoom();
  expect(button("Turn off camera")).toBeDefined();
  expect(button("Turn off microphone")).toBeDefined();
  await act(async () => releaseAllCaptures());
  expect(button("Turn on camera")).toBeDefined();
  expect(button("Turn on microphone")).toBeDefined();
  await click("Join");
  expect(commitMedia).toHaveBeenCalledExactlyOnceWith({
    stream: null, isAudioOnly: false, isMicOn: false, isCameraOn: false, skipMutedMicWarmup: true,
  });
});

it("does not ask again for a permission request the call released while it was pending", async () => {
  clearRejoinIntent();
  showPermissionsPrompt();
  const pending = holdCapture();
  await openRoom();
  await click("Allow microphone and camera");
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  await act(async () => releaseAllCaptures());
  const late = capture("audio", "video");
  await act(async () => pending.resolve(late));
  expect(late.getTracks().map((track) => track.readyState)).toEqual(["ended", "ended"]);
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(button("Turn on camera")).toBeDefined();
  expect(button("Turn on microphone")).toBeDefined();
});
