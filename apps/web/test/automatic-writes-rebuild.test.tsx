// @vitest-environment happy-dom
import { act, useContext, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Socket } from "socket.io-client";
import { GameProvider } from "@conclave/apps-sdk";
import { AppsContext, AppsProvider } from "../../../packages/apps-sdk/src/sdk/runtime/AppsProvider";
import { useApps } from "../../../packages/apps-sdk/src/sdk/hooks/useApps";
import { useAppDoc } from "../../../packages/apps-sdk/src/sdk/hooks/useAppDoc";
import { wheelApp } from "../../../packages/apps-sdk/src/apps/wheel/web/index";
import { addEntry, createWheelDoc, getEntries, getHistory, setRemoveWinnerOnDone, startSpin } from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";
import { useSyncedPlayback } from "../../../packages/apps-sdk/src/apps/watch/web/hooks/useSyncedPlayback";
import { createWatchDoc, enqueue, getPlayback, getQueue, getVideoId, setVideo, writePlayback } from "../../../packages/apps-sdk/src/apps/watch/core/doc/index";
import type { AppsContextValue } from "../../../packages/apps-sdk/src/sdk/types";
import MeetingAppLayout from "../src/app/components/MeetingAppLayout";

type Listener = (...args: unknown[]) => void;
type Ack = (response: unknown) => void;
type Refusal = { reason: string; matches: (after: Y.Doc, before: Y.Doc) => boolean };

let root: Root;
let ctx: AppsContextValue;

const fakeSfu = (appId: string, serverDoc: Y.Doc) => {
  const listeners = new Map<string, Set<Listener>>();
  const refusedReplicas = new Set<string>();
  const pendingRefusals: Array<{ appId: string; replicaId: string; reason: string }> = [];
  const heldSyncs: Ack[] = [];
  const state = { refusals: [] as Refusal[], holdSyncs: false, refusalsSent: 0 };
  const reply = () => ({ syncMessage: Y.encodeStateAsUpdate(serverDoc), stateVector: Y.encodeStateVector(serverDoc) });
  const socket = {
    connected: true,
    on: (event: string, listener: Listener) => listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)),
    off: (event: string, listener: Listener) => listeners.get(event)?.delete(listener),
    emit: (event: string, payload?: unknown, ack?: Ack) => {
      if (event === "apps:getState" && typeof payload === "function") {
        (payload as Ack)({ activeAppId: appId, locked: false });
        return;
      }
      if (event === "apps:yjs:sync" && typeof ack === "function") {
        if (state.holdSyncs) heldSyncs.push(ack);
        else ack(reply());
        return;
      }
      if (event !== "apps:yjs:update") return;
      const { update, replicaId } = payload as { update: Uint8Array; replicaId: string };
      if (refusedReplicas.has(replicaId)) return;
      const after = new Y.Doc();
      Y.applyUpdate(after, Y.encodeStateAsUpdate(serverDoc));
      Y.applyUpdate(after, update);
      const refusal = state.refusals.find((candidate) => candidate.matches(after, serverDoc));
      if (refusal) {
        state.refusals = state.refusals.filter((candidate) => candidate !== refusal);
        refusedReplicas.add(replicaId);
        pendingRefusals.push({ appId, replicaId, reason: refusal.reason });
        return;
      }
      Y.applyUpdate(serverDoc, update);
    },
  } as unknown as Socket;
  return {
    socket,
    state,
    refuseNext: (reason: string, matches: (after: Y.Doc, before: Y.Doc) => boolean = () => true) => {
      state.refusals.push({ reason, matches });
    },
    deliverRefusals: async () => {
      const deliveries = pendingRefusals.splice(0);
      state.refusalsSent += deliveries.length;
      await act(async () => {
        for (const delivery of deliveries) listeners.get("apps:yjs:refused")?.forEach((listener) => listener(delivery));
      });
    },
    releaseSyncs: async () => {
      state.holdSyncs = false;
      await act(async () => {
        for (const ack of heldSyncs.splice(0)) ack(reply());
      });
    },
  };
};

function Meeting({ app }: { app: ComponentType }) {
  ctx = useContext(AppsContext)!;
  const { documents, isRebuilding, rejectedChangeAt, rejectedChangeReason } = useApps();
  if (!ctx.state.activeAppId) return null;
  return (
    <MeetingAppLayout
      app={app}
      documentsVersion={documents.version}
      frozen={isRebuilding}
      rejectedChangeAt={rejectedChangeAt}
      rejectedChangeReason={rejectedChangeReason}
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

const mount = async (socket: Socket, app: ComponentType, apps: never[]) => {
  await act(async () =>
    root.render(
      <GameProvider socket={null}>
        <AppsProvider socket={socket} apps={apps} user={{ id: "me", name: "Me" }} isAdmin>
          <Meeting app={app} />
        </AppsProvider>
      </GameProvider>,
    ),
  );
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "requestAnimationFrame", "cancelAnimationFrame"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const SPIN_MS = 1_000;
const RESULT = "result-spin";

const wheelServer = () => {
  const server = createWheelDoc();
  addEntry(server, "Ada");
  addEntry(server, "Grace");
  return server;
};

const startOwnSpin = async (sfu: ReturnType<typeof fakeSfu>) => {
  await act(async () =>
    startSpin(ctx.getDoc("wheel"), {
      spinId: RESULT,
      entries: getEntries(ctx.getDoc("wheel")),
      winnerIndex: 1,
      startedAt: Date.now(),
      durationMs: SPIN_MS,
      turns: 2,
      jitter: 0.5,
      spunById: "me",
      spunByName: "Me",
    }),
  );
  void sfu;
};

const refuseAnUnrelatedEdit = async (sfu: ReturnType<typeof fakeSfu>, reason: string) => {
  sfu.refuseNext(reason, (after) => getEntries(after).some((entry) => entry.label === "Unsaved"));
  await act(async () => addEntry(ctx.getDoc("wheel"), "Unsaved"));
};

const resultsOn = (doc: Y.Doc) => getHistory(doc).filter((result) => result.spinId === RESULT).length;
const addsTheResult = (after: Y.Doc, before: Y.Doc) => resultsOn(after) > resultsOn(before);

type WheelStep = (sfu: ReturnType<typeof fakeSfu>) => Promise<void>;
const WHEEL_SWEEP: Array<{ point: string; run: WheelStep; saved: 0 | 1 }> = [
  {
    point: "before the spin lands",
    saved: 1,
    run: async (sfu) => {
      await advance(SPIN_MS / 2);
      await refuseAnUnrelatedEdit(sfu, "timed-out");
      await sfu.deliverRefusals();
      await advance(SPIN_MS + 2_000);
    },
  },
  {
    point: "during the reveal delay",
    saved: 1,
    run: async (sfu) => {
      await advance(SPIN_MS + 100);
      await refuseAnUnrelatedEdit(sfu, "timed-out");
      await sfu.deliverRefusals();
      await advance(2_000);
    },
  },
  {
    point: "while the reveal timer fires and the rebuild is still waiting",
    saved: 1,
    run: async (sfu) => {
      await advance(SPIN_MS + 100);
      sfu.state.holdSyncs = true;
      await refuseAnUnrelatedEdit(sfu, "timed-out");
      await sfu.deliverRefusals();
      await advance(2_000);
      expect(ctx.isRebuilding).toBe(true);
      await sfu.releaseSyncs();
      await advance(100);
    },
  },
  {
    point: "on the result write itself, for a passing reason",
    saved: 1,
    run: async (sfu) => {
      sfu.refuseNext("timed-out", addsTheResult);
      await advance(SPIN_MS + 2_000);
      await sfu.deliverRefusals();
      await advance(2_000);
    },
  },
  {
    point: "on the result write itself, because the document is full",
    saved: 0,
    run: async (sfu) => {
      sfu.refuseNext("too-large", addsTheResult);
      await advance(SPIN_MS + 2_000);
      await sfu.deliverRefusals();
      await advance(2_000);
    },
  },
  {
    point: "after the result is saved",
    saved: 1,
    run: async (sfu) => {
      await advance(SPIN_MS + 2_000);
      await refuseAnUnrelatedEdit(sfu, "timed-out");
      await sfu.deliverRefusals();
      await advance(2_000);
    },
  },
];

describe("wheel results under refusals", () => {
  it.each(WHEEL_SWEEP)("save the spinner's result $saved time(s) when a refusal lands $point", async ({ run, saved }) => {
    const server = wheelServer();
    const sfu = fakeSfu("wheel", server);
    await mount(sfu.socket, wheelApp.web!, [wheelApp as never]);
    await startOwnSpin(sfu);

    await run(sfu);
    await advance(10_000);

    expect(resultsOn(server)).toBe(saved);
    expect(resultsOn(ctx.getDoc("wheel"))).toBe(saved);
    expect(ctx.isRebuilding).toBe(false);
    expect(sfu.state.refusalsSent).toBe(1);
  });
});

let player: ReturnType<typeof useSyncedPlayback>;

function WatchPlayer() {
  const { documents } = useApps();
  const { doc } = useAppDoc("watch");
  player = useSyncedPlayback({
    doc,
    videoId: getVideoId(doc),
    readOnly: false,
    writeOnce: (key, write) => documents.writeOnce("watch", key, write),
  });
  return null;
}

const watchServer = () => {
  const server = createWatchDoc();
  setVideo(server, "first", { play: true });
  enqueue(server, { videoId: "second" }, { userId: "me", userName: "Me" });
  enqueue(server, { videoId: "third" }, { userId: "me", userName: "Me" });
  return server;
};

const advanceRefusedWith = (reason: string) => (sfu: ReturnType<typeof fakeSfu>) =>
  sfu.refuseNext(reason, (after, before) => getVideoId(after) !== getVideoId(before));

type WatchStep = (sfu: ReturnType<typeof fakeSfu>) => Promise<void>;
const WATCH_SWEEP: Array<{ point: string; run: WatchStep; playing: string }> = [
  {
    point: "while a rebuild is waiting when the video ends",
    playing: "second",
    run: async (sfu) => {
      sfu.state.holdSyncs = true;
      sfu.refuseNext("timed-out", (after) => after.getMap("scratch").get("note") === "Unsaved");
      await act(async () => ctx.getDoc("watch").getMap("scratch").set("note", "Unsaved"));
      await sfu.deliverRefusals();
      await act(async () => player.onEnded());
      await sfu.releaseSyncs();
    },
  },
  {
    point: "on the advance itself, for a passing reason",
    playing: "second",
    run: async (sfu) => {
      advanceRefusedWith("timed-out")(sfu);
      await act(async () => player.onEnded());
      await sfu.deliverRefusals();
    },
  },
  {
    point: "on the advance itself, because the document is full",
    playing: "first",
    run: async (sfu) => {
      advanceRefusedWith("too-large")(sfu);
      await act(async () => player.onEnded());
      await sfu.deliverRefusals();
      await act(async () => player.onEnded());
    },
  },
  {
    point: "after the advance is saved",
    playing: "second",
    run: async (sfu) => {
      await act(async () => player.onEnded());
      sfu.refuseNext("timed-out", (after) => after.getMap("scratch").get("note") === "Unsaved");
      await act(async () => ctx.getDoc("watch").getMap("scratch").set("note", "Unsaved"));
      await sfu.deliverRefusals();
    },
  },
];

describe("watch auto-advance under refusals", () => {
  it.each(WATCH_SWEEP)("advances once and never loops when a refusal lands $point", async ({ run, playing }) => {
    const server = watchServer();
    const sfu = fakeSfu("watch", server);
    await mount(sfu.socket, WatchPlayer, [{ id: "watch", name: "Watch" } as never]);

    await run(sfu);
    await advance(5_000);

    expect(getVideoId(server)).toBe(playing);
    expect(getVideoId(ctx.getDoc("watch"))).toBe(playing);
    expect(getQueue(server).map((item) => item.videoId)).toEqual(playing === "first" ? ["second", "third"] : ["third"]);
    expect(sfu.state.refusalsSent).toBe(1);
    expect(ctx.isRebuilding).toBe(false);
  });

  it("does not repeat a refused advance when the app asks for it again after the rebuild", async () => {
    const server = watchServer();
    const sfu = fakeSfu("watch", server);
    await mount(sfu.socket, WatchPlayer, [{ id: "watch", name: "Watch" } as never]);
    sfu.refuseNext("too-large", (after) => after.getMap("scratch").get("advance") === "third");
    const key = "ended:first:again";
    await act(async () => ctx.documents.writeOnce("watch", key, (live) => live.getMap("scratch").set("advance", "third")));
    await sfu.deliverRefusals();

    await act(async () => ctx.documents.writeOnce("watch", key, (live) => live.getMap("scratch").set("advance", "third")));
    await advance(5_000);

    expect(sfu.state.refusalsSent).toBe(1);
    expect(server.getMap("scratch").get("advance")).toBeUndefined();
    expect(ctx.rejectedChangeReason).toBe("too-large");
  });
});

describe("automatic writes decided against an older state", () => {
  it("save a wheel result and its winner's removal together, even when the server refuses the removal", async () => {
    const server = wheelServer();
    setRemoveWinnerOnDone(server, true);
    const sfu = fakeSfu("wheel", server);
    await mount(sfu.socket, wheelApp.web!, [wheelApp as never]);
    await startOwnSpin(sfu);
    sfu.refuseNext("rate-limited", (after, before) => getEntries(after).length < getEntries(before).length);

    await advance(SPIN_MS + 2_000);
    await sfu.deliverRefusals();
    await advance(10_000);

    expect(sfu.state.refusalsSent).toBe(1);
    expect(resultsOn(server)).toBe(1);
    expect(getEntries(server).map((entry) => entry.label)).toEqual(["Ada"]);
    expect(getEntries(ctx.getDoc("wheel")).map((entry) => entry.label)).toEqual(["Ada"]);
  });

  it("do not pause a replay with an end action the server already saved", async () => {
    const server = createWatchDoc();
    setVideo(server, "first", { play: true });
    const sfu = fakeSfu("watch", server);
    await mount(sfu.socket, WatchPlayer, [{ id: "watch", name: "Watch" } as never]);
    await act(async () => player.onEnded());
    expect(getPlayback(server).state).toBe("paused");

    await advance(1_000);
    await act(async () => writePlayback(ctx.getDoc("watch"), { state: "playing", positionSeconds: 0 }));
    sfu.refuseNext("timed-out", (after) => after.getMap("scratch").get("note") === "Unsaved");
    await act(async () => ctx.getDoc("watch").getMap("scratch").set("note", "Unsaved"));
    await sfu.deliverRefusals();
    await advance(5_000);

    expect(sfu.state.refusalsSent).toBe(1);
    expect(getPlayback(server).state).toBe("playing");
    expect(getPlayback(ctx.getDoc("watch")).state).toBe("playing");
  });

  it("skip a refused end action when someone replays the video before the rebuild lands", async () => {
    const server = createWatchDoc();
    setVideo(server, "first", { play: true });
    const sfu = fakeSfu("watch", server);
    await mount(sfu.socket, WatchPlayer, [{ id: "watch", name: "Watch" } as never]);
    sfu.state.holdSyncs = true;
    sfu.refuseNext("timed-out");
    await act(async () => player.onEnded());
    await sfu.deliverRefusals();
    await advance(1_000);
    writePlayback(server, { state: "playing", positionSeconds: 0 });

    await sfu.releaseSyncs();
    await advance(5_000);

    expect(getPlayback(server).state).toBe("playing");
    expect(getPlayback(ctx.getDoc("watch")).state).toBe("playing");
  });

  it("never run a saved automatic write again after an unrelated refusal", async () => {
    const server = createWatchDoc();
    const sfu = fakeSfu("watch", server);
    await mount(sfu.socket, WatchPlayer, [{ id: "watch", name: "Watch" } as never]);
    let runs = 0;
    await act(async () =>
      ctx.documents.writeOnce("watch", "count", (live) => {
        runs += 1;
        live.getMap("scratch").set("runs", runs);
      }),
    );
    expect(server.getMap("scratch").get("runs")).toBe(1);

    sfu.refuseNext("timed-out", (after) => after.getMap("scratch").get("note") === "Unsaved");
    await act(async () => ctx.getDoc("watch").getMap("scratch").set("note", "Unsaved"));
    await sfu.deliverRefusals();
    await advance(5_000);

    expect(runs).toBe(1);
    expect(server.getMap("scratch").get("runs")).toBe(1);
  });
});
