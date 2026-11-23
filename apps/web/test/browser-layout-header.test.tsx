// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import BrowserLayout from "../src/app/components/BrowserLayout";
import type { Participant } from "../src/app/lib/types";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const renderLayout = () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <BrowserLayout
        noVncUrl=""
        controllerName="Bo Sharer"
        localStream={null}
        isCameraOff
        isMuted={false}
        isHandRaised={false}
        participants={new Map<string, Participant>()}
        userEmail="ada@example.com"
        isMirrorCamera={false}
        activeSpeakerId={null}
        currentUserId="ada"
        getDisplayName={(id) => id}
      />,
    );
  });
  const workspace = host.querySelector('[aria-label="Shared browser workspace"]');
  const header = workspace?.querySelector("header");
  return { header };
};

it("tells everyone the shared browser is live and who shares it", () => {
  const { header } = renderLayout();
  const text = header?.textContent?.replace(/\s+/g, " ") ?? "";
  expect(text).toContain("Shared browser");
  expect(text).toContain("Live");
  expect(text).toContain("Shared by Bo Sharer");
});
