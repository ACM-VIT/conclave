import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { config, normalizeClientPolicies } from "../config/config.js";
import { loadTestClientPolicies } from "../scripts/load-test-policy.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import type { SfuAuthPayload } from "../server/socket/auth.js";
import { createConnectionContext, setSocketContext } from "../server/socket/context.js";
import { registerDisconnectHandlers } from "../server/socket/handlers/disconnectHandlers.js";
import { registerJoinRoomHandler } from "../server/socket/handlers/joinRoom.js";
import { createSfuState, type SfuState } from "../server/state.js";

type Handler = (...args: unknown[]) => unknown;
const LOAD_CLIENT = "load-test-client";
const kept = config.clientPolicies[LOAD_CLIENT];

afterEach(() => {
  if (kept) config.clientPolicies[LOAD_CLIENT] = kept;
  else delete config.clientPolicies[LOAD_CLIENT];
});

const makeState = (): SfuState => {
  const router = {
    closed: false,
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    close: () => undefined,
  } as unknown as Router;
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: "load-test",
      instanceUrl: "http://localhost",
      ttlMs: 45_000,
    }),
  });
  state.workers = [{ pid: 1, closed: false, createRouter: async () => router } as unknown as Worker];
  return state;
};

const io = {
  to: () => ({ emit: () => true }),
  in: () => ({ disconnectSockets: () => undefined }),
} as unknown as SocketIOServer;

const join = async (state: SfuState, user: SfuAuthPayload): Promise<string | undefined> => {
  const handlers = new Map<string, Handler>();
  const socket = {
    id: `${user.userId}-tab`,
    data: { user },
    connected: true,
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    emit: () => true,
    disconnect: () => undefined,
    join: () => undefined,
    leave: () => undefined,
    to: () => ({ emit: () => true }),
  } as unknown as Socket;
  const context = createConnectionContext(io, socket, state);
  setSocketContext(socket, context);
  registerJoinRoomHandler(context);
  registerDisconnectHandlers(context);
  let status: string | undefined;
  await handlers.get("joinRoom")?.(
    { roomId: "load-room", sessionId: user.sessionId },
    (response: { status?: string; error?: string }) => {
      status = response.status ?? response.error;
    },
  );
  return status;
};

const host = {
  userId: "load-host",
  clientId: LOAD_CLIENT,
  sessionId: "h",
  allowRoomCreation: true,
} satisfies SfuAuthPayload;
const participant = { userId: "load-participant", clientId: LOAD_CLIENT, sessionId: "p" } satisfies SfuAuthPayload;

describe("the load benchmarks' client policy", () => {
  it("lets every participant straight in, whatever the default policy makes people do", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    config.clientPolicies[LOAD_CLIENT] = normalizeClientPolicies(loadTestClientPolicies(LOAD_CLIENT))[LOAD_CLIENT];
    const state = makeState();
    expect(await join(state, host)).toBe("joined");
    expect(await join(state, participant)).toBe("joined");
  });

  it("would leave a participant waiting under the default policy", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    config.clientPolicies[LOAD_CLIENT] = normalizeClientPolicies("")[LOAD_CLIENT] ?? config.clientPolicies.default;
    const state = makeState();
    expect(await join(state, host)).toBe("joined");
    expect(await join(state, participant)).toBe("waiting");
  });
});
