import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createResponse, openAiConstructor } = vi.hoisted(() => ({
  createResponse:
    vi.fn<
      (request: unknown, options?: unknown) => Promise<{ output_text: string }>
    >(),
  openAiConstructor: vi.fn<(options: unknown) => void>(),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    readonly responses = { create: createResponse };

    constructor(options: unknown) {
      openAiConstructor(options);
    }
  },
}));

vi.mock("../config/config.js", () => ({
  config: {
    openAi: {
      apiKey: "test-openai-key",
      maxRetries: 2,
    },
    gameAi: {
      enabled: true,
      apiKey: "test-openai-key",
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      storeResponses: false,
      timeoutMs: 25_000,
      maxOutputTokens: 4_096,
      topicMaxLength: 120,
      webSearchEnabled: true,
      webSearchContextSize: "low",
    },
  },
}));

vi.mock("../utilities/loggers.js", () => ({
  Logger: { warn: vi.fn() },
}));

import { config } from "../config/config.js";
import { generateStructuredGameContent } from "../server/games/aiContent.js";
import { getGameCatalog, getGameModule } from "../server/games/registry.js";
import type { GameConfig } from "../server/games/types.js";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    prompts: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["prompts"],
};

describe("game AI content", () => {
  beforeEach(() => {
    createResponse.mockReset();
    openAiConstructor.mockClear();
    config.gameAi.apiKey = "test-openai-key";
    config.gameAi.timeoutMs = 25_000;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(["openai", "anthropic"] as const)(
    "loads generated content for every AI game at maximum rounds with %s",
    async (provider) => {
      const players = Array.from({ length: 12 }, (_, i) => ({
        id: `p${i}`,
        name: `Player ${i}`,
      }));
      const aiGames = getGameCatalog().filter(
          (game) => typeof getGameModule(game.id)?.generateContent === "function",
      );
      expect(aiGames.map((game) => game.id).sort()).toEqual(
        [
          "bluff",
          "imposter",
          "most-likely-to",
          "trivia",
          "would-you-rather",
        ].sort(),
      );
      expect(getGameCatalog().length - aiGames.length).toBe(4);
      for (const game of aiGames) {
        const module = getGameModule(game.id)!;
        const gameConfig: GameConfig = Object.fromEntries(
          game.options.map((option) => [
            option.id,
            option.type === "number" ? option.max : option.default,
          ]),
        );
        const count = Number(gameConfig.questions ?? gameConfig.rounds ?? 12);
        const payload =
          game.id === "trivia"
            ? {
                questions: Array.from({ length: count }, (_, i) => ({
                  category: "Fixture",
                  prompt: `Fixture question ${i}`,
                  options: ["Moon", "Earth", "Sun", "Mars"],
                  answer: "Moon",
                })),
              }
            : game.id === "imposter"
              ? {
                  set: {
                    category: "Fixture",
                    words: Array.from(
                      { length: 12 },
                      (_, i) => `Fixture word ${i}`,
                    ),
                  },
                }
              : {
                  prompts: Array.from({ length: count }, (_, i) =>
                    game.id === "bluff"
                      ? {
                          question: `Fixture fact ${i}: ___`,
                          answer: `Answer ${i}`,
                        }
                      : game.id === "would-you-rather"
                        ? {
                            a: `Fixture choice A ${i}`,
                            b: `Fixture choice B ${i}`,
                          }
                        : `to make fixture ${i}`,
                  ),
                };
        const model =
          provider === "anthropic" ? "claude-haiku-5-5" : "gpt-6-luna";
        createResponse.mockResolvedValue({
          output_text: JSON.stringify(payload),
        });
        const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          const research = !body.output_config;
          expect(body.max_tokens).toBeGreaterThanOrEqual(1024);
          return Response.json({
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            model,
            content: [
              {
                type: "text",
                text: research ? "Fixture notes" : JSON.stringify(payload),
              },
            ],
            stop_reason: research ? "max_tokens" : "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        });
        vi.stubGlobal("fetch", fetcher);
        const content = await module.generateContent!({
          players,
          config: gameConfig,
          now: 0,
          aiEnvironment: {
            CONCLAVE_ASSISTANT_MODEL: model,
            [provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"]:
              "sk-fixture-game-key",
          },
        });
        expect(content, game.id).not.toBeNull();
        const state = module.setup({
          players,
          activePlayers: players,
          rng: {
            next: () => 0,
            int: () => 0,
            shuffle: (items) => [...items],
            pick: (items) => items[0],
          },
          config: gameConfig,
          content,
          now: 0,
          isAdmin: () => true,
        });
        expect(JSON.stringify(state).toLowerCase(), game.id).toContain(
          "fixture",
        );
        if (provider === "anthropic") expect(fetcher).toHaveBeenCalledTimes(2);
        if (provider === "openai" && game.id === "trivia")
          expect(createResponse.mock.calls.at(-1)?.[0]).toHaveProperty(
            "max_output_tokens",
            3700,
          );
      }
    },
  );

  it("uses the room's Claude model and key even when deployment games use OpenAI", async () => {
    let count = 0;
    const fetcher = vi.fn(async () =>
      Response.json({
        id: "msg_game",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [
          {
            type: "text",
            text:
              count++ === 0
                ? "Moon is a suitable prompt."
                : '{"prompts":["Moon"]}',
          },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await generateStructuredGameContent({
      aiEnvironment: {
        ANTHROPIC_API_KEY: "sk-ant-room-game",
        CONCLAVE_ASSISTANT_MODEL: "claude-haiku-5-5",
      },
      gameName: "Quick Draw",
      topic: "space",
      instructions: "Create one prompt.",
      schemaName: "game",
      schema,
      parse: (payload) => payload,
    });
    expect(result).toEqual({ prompts: ["Moon"] });
    expect(createResponse).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const args of fetcher.mock.calls as unknown as [
      RequestInfo | URL,
      RequestInit,
    ][]) {
      const request = new Request(args[0], args[1]);
      expect(request.headers.get("authorization")).toBe(
        "Bearer sk-ant-room-game",
      );
      const body = (await request.json()) as { model: string };
      expect(body.model).toBe("claude-haiku-5-5");
    }
  });

  it("uses a room key when deployment AI is absent and caps the entire operation below the client acknowledgement", async () => {
    config.gameAi.apiKey = "";
    config.gameAi.timeoutMs = 120_000;
    createResponse.mockResolvedValue({ output_text: '{"prompts":["Moon"]}' });
    const request = {
      aiEnvironment: { OPENAI_API_KEY: "sk-room-game" },
      gameName: "Quick Draw",
      topic: "space",
      instructions: "Create one prompt.",
      schemaName: "game",
      schema,
      parse: (payload: unknown) => payload,
    };
    expect(await generateStructuredGameContent(request)).toEqual({
      prompts: ["Moon"],
    });
    expect(openAiConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-room-game" }),
    );
    expect(createResponse.mock.calls[0][1]).toHaveProperty("timeout", 35_000);
    vi.stubEnv("SFU_GAME_AI_ENABLED", "false");
    createResponse.mockClear();
    expect(await generateStructuredGameContent(request)).toBeNull();
    expect(createResponse).not.toHaveBeenCalled();
  });

  it("lets the model decide when to use web search", async () => {
    createResponse.mockResolvedValue({
      output_text: JSON.stringify({ prompts: ["Moon bases"] }),
    });

    const result = await generateStructuredGameContent({
      gameName: "Quick Draw",
      topic: "latest space news",
      instructions: "Create one prompt.",
      schemaName: "quick_draw_prompts",
      schema,
      maxOutputTokens: 500,
      parse: (payload) => payload,
    });

    expect(result).toEqual({ prompts: ["Moon bases"] });
    expect(openAiConstructor).toHaveBeenCalledWith({
      apiKey: "test-openai-key",
      maxRetries: 2,
      baseURL: undefined,
    });
    expect(createResponse).toHaveBeenCalledTimes(1);
    const [request, requestOptions] = createResponse.mock.calls[0];
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("Expected an OpenAI Responses request object.");
    }
    const requestRecord = request as Record<string, unknown>;
    const requestInput = requestRecord.input;
    const requestInstructions = requestRecord.instructions;
    if (
      typeof requestInput !== "string" ||
      typeof requestInstructions !== "string"
    ) {
      throw new Error("Expected string input and instructions.");
    }
    expect(requestInput).toContain("Topic: latest space news");
    expect(requestInstructions).toContain(
      "You create high-quality party-game content",
    );
    expect(requestInstructions).toContain(
      "Decide for yourself whether searching would materially improve",
    );
    expect(requestInstructions).toMatch(
      /Current date and day \(UTC\): \d{4}-\d{2}-\d{2}, [A-Za-z]+\.$/,
    );
    expect(requestRecord).toMatchObject({
      model: "gpt-5.6-luna",
      max_output_tokens: 1024,
      reasoning: { effort: "low", summary: "auto" },
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "quick_draw_prompts",
          schema,
          strict: true,
        },
      },
      tools: [{ type: "web_search", search_context_size: "low" }],
    });
    expect(request).not.toHaveProperty("tool_choice");
    expect(requestOptions).toHaveProperty("timeout", 25_000);
    expect((requestOptions as { signal: AbortSignal }).signal).toBeInstanceOf(
      AbortSignal,
    );
  });

  it("offers the same optional web search for evergreen topics", async () => {
    createResponse.mockResolvedValue({
      output_text: JSON.stringify({ prompts: ["Draw a moon base"] }),
    });

    await generateStructuredGameContent({
      gameName: "Quick Draw",
      topic: "space",
      instructions: "Create one prompt.",
      schemaName: "quick_draw_prompts",
      schema,
      parse: (payload) => payload,
    });

    const [request, requestOptions] = createResponse.mock.calls[0];
    expect(request).not.toHaveProperty("tool_choice");
    expect(request).toHaveProperty("tools", [
      { type: "web_search", search_context_size: "low" },
    ]);
    expect(requestOptions).toHaveProperty("timeout", 25_000);
    expect((requestOptions as { signal: AbortSignal }).signal).toBeInstanceOf(
      AbortSignal,
    );
  });

  it("reports invalid structured JSON instead of silently starting bundled questions", async () => {
    createResponse.mockResolvedValue({ output_text: "not-json" });

    const result = generateStructuredGameContent({
      gameName: "Quick Draw",
      topic: "space",
      instructions: "Create one prompt.",
      schemaName: "quick_draw_prompts",
      schema,
      parse: (payload) => payload,
    });

    await expect(result).rejects.toThrow("Questions were incomplete");
  });

  it("logs redacted provider diagnostics and returns an actionable error", async () => {
    createResponse.mockRejectedValue(
      Object.assign(new Error("Rejected sk-secret-fixture"), { status: 401 }),
    );
    await expect(
      generateStructuredGameContent({
        aiEnvironment: { OPENAI_API_KEY: "sk-secret-fixture" },
        gameName: "Trivia",
        topic: "space",
        instructions: "Make questions",
        schemaName: "game",
        schema,
        parse: (payload) => payload,
      }),
    ).rejects.toThrow("OpenAI rejected the API key");
    const { Logger } = await import("../utilities/loggers.js");
    expect(JSON.stringify(vi.mocked(Logger.warn).mock.calls)).not.toContain(
      "sk-secret-fixture",
    );
  });
});
