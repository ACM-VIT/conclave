import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { POST } from "../src/app/api/conclave/assistant/route";

const { createSession, stream, roomEnvironment } = vi.hoisted(() => ({
  createSession: vi.fn(),
  stream: vi.fn(),
  roomEnvironment: vi.fn(),
}));
vi.mock("@conclave/ai/room-server", async (original) => ({
  ...(await original<typeof import("@conclave/ai/room-server")>()),
  fetchRoomAiEnvironment: roomEnvironment,
}));
vi.mock("@conclave/ai/server", async (original) => ({
  ...(await original<typeof import("@conclave/ai/server")>()),
  createAiTextSession: createSession,
}));

const request = (
  body: Record<string, unknown> = {},
  isAdmin = false,
  sfuUrl?: string,
) => {
  const token = jwt.sign(
    {
      tokenUse: "conclave:assistant",
      answerId: "answer",
      questionMessageId: "question",
      userId: "user",
      roomId: "room",
      clientId: "client",
      channelId: "channel",
      isAdmin,
      ...(sfuUrl ? { sfuUrl } : {}),
    },
    "fixture-secret",
    {
      algorithm: "HS256",
      audience: "conclave-web",
      issuer: "conclave-sfu",
      expiresIn: "1m",
    },
  );
  return new Request("http://localhost/api/conclave/assistant", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      answerId: "answer",
      question: "What did we decide?",
      ...body,
    }),
  });
};
beforeEach(() => {
  vi.stubEnv("SFU_SECRET", "fixture-secret");
  vi.stubEnv("OPENAI_API_KEY", "sk-server-openai");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-server");
  vi.stubEnv("CONCLAVE_ASSISTANT_MODEL", "");
  roomEnvironment.mockReset().mockResolvedValue({});
  createSession.mockReset().mockReturnValue({ stream });
  stream.mockReset().mockImplementation(async function* () {
    yield { type: "complete", text: "Done", calls: [] };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("assistant provider integration", () => {
  it.each([undefined, "sk-ant-personal"])(
    "uses the room profile for routed inference with personal override %s",
    async (personalKey) => {
      vi.stubEnv("ANTHROPIC_BASE_URL", "https://worker-account.example");
      vi.stubEnv(
        "CLOUDFLARE_AI_GATEWAY_ANTHROPIC_URL",
        "https://worker-gateway.example",
      );
      roomEnvironment.mockResolvedValue({
        ANTHROPIC_API_KEY: "sk-ant-room",
        ANTHROPIC_BASE_URL: "https://room-account.example",
      });
      const response = await POST(
        request(
          {
            model: "claude-haiku-5-5",
            ...(personalKey ? { apiKey: personalKey } : {}),
          },
          false,
          "https://sfu.example",
        ),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(roomEnvironment).toHaveBeenCalled();
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: personalKey ?? "sk-ant-room",
          env: expect.objectContaining({
            ANTHROPIC_API_KEY: "sk-ant-room",
            ANTHROPIC_BASE_URL: "https://room-account.example",
            CLOUDFLARE_AI_GATEWAY_ANTHROPIC_URL: "",
          }),
        }),
      );
    },
  );

  it("does not fall back to a Worker account when a routed room profile cannot be loaded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    roomEnvironment.mockRejectedValue(new Error("Unavailable"));
    try {
      const response = await POST(
        request(
          { model: "claude-haiku-5-5", apiKey: "sk-ant-personal" },
          false,
          "https://sfu.example",
        ),
      );
      expect(response.status).toBe(503);
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("uses single-type enum branches for Claude's nullable browser direction", async () => {
    const response = await POST(request({ model: "claude-haiku-5-5" }, true));
    await response.text();
    const tool = createSession.mock.calls[0][0].tools.find(
      (entry: { name?: string }) => entry.name === "control_shared_browser",
    );
    // Anthropic rejects an enum alongside type: ["string", "null"] with 400.
    // Keep the enum on the string branch and null on its own branch.
    expect(tool.parameters.properties.direction).toEqual({
      anyOf: [{ type: "string", enum: ["up", "down"] }, { type: "null" }],
      description: "Scroll direction, or null.",
    });
  });

  it("skips room lookup when an explicit model and its deployment key are known", async () => {
    roomEnvironment.mockRejectedValue(new Error("Room lookup is unavailable"));
    const response = await POST(request({ model: "claude-haiku-5-5" }));
    await response.text();
    expect(roomEnvironment).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-5-5",
        apiKey: "sk-ant-server",
      }),
    );
  });

  it("reports a local tool limit after repeated successful tool responses", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    stream.mockImplementation(async function* () {
      yield {
        type: "complete",
        text: "",
        calls: [
          {
            id: "transcript-call",
            name: "get_meeting_transcript",
            arguments: "{}",
          },
        ],
      };
    });
    try {
      const response = await POST(
        request({
          model: "claude-haiku-5-5",
          transcriptActive: true,
          transcript: "Notes",
        }),
      );
      const frames = await response.text();
      expect(frames).toContain("reached its tool limit");
      expect(frames).not.toContain("could not reach Anthropic");
      expect(stream).toHaveBeenCalledTimes(12);
    } finally {
      log.mockRestore();
    }
  });

  it("logs safe lookup diagnostics without logging secrets or failing a deployment-backed answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    roomEnvironment.mockRejectedValue(
      new TypeError("fixture-secret in request headers"),
    );
    try {
      const response = await POST(request());
      await response.text();
      expect(warn).toHaveBeenCalledWith(
        "[Conclave] room AI lookup failed:",
        '{"name":"TypeError"}',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("fixture-secret");
      expect(createSession).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("uses the room's selected Claude model without a personal selection or an OpenAI key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    roomEnvironment.mockResolvedValue({
      ANTHROPIC_API_KEY: "sk-ant-room",
      CONCLAVE_ASSISTANT_MODEL: "claude-haiku-5-5",
    });
    const response = await POST(request());
    await response.text();
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-5-5",
        apiKey: "sk-ant-room",
      }),
    );
  });

  it("reports a rejected provider key and logs redacted plain diagnostics", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    stream.mockImplementation(async function* () {
      yield* [];
      throw Object.assign(new Error("Rejected sk-ant-participant"), {
        status: 401,
        request_id: "req_fixture",
      });
    });
    try {
      const response = await POST(
        request({ model: "claude-sonnet-5-5", apiKey: "sk-ant-participant" }),
      );
      const frames = await response.text();
      expect(frames).toContain("Anthropic rejected the API key");
      expect(log.mock.calls[0][1]).toContain('"status":401');
      expect(log.mock.calls[0][1]).toContain("req_fixture");
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        "sk-ant-participant",
      );
    } finally {
      log.mockRestore();
    }
  });

  it("honors explicit Claude BYOK even when a shared OpenAI key exists", async () => {
    const response = await POST(
      request({ model: "claude-sonnet-5-5", apiKey: "sk-ant-participant" }),
    );
    await response.text();
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-5-5",
        apiKey: "sk-ant-participant",
      }),
    );
    const args = createSession.mock.calls[0][0] as {
      tools: { name?: string }[];
    };
    expect(
      args.tools.some((tool) => tool.name === "control_shared_browser"),
    ).toBe(false);
    expect(args.tools.some((tool) => tool.name === "create_github_issue")).toBe(
      false,
    );
  });

  it("uses the configured shared provider and reports its missing key", async () => {
    vi.stubEnv("CONCLAVE_ASSISTANT_MODEL", "claude-haiku-5-5");
    let response = await POST(request());
    await response.text();
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-5-5",
        apiKey: "sk-ant-server",
      }),
    );
    createSession.mockClear();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    response = await POST(request());
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("Anthropic"),
      model: "claude-haiku-5-5",
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("honors a selected room provider without a personal key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    roomEnvironment.mockResolvedValue({ ANTHROPIC_API_KEY: "sk-ant-room" });
    const response = await POST(request({ model: "claude-sonnet-5-5" }));
    expect(response.status).toBe(200);
    await response.text();
    expect(roomEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: ["openai", "anthropic"],
        identity: {
          roomId: "room",
          clientId: "client",
          channelId: "channel",
          userId: "user",
        },
      }),
    );
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-5-5",
        apiKey: "sk-ant-room",
      }),
    );
  });

  it("continues function tools using the same provider and still pauses GitHub writes for approval", async () => {
    stream
      .mockImplementationOnce(async function* () {
        yield {
          type: "complete",
          text: "",
          calls: [
            {
              id: "transcript-call",
              name: "get_meeting_transcript",
              arguments: "{}",
            },
          ],
        };
      })
      .mockImplementationOnce(async function* () {
        yield {
          type: "complete",
          text: "",
          calls: [
            {
              id: "issue-call",
              name: "create_github_issue",
              arguments: JSON.stringify({
                title: "Fix audio",
                body: "Audio fails",
              }),
            },
          ],
        };
      });
    const response = await POST(
      request({
        model: "claude-sonnet-5-5",
        apiKey: "sk-ant-participant",
        supportsToolApproval: true,
        transcriptActive: true,
        transcript: "Ada: Fix audio.",
      }),
    );
    const frames = await response.text();
    expect(stream).toHaveBeenCalledTimes(2);
    expect(stream.mock.calls[1][0]).toEqual([
      {
        id: "transcript-call",
        output: expect.stringContaining("Ada: Fix audio."),
      },
    ]);
    expect(frames).toContain('"type":"approval"');
    expect(frames).not.toContain('"type":"done"');
  });
});
