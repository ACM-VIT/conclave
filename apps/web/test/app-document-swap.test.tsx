// @vitest-environment happy-dom
import { act, useContext, useEffect, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Socket } from "socket.io-client";
import { GameProvider } from "@conclave/apps-sdk";
import { AppsContext, AppsProvider } from "../../../packages/apps-sdk/src/sdk/runtime/AppsProvider";
import { useAppDoc } from "../../../packages/apps-sdk/src/sdk/hooks/useAppDoc";
import { useApps } from "../../../packages/apps-sdk/src/sdk/hooks/useApps";
import { wheelApp } from "../../../packages/apps-sdk/src/apps/wheel/web/index";
import { addEntry, createWheelDoc, getEntries, getHistory, startSpin } from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";
import type { AppsContextValue } from "../../../packages/apps-sdk/src/sdk/types";
import MeetingAppLayout from "../src/app/components/MeetingAppLayout";

type Listener = (...args: unknown[]) => void;
type Ack = (response: unknown) => void;

let root: Root;
let ctx: AppsContextValue;
let listeners: Map<string, Set<Listener>>;
let uploads: Array<{ replicaId?: string; update: Uint8Array }>;
let pendingSyncs: Ack[];
let serverDoc: Y.Doc;
let answerSyncsAtOnce: boolean;

const contentOf = (doc: Y.Doc) => ({ syncMessage: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) });

const socketFor = (activeAppId: string) =>
  ({
    connected: true,
    on: (event: string, listener: Listener) => listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)),
    off: (event: string, listener: Listener) => listeners.get(event)?.delete(listener),
    emit: (event: string, payload?: unknown, ack?: Ack) => {
      if (event === "apps:getState" && typeof payload === "function") {
        (payload as Ack)({ activeAppId, locked: false });
        return;
      }
      if (event === "apps:yjs:update") uploads.push(payload as { replicaId?: string; update: Uint8Array });
      if (event !== "apps:yjs:sync" || typeof ack !== "function") return;
      if (answerSyncsAtOnce) ack(contentOf(serverDoc));
      else pendingSyncs.push(ack);
    },
  }) as unknown as Socket;

function Meeting({ app }: { app: ComponentType }) {
  ctx = useContext(AppsContext)!;
  const { documents, isRebuilding, rejectedChangeAt } = useApps();
  if (!ctx.state.activeAppId) return null;
  return (
    <MeetingAppLayout
      app={app}
      documentsVersion={documents.version}
      frozen={isRebuilding}
      rejectedChangeAt={rejectedChangeAt}
      localStream={null}
      isCameraOff
      isMuted
      isHandRaised={false}
      participants={new Map()}
      userEmail=""
      isMirrorCamera={false}
      activeSpeakerId={null}
      currentUserId="me"
      getDisplayName={() => "Me"}
    />
  );
}

const mount = async (activeAppId: string, app: ComponentType, apps = [{ id: activeAppId, name: activeAppId } as never]) => {
  await act(async () =>
    root.render(
      <GameProvider socket={null}>
        <AppsProvider socket={socketFor(activeAppId)} apps={apps} user={{ id: "me", name: "Me" }} isAdmin>
          <Meeting app={app} />
        </AppsProvider>
      </GameProvider>,
    ),
  );
};

const refuseLastChange = async (appId: string) => {
  const replicaId = uploads.at(-1)!.replicaId!;
  await act(async () => listeners.get("apps:yjs:refused")?.forEach((listener) => listener({ appId, replicaId, reason: "timed-out" })));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listeners = new Map();
  uploads = [];
  pendingSyncs = [];
  serverDoc = new Y.Doc();
  answerSyncsAtOnce = true;
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Revealer() {
  const { doc } = useAppDoc("board");
  useEffect(() => {
    const timer = setTimeout(() => doc.getText("t").insert(0, "revealed "), 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

it("restarts an app's pending work on the document that replaces a refused one", async () => {
  await mount("board", Revealer);
  const refused = ctx.getDoc("board");
  answerSyncsAtOnce = false;
  await act(async () => refused.getText("t").insert(0, "mine "));
  await refuseLastChange("board");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  await act(async () => pendingSyncs.shift()!(contentOf(serverDoc)));
  const replacement = ctx.getDoc("board");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });

  expect(replacement).not.toBe(refused);
  expect(replacement.getText("t").toString()).toBe("revealed ");
  expect(refused.getText("t").toString()).toBe("mine ");
});

it("runs an automatic write on the live copy, and waits while the app is being rebuilt", async () => {
  await mount("board", () => null);
  const refused = ctx.getDoc("board");
  await act(async () => ctx.documents.writeOnce("board", "first", (live) => live.getText("t").insert(0, "first ")));
  expect(refused.getText("t").toString()).toBe("first ");
  answerSyncsAtOnce = false;
  await act(async () => refused.getText("t").insert(0, "mine "));
  await refuseLastChange("board");
  const uploadsWhileRebuilding = uploads.length;

  await act(async () => ctx.documents.writeOnce("board", "second", (live) => live.getText("t").insert(0, "second ")));
  expect(refused.getText("t").toString()).not.toContain("second");
  expect(uploads).toHaveLength(uploadsWhileRebuilding);
  await act(async () => pendingSyncs.shift()!(contentOf(serverDoc)));

  expect(ctx.getDoc("board")).not.toBe(refused);
  expect(ctx.getDoc("board").getText("t").toString()).toContain("second ");
  expect(uploads.length).toBeGreaterThan(uploadsWhileRebuilding);
});

it("records the spinner's settled result when the wheel mounts and finds it unrecorded", async () => {
  serverDoc = createWheelDoc();
  addEntry(serverDoc, "Ada");
  addEntry(serverDoc, "Grace");
  startSpin(serverDoc, {
    spinId: "spin-1",
    entries: getEntries(serverDoc),
    winnerIndex: 1,
    startedAt: Date.now() - 10_000,
    durationMs: 4_000,
    turns: 4,
    jitter: 0.5,
    spunById: "me",
    spunByName: "Me",
  });

  await mount("wheel", wheelApp.web!, [wheelApp as never]);

  expect(getHistory(ctx.getDoc("wheel")).map((result) => result.spinId)).toEqual(["spin-1"]);
});

it("leaves another participant's unrecorded spin to them", async () => {
  serverDoc = createWheelDoc();
  addEntry(serverDoc, "Ada");
  addEntry(serverDoc, "Grace");
  startSpin(serverDoc, {
    spinId: "spin-2",
    entries: getEntries(serverDoc),
    winnerIndex: 0,
    startedAt: Date.now() - 10_000,
    durationMs: 4_000,
    turns: 4,
    jitter: 0.5,
    spunById: "someone-else",
    spunByName: "Someone",
  });

  await mount("wheel", wheelApp.web!, [wheelApp as never]);

  expect(getHistory(ctx.getDoc("wheel"))).toEqual([]);
});

it("runs each automatic write once per activation, again only after a passing refusal, and fresh after a reopen", async () => {
  await mount("board", () => null);
  let runs = 0;
  const reveal = () => ctx.documents.writeOnce("board", "reveal", (live) => {
    runs += 1;
    live.getMap("m").set("reveal", runs);
  });
  await act(async () => reveal());
  await act(async () => reveal());
  expect(runs).toBe(1);

  await refuseLastChange("board");
  expect(runs).toBe(2);
  await act(async () => reveal());
  expect(runs).toBe(2);
  await act(async () => listeners.get("apps:state")?.forEach((listener) => listener({ activeAppId: null, locked: false })));
  await act(async () => listeners.get("apps:state")?.forEach((listener) => listener({ activeAppId: "board", locked: false })));
  await act(async () => reveal());

  expect(runs).toBe(3);
});

it("tries a refused spin result once, says the app is full, and never sends it again after the rebuild", async () => {
  serverDoc = createWheelDoc();
  addEntry(serverDoc, "Ada");
  addEntry(serverDoc, "Grace");
  startSpin(serverDoc, {
    spinId: "spin-3",
    entries: getEntries(serverDoc),
    winnerIndex: 1,
    startedAt: Date.now() - 10_000,
    durationMs: 4_000,
    turns: 4,
    jitter: 0.5,
    spunById: "me",
    spunByName: "Me",
  });
  await mount("wheel", wheelApp.web!, [wheelApp as never]);
  expect(uploads).toHaveLength(1);
  const replicaId = uploads[0].replicaId!;

  await act(async () =>
    listeners.get("apps:yjs:refused")?.forEach((listener) => listener({ appId: "wheel", replicaId, reason: "too-large" })),
  );

  expect(ctx.syncStatus).toBe("synced");
  expect(getHistory(ctx.getDoc("wheel"))).toEqual([]);
  expect(uploads).toHaveLength(1);
  expect(ctx.rejectedChangeReason).toBe("too-large");
});

it("waits for the first sync before it runs an automatic write", async () => {
  answerSyncsAtOnce = false;
  await mount("board", () => null);
  await act(async () => ctx.documents.writeOnce("board", "early", (live) => live.getText("t").insert(0, "early ")));
  expect(ctx.getDoc("board").getText("t").toString()).toBe("");
  expect(uploads).toHaveLength(0);

  await act(async () => pendingSyncs.shift()!(contentOf(serverDoc)));

  expect(ctx.getDoc("board").getText("t").toString()).toBe("early ");
  expect(uploads).toHaveLength(1);
});

it("waits while the app is locked for someone who is not a host, and runs once it is unlocked", async () => {
  await act(async () =>
    root.render(
      <GameProvider socket={null}>
        <AppsProvider socket={socketFor("board")} apps={[{ id: "board", name: "board" } as never]} user={{ id: "me", name: "Me" }} isAdmin={false}>
          <Meeting app={() => null} />
        </AppsProvider>
      </GameProvider>,
    ),
  );
  await act(async () => listeners.get("apps:state")?.forEach((listener) => listener({ activeAppId: "board", locked: true })));
  await act(async () => ctx.documents.writeOnce("board", "locked", (live) => live.getText("t").insert(0, "later ")));
  expect(ctx.getDoc("board").getText("t").toString()).toBe("");

  await act(async () => listeners.get("apps:state")?.forEach((listener) => listener({ activeAppId: "board", locked: false })));

  expect(ctx.getDoc("board").getText("t").toString()).toBe("later ");
  expect(uploads).toHaveLength(1);
});

it("gives up on an automatic write after three attempts refused for passing reasons", async () => {
  await mount("board", () => null);
  let runs = 0;
  await act(async () =>
    ctx.documents.writeOnce("board", "stubborn", (live) => {
      runs += 1;
      live.getMap("m").set("try", runs);
    }),
  );

  for (let refusal = 0; refusal < 5; refusal += 1) await refuseLastChange("board");

  expect(runs).toBe(3);
});
