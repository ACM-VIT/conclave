import { beforeEach, describe, expect, it, vi } from "vitest";

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
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      storeResponses: false,
      timeoutMs: 25_000,
      maxOutputTokens: 2_200,
      topicMaxLength: 120,
      webSearchEnabled: true,
      webSearchContextSize: "low",
    },
  },
}));

vi.mock("../utilities/loggers.js", () => ({
  Logger: { warn: vi.fn() },
}));

import { generateStructuredGameContent } from "../server/games/aiContent.js";

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
    });
    expect(createResponse).toHaveBeenCalledTimes(1);
    const [request, requestOptions] = createResponse.mock.calls[0];
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("Expected an OpenAI Responses request object.");
    }
    const requestRecord = request as Record<string, unknown>;
    const requestInput = requestRecord.input;
    const requestInstructions = requestRecord.instructions;
    if (typeof requestInput !== "string" || typeof requestInstructions !== "string") {
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
      max_output_tokens: 500,
      reasoning: { effort: "low" },
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
    expect(requestOptions).toEqual({ timeout: 60_000 });
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
    expect(requestOptions).toEqual({ timeout: 60_000 });
  });

  it("returns null when OpenAI does not return valid structured JSON", async () => {
    createResponse.mockResolvedValue({ output_text: "not-json" });

    const result = await generateStructuredGameContent({
      gameName: "Quick Draw",
      topic: "space",
      instructions: "Create one prompt.",
      schemaName: "quick_draw_prompts",
      schema,
      parse: (payload) => payload,
    });

    expect(result).toBeNull();
  });
});
