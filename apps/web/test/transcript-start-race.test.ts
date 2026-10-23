import { afterEach, expect, it, vi } from "vitest";
import { TranscriptRoom } from "../transcript-worker/src/room";
import type {
  Env,
  Viewer,
  SessionStartEnvelope,
} from "../transcript-worker/src/types";
import type { TranscriptSessionState } from "@conclave/meeting-core/transcript-types";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("@conclave/ai/room-server", async (original) => ({
  ...await original<typeof import("@conclave/ai/room-server")>(), fetchRoomAiEnvironment: lookup }));
afterEach(() => vi.resetAllMocks());

type TestRoom = {
  loaded: Promise<void>;
  session: TranscriptSessionState | null;
  viewers: Map<WebSocket, Viewer>;
  startSession: (
    viewer: Viewer,
    message: SessionStartEnvelope,
  ) => Promise<void>;
  stopSession: (viewer: Viewer) => Promise<void>;
  connectTranscriptionProvider: ReturnType<typeof vi.fn>;
  sendSfuRelayStartToken: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
  sendError: ReturnType<typeof vi.fn>;
};
async function fixture() {
  const room = new TranscriptRoom(
    {
      storage: { get: async () => undefined, delete: async () => true },
      waitUntil: () => undefined,
    } as unknown as DurableObjectState,
    {} as Env,
  ) as unknown as TestRoom;
  await room.loaded;
  room.connectTranscriptionProvider = vi.fn().mockResolvedValue(undefined);
  room.sendSfuRelayStartToken = vi.fn().mockResolvedValue(undefined);
  room.persist = vi.fn().mockResolvedValue(undefined);
  room.sendError = vi.fn();
  const viewer = {
    id: "host",
    userId: "host",
    displayName: "Host",
    socket: { send: vi.fn() },
    sfuUrl: "https://sfu.example",
    clientId: "client",
    channelId: "channel",
    capabilities: { start: true, stop: true, takeover: true },
  } as unknown as Viewer;
  room.viewers.set(viewer.socket, viewer);
  return { room, viewer };
}
const message: SessionStartEnvelope = {
  type: "session.start",
  transcriptModel: "gpt-live-transcribe",
  qaModel: "gpt-5.6-terra",
  transportMode: "sfu",
};

it("does not restart stopped notes when an older key lookup completes after a start and stop", async () => {
  const { room, viewer } = await fixture();
  let resolveSlow!: (value: { OPENAI_API_KEY: string }) => void;
  lookup.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveSlow = resolve;
    }),
  );
  lookup.mockResolvedValueOnce({ OPENAI_API_KEY: "sk-fixture" });
  const slow = room.startSession(viewer, message);
  await room.startSession(viewer, message);
  expect(room.session?.status).toBe("live");
  await room.stopSession(viewer);
  resolveSlow({ OPENAI_API_KEY: "sk-fixture" });
  await slow;
  expect(room.session?.status).toBe("idle");
  expect(room.connectTranscriptionProvider).toHaveBeenCalledTimes(1);
  expect(room.sendError).toHaveBeenCalledWith(
    viewer,
    expect.stringContaining("Notes changed"),
  );
});

it("does not let a rejected key cancel another participant's pending valid start", async () => {
  const { room, viewer } = await fixture();
  let resolveSlow!: (value: { OPENAI_API_KEY: string }) => void;
  lookup.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveSlow = resolve;
    }),
  );
  lookup.mockResolvedValueOnce({});
  const validStart = room.startSession(viewer, message);
  await room.startSession(viewer, { ...message, apiKey: "invalid" });
  expect(room.connectTranscriptionProvider).not.toHaveBeenCalled();
  resolveSlow({ OPENAI_API_KEY: "sk-fixture" });
  await validStart;
  expect(room.session?.status).toBe("live");
  expect(room.connectTranscriptionProvider).toHaveBeenCalledTimes(1);
});
