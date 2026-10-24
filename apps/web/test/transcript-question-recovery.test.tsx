// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import {useMeetingTranscript} from "../src/app/hooks/useMeetingTranscript";
import type {TranscriptSessionState} from "@conclave/meeting-core/transcript-types";

afterEach(() => {vi.unstubAllGlobals(); vi.useRealTimers();});
it.each(["idle", "starting", "takeover_needed", "error", "disconnect", "controller reconnect"])("handles an active question during %s", async reason => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({id: "fixture"})));
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (event: {data: string}) => void;
    sent: {type: string; id: string}[] = [];
    constructor() {sockets.push(this); void Promise.resolve().then(() => this.onopen?.());}
    send(raw: string) {this.sent.push(JSON.parse(raw));}
    close() {this.readyState = 3; this.onclose?.();}
    frame(message: unknown) {this.onmessage?.({data: JSON.stringify(message)});}
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  const participants = new Map();
  const token = async () => ({roomId: "room", workerUrl: "https://transcript.example", token: "fixture", expiresAt: Date.now()+60000, capabilities: {ask: true, start: true, stop: true, takeover: true}});
  const display = () => "Ada";
  let controller!: ReturnType<typeof useMeetingTranscript>;
  function Harness() {
    controller = useMeetingTranscript({roomId: "room", isJoined: true, currentUserId: "alice", currentDisplayName: "Alice", isMuted: true, localStream: null, participants, activeSpeakerId: null, resolveDisplayName: display, getTranscriptToken: token});
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  const live = {roomId: "room", status: "live", controller: {userId: "host", connectionId: "host-1"}, transcriptModel: "gpt-live-transcribe", qaModel: "gpt-6.1-sol", transportMode: "sfu", startedAt: 1, updatedAt: 1} as TranscriptSessionState;
  await act(async () => sockets[0].frame({type: "session.state", session: live}));
  await act(async () => {expect(await controller.ask("First question")).toBe(true);});
  const first = sockets[0].sent.find(message => message.type === "qa.ask")!;
  await act(async () => sockets[0].frame({type: "qa.delta", id: first.id, question: "First question", answer: "Partial answer"}));
  expect(controller.qaMessages.some(message => message.status === "streaming")).toBe(true);
  if (reason === "controller reconnect") {
    await act(async () => sockets[0].frame({type: "session.state", session: {...live, controller: {...live.controller, connectionId: "host-2"}}}));
    expect(controller.qaMessages.at(-1)).toMatchObject({content: "Partial answer", status: "streaming"});
    await act(async () => sockets[0].frame({type: "qa.final", id: first.id, question: "First question", answer: "Completed answer", status: "done"}));
    expect(controller.qaMessages.at(-1)).toMatchObject({content: "Completed answer", status: "done"});
    await act(async () => root.unmount());
    return;
  }
  if (reason === "disconnect") {
    await act(async () => {sockets[0].close(); await vi.advanceTimersByTimeAsync(500);});
  } else await act(async () => sockets[0].frame({type: "session.state", session: {...live, status: reason, updatedAt: 2}}));
  expect(controller.qaMessages.some(message => message.status === "streaming")).toBe(false);
  expect(controller.qaMessages.at(-1)).toMatchObject({content: "Partial answer", status: "error"});
  const socket = sockets.at(-1)!;
  await act(async () => socket.frame({type: "session.state", session: live}));
  await act(async () => {expect(await controller.ask("Next question")).toBe(true);});
  const second = socket.sent.filter(message => message.type === "qa.ask").at(-1)!;
  await act(async () => socket.frame({type: "qa.final", id: second.id, question: "Next question", answer: "Recovered answer", status: "done"}));
  expect(controller.qaMessages.at(-1)).toMatchObject({content: "Recovered answer", status: "done"});
  expect(controller.qaMessages.some(message => message.status === "streaming")).toBe(false);
  await act(async () => root.unmount());
});
