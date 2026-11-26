// @vitest-environment node
import { PropertySymbol, Window } from "happy-dom";
import { act, lazy, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import JoinScreen from "../src/app/components/JoinScreen";
import { readRejoinIntent, saveRejoinIntent } from "../src/app/lib/rejoin-intent";
import { DEFAULT_VIDEO_EFFECTS } from "../src/app/lib/video-effects";

vi.mock("@/lib/auth-client", () => ({
  signOut: vi.fn(),
  useSession: () => ({ data: null }),
}));
vi.mock("@/lib/site-url", () => import("../src/lib/site-url"));
vi.mock("@/lib/meeting-links", () => import("../src/lib/meeting-links"));
vi.mock("@/lib/sfu-client-id", () => import("../src/lib/sfu-client-id"));
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

function capture(kind: "audio" | "video") {
  const track = new browser.MediaStreamTrack(PropertySymbol.illegalConstructor);
  track[PropertySymbol.kind] = kind;
  return new MediaStream([track as unknown as MediaStreamTrack]);
}

const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) =>
  capture(constraints.video ? "video" : "audio"),
);

beforeEach(() => {
  browser = new Window({ url: "https://conclave.example/rejoin-room" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", browser.document);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
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
  root = createRoot(container);
  getUserMedia.mockClear();
  saveRejoinIntent(target, carried);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  vi.unstubAllGlobals();
});

function RoomPage() {
  const [pendingMedia, setPendingMedia] = useState(() => readRejoinIntent(target));
  const [joined, setJoined] = useState(false);
  if (joined) return <button onClick={() => setJoined(false)}>Leave call</button>;
  return (
    <Suspense fallback={null}>
      <JoinScreen
        roomId={target.roomId}
        onRoomIdChange={noop}
        onJoinRoom={() => setJoined(true)}
        isLoading={false}
        user={{ id: "member", name: "Guest" }}
        userEmail=""
        connectionState="idle"
        isAdmin={false}
        enableRoomRouting
        forceJoinOnly
        clientId={target.clientId}
        showPermissionHint={false}
        rooms={[]}
        roomsStatus="idle"
        onRefreshRooms={noop}
        displayNameInput=""
        onDisplayNameInputChange={noop}
        onUserChange={noop}
        onIsAdminChange={noop}
        initialMedia={pendingMedia}
        onInitialMediaUsed={() => setPendingMedia(null)}
        videoEffects={DEFAULT_VIDEO_EFFECTS}
        onVideoEffectsChange={noop}
      />
    </Suspense>
  );
}

const openRoom = () =>
  act(async () =>
    root.render(
      <StrictMode>
        <RoomPage />
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
    await act(async () => mic.resolve(capture("audio")));

    expect(button(turnOn, scope)).toBeDefined();
    expect(button("Turn off microphone")).toBeDefined();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  },
);
