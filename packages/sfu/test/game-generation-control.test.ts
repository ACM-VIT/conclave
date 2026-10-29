import { afterEach, describe, expect, it, vi } from "vitest";
import { Admin } from "../config/classes/Admin.js";
import type { Room } from "../config/classes/Room.js";
import { RoomAiCredentials } from "../server/roomAiCredentials.js";
import { registerGameHandlers } from "../server/socket/handlers/gameHandlers.js";
import type { ConnectionContext } from "../server/socket/context.js";

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("../server/socket/rateLimit.js", () => ({
  takeToken: () => true,
  RATE_LIMITS: { gameControl: {} },
}));
vi.mock("../server/games/registry.js", () => ({
  getGameCatalog: () => [],
  getGameModule: () => ({
    id: "fixture",
    minPlayers: 1,
    maxPlayers: 10,
    options: [{ id: "topic", type: "text", label: "Topic", default: "" }],
    generateContent: generate,
  }),
}));

function fixture() {
  const on = vi.fn();
  const host = Object.defineProperties(Object.create(Admin.prototype), {
    id: { value: "host" },
    isObserver: { value: false },
  }) as Admin;
  const room = {
    clients: new Map([["host", host]]),
    userKeysById: new Map(),
    getDisplayNameForUser: () => "Host",
    aiCredentials: new RoomAiCredentials(),
    gameGeneration: null as Room["gameGeneration"],
    gameSession: null,
    clearGame: vi.fn(),
  };
  registerGameHandlers({
    socket: { on },
    io: { to: () => ({ emit: vi.fn() }) },
    currentRoom: room,
    currentClient: host,
  } as unknown as ConnectionContext);
  return {
    room,
    handlers: Object.fromEntries(on.mock.calls) as Record<
      string,
      (...args: unknown[]) => Promise<void>
    >,
  };
}
afterEach(() => {
  vi.unstubAllEnvs();
  generate.mockReset();
});
describe("pending game generation", () => {
  it("rejects a duplicate and aborts the original when the host cancels", async () => {
    const { room, handlers } = fixture();
    let signal!: AbortSignal;
    generate.mockImplementation(
      ({ signal: value }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal = value;
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const started = vi.fn();
    const pending = handlers["game:start"](
      { gameId: "fixture", options: { topic: "space" } },
      started,
    );
    const duplicate = vi.fn();
    await handlers["game:start"](
      { gameId: "fixture", options: { topic: "space" } },
      duplicate,
    );
    expect(duplicate).toHaveBeenCalledWith({
      success: false,
      error: "A game is already starting.",
    });
    expect(generate).toHaveBeenCalledTimes(1);
    const ended = vi.fn();
    await handlers["game:end"](ended);
    await pending;
    expect(signal.aborted).toBe(true);
    expect(started).toHaveBeenCalledWith({
      success: false,
      error: "Game creation cancelled.",
    });
    expect(room.gameSession).toBeNull();
    expect(room.gameGeneration).toBeNull();
  });
  it.each(["server", "room"])(
    "explains %s-disabled AI instead of asking for another key",
    async (scope) => {
      const { room, handlers } = fixture();
      generate.mockResolvedValue(null);
      if (scope === "server") vi.stubEnv("SFU_GAME_AI_ENABLED", "false");
      else
        room.aiCredentials.configureFeature(
          "games",
          { enabled: false },
          "host",
          true,
        );
      const ack =
        vi.fn<(value: { success: boolean; error?: string }) => void>();
      await handlers["game:start"](
        { gameId: "fixture", options: { topic: "space" } },
        ack,
      );
      expect(ack.mock.calls[0][0].error).toContain(
        scope === "server" ? "disabled on this server" : "Enable Games",
      );
      expect(ack.mock.calls[0][0].error).not.toContain("Add a room AI key");
      expect(room.gameGeneration).toBeNull();
    },
  );
});
