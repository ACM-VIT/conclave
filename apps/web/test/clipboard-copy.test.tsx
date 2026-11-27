// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useClipboardCopy,
  type ClipboardCopyStatus,
} from "../src/app/hooks/useClipboardCopy";

let root: Root;
let container: HTMLDivElement;
let latest: { status: ClipboardCopyStatus | null; copy: () => Promise<void> };

function Probe({ text }: { text: string }) {
  latest = useClipboardCopy(text);
  return null;
}

const render = (text: string) => act(async () => root.render(<Probe text={text} />));

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const stubClipboard = (writeText: ((text: string) => Promise<void>) | undefined) =>
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("copying the joining link", () => {
  it("confirms the copy for that link, then clears", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    await render("https://meet.example.com/abc");

    await act(() => latest.copy());
    expect(writeText).toHaveBeenCalledWith("https://meet.example.com/abc");
    expect(latest.status).toBe("copied");

    await act(async () => vi.advanceTimersByTime(1800));
    expect(latest.status).toBeNull();
  });

  it("does not confirm a slow copy after the code was edited", async () => {
    const write = deferred();
    stubClipboard(() => write.promise);
    await render("https://meet.example.com/abc");

    let pending!: Promise<void>;
    act(() => {
      pending = latest.copy();
    });
    await render("https://meet.example.com/abcd");
    await act(async () => {
      write.resolve();
      await pending;
    });
    expect(latest.status).toBeNull();

    await render("https://meet.example.com/abc");
    expect(latest.status).toBeNull();
  });

  it("does not bring a confirmation back when the code is edited and restored", async () => {
    stubClipboard(() => Promise.resolve());
    await render("https://meet.example.com/abc");
    await act(() => latest.copy());
    expect(latest.status).toBe("copied");

    await render("https://meet.example.com/abcd");
    expect(latest.status).toBeNull();
    await render("https://meet.example.com/abc");
    expect(latest.status).toBeNull();
  });

  it("clears the previous confirmation while a new copy is pending", async () => {
    const second = deferred();
    const writes = [() => Promise.resolve(), () => second.promise];
    stubClipboard(() => writes.shift()!());
    await render("https://meet.example.com/abc");
    await act(() => latest.copy());
    expect(latest.status).toBe("copied");

    let pending!: Promise<void>;
    act(() => {
      pending = latest.copy();
    });
    expect(latest.status).toBeNull();
    await act(async () => {
      second.resolve();
      await pending;
    });
    expect(latest.status).toBe("copied");
  });

  it("starts no feedback timer when unmounted during a pending copy", async () => {
    const write = deferred();
    stubClipboard(() => write.promise);
    await render("https://meet.example.com/abc");
    let pending!: Promise<void>;
    act(() => {
      pending = latest.copy();
    });
    await act(async () => root.unmount());
    await act(async () => {
      write.resolve();
      await pending;
    });
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });

  it("lets the latest copy win over an earlier slow one", async () => {
    const first = deferred();
    const writes = [() => first.promise, () => Promise.resolve()];
    stubClipboard(() => writes.shift()!());
    await render("https://meet.example.com/abc");

    let slow!: Promise<void>;
    act(() => {
      slow = latest.copy();
    });
    await act(() => latest.copy());
    expect(latest.status).toBe("copied");

    await act(async () => {
      first.reject(new Error("denied"));
      await slow;
    });
    expect(latest.status).toBe("copied");
  });

  it("reports a failed copy, including when the clipboard is unavailable", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    await render("https://meet.example.com/abc");
    await act(() => latest.copy());
    expect(latest.status).toBe("failed");

    stubClipboard(undefined);
    await act(async () => vi.advanceTimersByTime(1800));
    await act(() => latest.copy());
    expect(latest.status).toBe("failed");
  });
});
