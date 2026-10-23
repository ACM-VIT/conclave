import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAiTextSession,
  generateAiText,
  type AiTextOptions,
} from "../src/server.js";
import {
  AI_DEFAULT_MODELS,
  getProviderApiKey,
  getResponseProvider,
  resolveConfiguredResponseModel,
} from "../src/models.js";

const options: AiTextOptions = {
  env: {},
  apiKey: "sk-ant-fixture",
  model: "claude-sonnet-5-5",
  instructions: "Use meeting evidence only.",
  maxOutputTokens: 4096,
};
const message = (content: unknown[], stopReason = "end_turn") => ({
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  model: options.model,
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});
const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const sse = (events: Record<string, unknown>[]) =>
  new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
const claudeEvents = (
  content: Record<string, unknown>[],
  stopReason: string,
) => [
  { type: "message_start", message: message([], stopReason) },
  ...content.flatMap((block, index) => [
    { type: "content_block_start", index, content_block: block },
    { type: "content_block_stop", index },
  ]),
  {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 10 },
  },
  { type: "message_stop" },
];

afterEach(() => vi.unstubAllGlobals());

describe("provider routing", () => {
  it("verifies newly discovered Claude models and honors their token limit before generation", async () => {
    const requests: { url: string; body?: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : undefined;
        requests.push({ url: String(url), body });
        if (String(url).includes("/models"))
          return json({
            data: [
              {
                id: "claude-sonnet-5-6",
                max_tokens: 1024,
                capabilities: {
                  structured_outputs: { supported: true },
                  server_tools: { web_search: { supported: true } },
                },
              },
            ],
          });
        return json(message([{ type: "text", text: "OK" }]));
      }),
    );
    expect(
      await generateAiText({
        ...options,
        model: "claude-sonnet-5-6",
        input: "Reply OK",
      }),
    ).toBe("OK");
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toContain("/models");
    expect(requests[1].body).toMatchObject({
      model: "claude-sonnet-5-6",
      max_tokens: 1024,
    });
  });

  it("refuses an unavailable discovered model before sending an inference request", async () => {
    const fetcher = vi.fn(async () => json({ data: [] }));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      generateAiText({
        ...options,
        model: "claude-sonnet-5-6",
        input: "Hello",
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps defaults stable and resolves only the selected provider's key", () => {
    const env = {
      OPENAI_API_KEY: "openai-secret",
      ANTHROPIC_API_KEY: " claude-secret ",
    };
    expect(AI_DEFAULT_MODELS.assistant).toBe("gpt-6.1-sol");
    expect(getProviderApiKey(env, getResponseProvider("claude-opus-5-5"))).toBe(
      "claude-secret",
    );
    expect(
      getProviderApiKey({ OPENAI_API_KEY: "openai-secret" }, "anthropic"),
    ).toBe("");
    expect(() =>
      resolveConfiguredResponseModel("typo", AI_DEFAULT_MODELS.games),
    ).toThrow("Unsupported AI response model");
  });

  it("uses Claude authentication and its own gateway for structured minutes", async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        json(message([{ type: "text", text: '{"summary":"Done"}' }])),
    );
    vi.stubGlobal("fetch", fetcher);
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { summary: { type: "string", maxLength: 100 } },
      required: ["summary"],
    };
    expect(
      await generateAiText({
        ...options,
        env: {
          CLOUDFLARE_AI_GATEWAY_ANTHROPIC_URL:
            "https://gateway.example/anthropic/",
          OPENAI_BASE_URL: "https://wrong.example",
        },
        input: "The team agreed.",
        format: { name: "minutes", schema },
      }),
    ).toBe('{"summary":"Done"}');
    const request = new Request(
      ...(fetcher.mock.calls[0] as unknown as [RequestInfo, RequestInit]),
    );
    expect(request.url).toBe("https://gateway.example/anthropic/v1/messages");
    expect(request.headers.get("authorization")).toBe(
      `Bearer ${options.apiKey}`,
    );
    const body = (await request.json()) as {
      output_config: {
        format: {
          schema: {
            properties: {
              summary: { maxLength?: number; description: string };
            };
          };
        };
      };
    };
    expect(
      body.output_config.format.schema.properties.summary.maxLength,
    ).toBeUndefined();
    expect(
      body.output_config.format.schema.properties.summary.description,
    ).toContain("maxLength");
    expect(schema.properties.summary.maxLength).toBe(100);
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("store");
  });

  it("separates Claude search citations from strict game output", async () => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return json(
          message([
            {
              type: "text",
              text:
                requests.length === 1
                  ? "Research notes"
                  : '{"prompts":["Moon"]}',
            },
          ]),
        );
      }),
    );
    await generateAiText({
      ...options,
      input: "Make a space quiz",
      tools: [{ type: "web_search" }],
      format: { name: "game", schema: { type: "object", properties: {} } },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveProperty("tools.0.type", "web_search_20250305");
    expect(requests[0]).not.toHaveProperty("output_config");
    expect(requests[1]).toHaveProperty(
      "output_config.format.type",
      "json_schema",
    );
    expect(requests[1]).not.toHaveProperty("tools");
    expect(JSON.stringify(requests[1].messages)).toContain("Research notes");
  });

  it("shares one absolute deadline across Claude research and structured output", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        ++calls;
        if (calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          return json(message([{ type: "text", text: "Research notes" }]));
        }
        return new Promise<Response>((_resolve, reject) => {
          const timer = setTimeout(
            () =>
              _resolve(json(message([{ type: "text", text: '{"ok":true}' }]))),
            120,
          );
          const abort = () => {
            clearTimeout(timer);
            reject(new Error("Aborted"));
          };
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener("abort", abort, { once: true });
        });
      }),
    );
    const started = Date.now();
    await expect(
      generateAiText({
        ...options,
        timeoutMs: 200,
        input: "Make a quiz",
        tools: [{ type: "web_search" }],
        format: { name: "game", schema: { type: "object", properties: {} } },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("preserves OpenAI web search queries in public activity events", async () => {
    const item = {
      type: "web_search_call",
      id: "search_1",
      status: "completed",
      action: { type: "search", query: "conclave meeting tools" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          {
            type: "response.created",
            sequence_number: 0,
            response: {
              id: "resp_1",
              object: "response",
              status: "in_progress",
              output: [],
            },
          },
          {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item,
          },
          {
            type: "response.output_item.done",
            sequence_number: 2,
            output_index: 0,
            item,
          },
          {
            type: "response.completed",
            sequence_number: 3,
            response: {
              id: "resp_1",
              object: "response",
              status: "completed",
              output: [item],
            },
          },
        ]),
      ),
    );
    const events = await collect(
      createAiTextSession({
        ...options,
        model: "gpt-5.6-luna",
        apiKey: "sk-openai-fixture",
      }).stream("Search"),
    );
    expect(events).toContainEqual({
      type: "activity",
      id: "search_1",
      kind: "web_search",
      status: "done",
      query: "conclave meeting tools",
    });
  });

  it("replays Claude tool results with the original signed thinking blocks", async () => {
    const requests: Record<string, unknown>[] = [];
    const content = [
      {
        type: "thinking",
        thinking: "private model reasoning",
        signature: "signed-thinking",
      },
      {
        type: "tool_use",
        id: "tool_1",
        name: "get_meeting_transcript",
        input: {},
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return sse(
          claudeEvents(
            requests.length === 1
              ? content
              : [{ type: "text", text: "Ada owns the task." }],
            requests.length === 1 ? "tool_use" : "end_turn",
          ),
        );
      }),
    );
    const session = createAiTextSession({
      ...options,
      tools: [
        {
          type: "function",
          name: "get_meeting_transcript",
          parameters: { type: "object", properties: {} },
          strict: true,
        },
      ],
    });
    const first = await collect(session.stream("Who owns the task?"));
    expect(first.at(-1)).toMatchObject({
      type: "complete",
      calls: [
        { id: "tool_1", name: "get_meeting_transcript", arguments: "{}" },
      ],
    });
    expect(JSON.stringify(first)).not.toContain("private model reasoning");
    const second = await collect(
      session.stream([{ id: "tool_1", output: "Ada: I will do it." }]),
    );
    expect(second.at(-1)).toEqual({
      type: "complete",
      text: "Ada owns the task.",
      calls: [],
    });
    expect(requests[1].messages).toEqual([
      { role: "user", content: "Who owns the task?" },
      { role: "assistant", content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: "Ada: I will do it.",
          },
        ],
      },
    ]);
  });

  it("fails incomplete and rejected responses without switching providers", async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        json(message([{ type: "text", text: "partial" }], "max_tokens")),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      generateAiText({ ...options, input: "Summarize" }),
    ).rejects.toThrow("did not finish");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "Invalid key" },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(
      generateAiText({ ...options, input: "Summarize" }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses OpenAI endpoint settings and keeps provider-specific request controls", async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        json({
          id: "resp_1",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Done" }],
            },
          ],
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await generateAiText({
        ...options,
        apiKey: "sk-openai-fixture",
        model: "gpt-5.6-luna",
        env: { OPENAI_BASE_URL: "https://openai.example/v1/" },
        reasoningEffort: "low",
        verbosity: "low",
        input: "Summarize",
      }),
    ).toBe("Done");
    const request = new Request(
      ...(fetcher.mock.calls[0] as unknown as [RequestInfo, RequestInit]),
    );
    expect(request.url).toBe("https://openai.example/v1/responses");
    expect(request.headers.get("authorization")).toBe(
      "Bearer sk-openai-fixture",
    );
    expect(await request.json()).toMatchObject({
      store: false,
      reasoning: { effort: "low" },
      text: { verbosity: "low" },
    });
  });

  it("streams OpenAI answers and replays function calls without persisting responses", async () => {
    const requests: Record<string, unknown>[] = [];
    const call = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "get_meeting_transcript",
      arguments: "{}",
      status: "completed",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        const output =
          requests.length === 1
            ? [call]
            : [
                {
                  type: "message",
                  id: "msg_2",
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text: "Ada owns it.",
                      annotations: [],
                    },
                  ],
                },
              ];
        return sse([
          {
            type: "response.created",
            sequence_number: 0,
            response: {
              id: "resp_1",
              object: "response",
              status: "in_progress",
              output: [],
            },
          },
          {
            type: "response.completed",
            sequence_number: 1,
            response: {
              id: "resp_1",
              object: "response",
              status: "completed",
              output,
            },
          },
        ]);
      }),
    );
    const session = createAiTextSession({
      ...options,
      model: "gpt-5.6-luna",
      apiKey: "sk-openai-fixture",
    });
    expect(
      (await collect(session.stream("Who owns it?"))).at(-1),
    ).toMatchObject({
      type: "complete",
      calls: [
        { id: "call_1", name: "get_meeting_transcript", arguments: "{}" },
      ],
    });
    expect(
      (
        await collect(
          session.stream([{ id: "call_1", output: "Ada owns it." }]),
        )
      ).at(-1),
    ).toEqual({ type: "complete", text: "Ada owns it.", calls: [] });
    expect(requests[1].input).toEqual([
      { role: "user", content: "Who owns it?" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_meeting_transcript",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "Ada owns it.",
      },
    ]);
    expect(requests[1].store).toBe(false);
  });
});
