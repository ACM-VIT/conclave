// @vitest-environment node
import { Window } from "happy-dom";
import { act, lazy, Suspense, type ComponentProps } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JoinScreen from "../src/app/components/JoinScreen";
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

const noop = () => {};

let browser: Window;
let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  browser = new Window({ url: "https://conclave.example/" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", browser.document);
  vi.stubGlobal("navigator", { userAgent: browser.navigator.userAgent, mediaDevices: {} });
  vi.stubGlobal("Audio", browser.Audio);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  vi.unstubAllGlobals();
});

type ScreenProps = Pick<ComponentProps<typeof JoinScreen>, "user" | "userEmail"> & {
  roomLink?: boolean;
};

const render = ({ user, userEmail, roomLink = false }: ScreenProps) =>
  act(async () =>
    root.render(
      <Suspense fallback={null}>
        <JoinScreen
          roomId={roomLink ? "kite-moss-pale" : ""}
          onRoomIdChange={noop}
          onJoinRoom={noop}
          isLoading={false}
          user={user}
          userEmail={userEmail}
          connectionState="idle"
          isAdmin={false}
          enableRoomRouting
          forceJoinOnly={roomLink}
          clientId="conclave"
          showPermissionHint={false}
          rooms={[]}
          onRefreshRooms={noop}
          displayNameInput=""
          onDisplayNameInputChange={noop}
          onUserChange={noop}
          onIsAdminChange={noop}
          videoEffects={DEFAULT_VIDEO_EFFECTS}
          onVideoEffectsChange={noop}
        />
      </Suspense>,
    ),
  );

const accountLines = () => {
  const signOut = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Sign out",
  );
  if (!signOut?.parentElement) throw new Error("No account row with Sign out");
  return Array.from(signOut.parentElement.querySelectorAll("p")).map((line) => line.textContent);
};

const heading = () => container.querySelector("h1")?.textContent;
const headingIntro = () => container.querySelector("h1")?.nextElementSibling?.textContent ?? null;

describe("the signed-in account row", () => {
  it("shows the name, then the account email", async () => {
    await render({
      user: { id: "member", name: "Ishaan", email: "ishaan@example.com" },
      userEmail: "Ishaan",
    });
    expect(accountLines()).toEqual(["Ishaan", "ishaan@example.com"]);
  });

  it("shows the name once when the account has no email", async () => {
    await render({ user: { id: "member", name: "Ishaan" }, userEmail: "Ishaan" });
    expect(accountLines()).toEqual(["Ishaan"]);
  });

  it("shows the email once when the account name is the email", async () => {
    await render({
      user: { id: "member", name: "ishaan@example.com", email: "Ishaan@Example.com" },
      userEmail: "ishaan@example.com",
    });
    expect(accountLines()).toEqual(["ishaan@example.com"]);
  });

  it("shows the email under the short name when the account has no name", async () => {
    await render({
      user: { id: "member", email: "ishaan@example.com" },
      userEmail: "ishaan@example.com",
    });
    expect(accountLines()).toEqual(["ishaan", "ishaan@example.com"]);
  });
});

describe("the join card heading", () => {
  it("offers both actions on the home page", async () => {
    await render({ user: { id: "member", name: "Ishaan" }, userEmail: "Ishaan" });
    expect(heading()).toBe("Start or join a meeting");
    expect(headingIntro()).toBeNull();
  });

  it("asks to check devices on a room link", async () => {
    await render({ user: { id: "member", name: "Ishaan" }, userEmail: "Ishaan", roomLink: true });
    expect(heading()).toBe("Ready to join?");
    expect(headingIntro()).toBe("Check your camera and mic before you join.");
  });
});
