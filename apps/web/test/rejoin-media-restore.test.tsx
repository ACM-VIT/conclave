// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRejoinMediaRestore } from "../src/app/hooks/useRejoinMediaRestore";
import type { RejoinMedia } from "../src/app/lib/call-outcome";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

const media: RejoinMedia = { isMicOn: true, isCameraOn: true, isAudioOnly: false };

function Probe(props: {
  media: RejoinMedia | null;
  apply: (media: RejoinMedia) => Promise<unknown>;
  seen: boolean[];
}) {
  props.seen.push(useRejoinMediaRestore(props.media, props.apply));
  return null;
}

const render = (element: React.ReactElement) =>
  act(() => {
    root ??= createRoot(document.createElement("div"));
    root.render(element);
  });

describe("restoring a rejoin's devices", () => {
  it("holds Join while the restored devices open, then lets it go", async () => {
    let opened = () => {};
    const apply = vi.fn(() => new Promise<void>((resolve) => (opened = resolve)));
    const seen: boolean[] = [];
    render(<Probe media={media} apply={apply} seen={seen} />);
    expect(apply).toHaveBeenCalledWith(media);
    expect(seen.at(-1)).toBe(true);

    await act(async () => opened());
    expect(seen.at(-1)).toBe(false);
  });

  it("lets Join go when a device fails to open", async () => {
    let failed = (_: Error) => {};
    const apply = vi.fn(() => new Promise<void>((_, reject) => (failed = reject)));
    const seen: boolean[] = [];
    render(<Probe media={media} apply={apply} seen={seen} />);
    await act(async () => failed(new Error("Camera unavailable")));
    expect(seen.at(-1)).toBe(false);
  });

  it("restores once, and holds nothing for a join that carries no choices", async () => {
    const apply = vi.fn(async () => {});
    const seen: boolean[] = [];
    render(<Probe media={null} apply={apply} seen={seen} />);
    expect(seen.every((restoring) => !restoring)).toBe(true);
    render(<Probe media={media} apply={apply} seen={seen} />);
    await act(async () => {});
    render(<Probe media={{ ...media }} apply={apply} seen={seen} />);
    await act(async () => {});
    expect(apply).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe(false);
  });
});
