// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import SharedBrowserStage from "../src/app/components/SharedBrowserStage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const sessionUrl = (password: string) =>
  `http://vnc.example:6080/vnc_lite.html?autoconnect=true&path=websockify#&password=${password}`;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

const renderStage = (browserVideoStream: MediaStream | null) => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  return (noVncUrl: string) =>
    act(() =>
      root!.render(
        <SharedBrowserStage
          noVncUrl={noVncUrl}
          controllerName="Host"
          isLocalController={false}
          browserVideoStream={browserVideoStream}
        />,
      ),
    );
};

describe("shared browser session frame", () => {
  it.each([
    ["the noVNC viewer", null, "Shared browser"],
    ["the input overlay over browser video", new MediaStream(), "Shared browser input"],
  ])("opens a new session in a new document for %s", (_label, stream, title) => {
    const render = renderStage(stream);
    render(sessionUrl("first111"));
    const before = host!.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`);
    expect(before?.src).toContain("password=first111");

    render(sessionUrl("second22"));
    const after = host!.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`);
    expect(after?.src).toContain("password=second22");
    expect(after).not.toBe(before);
  });
});
