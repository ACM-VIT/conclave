// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import type {Socket} from "socket.io-client";
import {GameProvider, useGame} from "../../../packages/apps-sdk/src/games/GameProvider";
import type {GameContextValue} from "../../../packages/apps-sdk/src/games/types";

afterEach(() => {vi.unstubAllGlobals(); vi.useRealTimers();});

it("does not let a delayed earlier Cancel abort a retried game", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const starts: ((value: unknown) => void)[] = [], ends: ((value: unknown) => void)[] = [];
  const socket = {connected: true, on: vi.fn(), off: vi.fn(), emit: (event: string, ...args: unknown[]) => {
    if (event === "game:start") starts.push(args.at(-1) as (value: unknown) => void);
    if (event === "game:end") ends.push(args.at(-1) as (value: unknown) => void);
  }};
  let game!: GameContextValue;
  function Harness() {game = useGame(); return null;}
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<GameProvider socket={socket as unknown as Socket}><Harness /></GameProvider>));
  const original = game.startGame("trivia");
  const firstCancel = game.endGame(), secondCancel = game.endGame();
  ends[0]({success: true});
  await firstCancel;
  expect(await original).toMatchObject({success: false});
  const retry = game.startGame("trivia");
  let finished = false;
  void retry.then(() => {finished = true;});
  ends[1]({success: true});
  await secondCancel;
  expect(finished).toBe(false);
  starts[1]({success: true});
  expect(await retry).toMatchObject({success: true});
  await act(async () => root.unmount());
});
it.each(["disconnect", "cancel", "unmount"])("settles a pending game start on %s and ignores late acknowledgements", async (action) => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const acks: ((value: unknown) => void)[] = [];
  const socket = {
    connected: true,
    on: (event: string, handler: (...args: unknown[]) => void) => {if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(handler);},
    off: (event: string, handler: (...args: unknown[]) => void) => {listeners.get(event)?.delete(handler);},
    emit: (event: string, ...args: unknown[]) => {
      if (event === "game:start") acks.push(args.at(-1) as (value: unknown) => void);
      if (event === "game:end") (args.at(-1) as (value: unknown) => void)({success: true});
    },
  };
  let game!: GameContextValue;
  function Harness() {game = useGame(); return null;}
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<GameProvider socket={socket as unknown as Socket}><Harness /></GameProvider>));
  const pending = game.startGame("trivia");
  const finished = vi.fn();
  void pending.then(finished);
  if (action === "disconnect") {
    socket.connected = false;
    for (const handler of [...listeners.get("disconnect")!]) handler();
  } else if (action === "cancel") await game.endGame();
  else await act(async () => root.unmount());
  expect(await pending).toMatchObject({success: false});
  acks[0]({success: true});
  await Promise.resolve();
  expect(finished).toHaveBeenCalledTimes(1);
  expect(listeners.get("disconnect")?.size ?? 0).toBe(0);
  if (action !== "unmount") {
    socket.connected = true;
    const retry = game.startGame("trivia");
    acks[1]({success: true});
    expect(await retry).toMatchObject({success: true});
    await act(async () => root.unmount());
  }
  expect(vi.getTimerCount()).toBe(0);
});
