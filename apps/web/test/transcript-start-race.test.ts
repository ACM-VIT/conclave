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
  ...(await original<typeof import("@conclave/ai/room-server")>()),
  fetchRoomAiEnvironment: lookup,
}));
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
  responseApiKey: string | null;
  responseEnvironment: Env | null;
  personalResponseKeys: Record<string, string>;
  minutesGenerating: boolean;
  minutesRerunRequested: boolean;
  scheduleMinutes: ReturnType<typeof vi.fn>;
};
async function fixture(env: Partial<Env> = {}) {
  const room = new TranscriptRoom(
    {
      storage: { get: async () => undefined, delete: async () => true },
      waitUntil: () => undefined,
    } as unknown as DurableObjectState,
    env as Env,
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

it("uses the SFU account and endpoint for routed notes even when the Worker has its own keys", async () => {
  const { room, viewer } = await fixture({
    OPENAI_API_KEY: "sk-worker",
    ANTHROPIC_API_KEY: "sk-ant-worker",
    ANTHROPIC_BASE_URL: "https://worker.example",
    CLOUDFLARE_AI_GATEWAY_ANTHROPIC_URL: "https://worker-gateway.example",
  });
  lookup.mockResolvedValue({
    OPENAI_API_KEY: "sk-room",
    ANTHROPIC_API_KEY: "sk-ant-room",
    ANTHROPIC_BASE_URL: "https://room.example",
  });
  await room.startSession(viewer, { ...message, qaModel: "claude-sonnet-5-6" });
  expect(room.session?.status).toBe("live");
  expect(room.connectTranscriptionProvider).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: "sk-room" }),
  );
  expect(room.responseApiKey).toBe("sk-ant-room");
  expect(room.responseEnvironment).toMatchObject({
    ANTHROPIC_API_KEY: "sk-ant-room",
    ANTHROPIC_BASE_URL: "https://room.example",
    CLOUDFLARE_AI_GATEWAY_ANTHROPIC_URL: "",
  });
  const messages = (
    viewer.socket.send as ReturnType<typeof vi.fn>
  ).mock.calls.map(([raw]) => JSON.parse(raw));
  expect(
    messages.find((message) => message.type === "session.state")
      ?.globalProviderKeysAvailable,
  ).toEqual({ openai: false, anthropic: false, sarvam: false });
});

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

it("starts independent notes when the disabled questions provider has no key", async () => {
  const {room, viewer} = await fixture();
  lookup.mockResolvedValue({SARVAM_API_KEY: "sarvam-fixture", ANTHROPIC_API_KEY: "sk-ant-room", CONCLAVE_AI_SETTINGS: JSON.stringify({questions: {enabled: false, model: "gpt-6.1-sol"}, minutes: {model: "claude-haiku-5-5"}})});
  await room.startSession(viewer, {...message, transcriptModel: "saaras:v3"});
  expect(room.session?.status).toBe("live");
  expect(room.responseApiKey).toBeNull();
  expect(room.sendError).not.toHaveBeenCalled();
});
it("keeps a personal questions key isolated from another provider's room minutes key", async () => {
  const {room, viewer} = await fixture();
  lookup.mockResolvedValue({SARVAM_API_KEY: "sarvam-fixture", OPENAI_API_KEY: "sk-openai-minutes", CONCLAVE_AI_SETTINGS: JSON.stringify({questions: {model: "claude-haiku-5-5"}, minutes: {model: "gpt-6.1-sol"}})});
  await room.startSession(viewer, {...message, transcriptModel: "saaras:v3", qaModel: "claude-haiku-5-5", assistantApiKey: "sk-ant-personal"});
  expect(room.session?.status).toBe("live");
  expect(room.responseApiKey).toBe("sk-ant-personal");
  expect(room.sendError).not.toHaveBeenCalled();
});

it("retains both personal response providers for mixed OpenAI minutes and Claude questions", async () => {
  const {room, viewer} = await fixture();
  lookup.mockResolvedValue({CONCLAVE_AI_SETTINGS: JSON.stringify({questions: {model: "claude-haiku-5-5"}, minutes: {model: "gpt-6.1-sol"}})});
  await room.startSession(viewer, {...message, qaModel: "claude-haiku-5-5", apiKey: "sk-openai-personal", assistantApiKey: "sk-ant-personal"});
  expect(room.session?.status).toBe("live");
  expect(room.personalResponseKeys).toEqual({openai: "sk-openai-personal", anthropic: "sk-ant-personal"});
  expect(room.sendError).not.toHaveBeenCalled();
});

it("unlocks and reschedules cancelled minutes when the controller takes over a live session", async () => {
  const {room, viewer} = await fixture();
  lookup.mockResolvedValue({OPENAI_API_KEY: "sk-room"});
  await room.startSession(viewer, message);
  room.minutesGenerating = true;
  room.minutesRerunRequested = true;
  room.scheduleMinutes = vi.fn();
  await room.startSession(viewer, {...message, type: "session.takeover"});
  expect(room.session?.status).toBe("live");
  expect(room.minutesGenerating).toBe(false);
  expect(room.minutesRerunRequested).toBe(false);
  expect(room.scheduleMinutes).toHaveBeenCalledTimes(1);
});
