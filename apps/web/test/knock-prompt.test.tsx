// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import KnockPrompt from "../src/app/components/KnockPrompt";

type Emitted = { event: string; payload: unknown; ack: (...args: unknown[]) => void };

let root: Root;
let host: HTMLDivElement;
let emitted: Emitted[];

const socket = {
  emit: (event: string, payload: unknown, ack: (...args: unknown[]) => void) => {
    emitted.push({ event, payload, ack });
  },
  timeout: () => ({
    emit: (event: string, ack: (...args: unknown[]) => void) => {
      emitted.push({ event, payload: undefined, ack });
    },
  }),
} as unknown as Socket;

const button = (label: string) => {
  const match = Array.from(host.querySelectorAll("button")).find(
    (candidate) =>
      candidate.textContent === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`No button "${label}" in ${host.innerHTML}`);
  return match;
};

const render = async (
  pending: Array<[string, string]>,
  handlers: { onViewAll?: () => void; onStale?: (id: string) => void } = {},
) => {
  await act(async () =>
    root.render(
      <KnockPrompt
        socket={socket}
        pendingUsers={new Map(pending)}
        onViewAll={handlers.onViewAll ?? (() => {})}
        onPendingUserStale={handlers.onStale}
      />,
    ),
  );
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  emitted = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("host knock prompt", () => {
  it("stays hidden while nobody is waiting", async () => {
    await render([]);
    expect(host.textContent).toBe("");
  });

  it("names one person and admits them", async () => {
    await render([["guest-1", "Bob"]]);
    expect(host.textContent).toContain("Bob wants to join");

    await act(async () => button("Admit Bob").click());
    expect(emitted).toMatchObject([
      { event: "admitUser", payload: { userId: "guest-1" } },
    ]);
    expect(button("Admit Bob").disabled).toBe(true);
    expect(button("Deny Bob").disabled).toBe(true);

    await render([]);
    expect(host.textContent).toBe("");
  });

  it("denies one person", async () => {
    await render([["guest-1", "Bob"]]);
    await act(async () => button("Deny Bob").click());
    expect(emitted).toMatchObject([
      { event: "rejectUser", payload: { userId: "guest-1" } },
    ]);
  });

  it("drops a request the server no longer has", async () => {
    const onStale = vi.fn();
    await render([["guest-1", "Bob"]], { onStale });
    await act(async () => button("Admit Bob").click());
    await act(async () => emitted[0].ack({ error: "User not found in waiting room" }));
    expect(onStale).toHaveBeenCalledWith("guest-1");
  });

  it("groups several people with View all and Admit all", async () => {
    const onViewAll = vi.fn();
    await render(
      [
        ["guest-1", "Ana"],
        ["guest-2", "Ben"],
        ["guest-3", "Cy"],
      ],
      { onViewAll },
    );
    expect(host.textContent).toContain("3 people want to join");
    expect(host.textContent).toContain("Ana, Ben and 1 more");

    await act(async () => button("View all").click());
    expect(onViewAll).toHaveBeenCalledTimes(1);

    await act(async () => button("Admit all").click());
    expect(emitted.map((entry) => entry.event)).toEqual(["admin:admitAllPending"]);
    await act(async () => emitted[0].ack(null, { error: "Rate limited" }));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Rate limited");
    expect(button("Admit all").disabled).toBe(false);
  });

  it("offers every action as a keyboard-reachable button", async () => {
    await render([["guest-1", "Bob"]]);
    const actions = Array.from(host.querySelectorAll("button"));
    expect(actions.map((action) => action.textContent)).toEqual(["Deny", "Admit"]);
    actions.forEach((action) => {
      expect(action.tabIndex).toBe(0);
      expect(action.type).toBe("button");
    });
  });
});
