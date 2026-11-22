// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import BrowserLayout from "../src/app/components/BrowserLayout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// A navigate that lands on the same noVNC port changes only the password in
// the URL fragment. The viewer must open that session as a fresh document.
const sessionUrl = (password: string) =>
  `http://vnc.example:6080/vnc_lite.html?autoconnect=true&path=websockify#&password=${password}`;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const renderLayout = (browserVideoStream: MediaStream | null) => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = (noVncUrl: string) =>
    act(() =>
      root!.render(
        <BrowserLayout
          noVncUrl={noVncUrl}
          controllerName="Host"
          localStream={null}
          isCameraOff
          isMuted
          isHandRaised={false}
          participants={new Map()}
          userEmail="viewer@example.com"
          isMirrorCamera={false}
          activeSpeakerId={null}
          currentUserId="viewer"
          getDisplayName={() => "Viewer"}
          browserVideoStream={browserVideoStream}
        />,
      ),
    );
  return render;
};

describe("shared browser session frame", () => {
  it.each([
    ["the noVNC viewer", null, "Shared Browser"],
    ["the input overlay over browser video", new MediaStream(), "Shared Browser Input"],
  ])("opens a new session in a new document for %s", (_label, stream, title) => {
    const render = renderLayout(stream);
    render(sessionUrl("first111"));
    const before = host!.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`);
    expect(before?.src).toContain("password=first111");

    render(sessionUrl("second22"));
    const after = host!.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`);
    expect(after?.src).toContain("password=second22");
    expect(after).not.toBe(before);
  });
});
