import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAiModelCatalog } from "../src/catalog-server.js";
import { getResponseProvider, isResponseModel } from "../src/models.js";

afterEach(() => vi.unstubAllGlobals());
const capabilities = {
  structured_outputs: { supported: true },
  server_tools: { web_search: { supported: true } },
};

describe("provider model discovery", () => {
  it("discovers new Responses family models while excluding unrelated, retired and duplicate snapshot IDs", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        data: [
          { id: "gpt-6.2-sol", created: 200 },
          { id: "gpt-6.2-sol-2026-10-24", created: 201 },
          { id: "gpt-6-luna", created: 100 },
          { id: "gpt-6-astra", shutdown_date: "2000-01-01" },
          { id: "gpt-image-2.5-sunburst" },
          { id: "gpt-realtime-2.1" },
          { id: "text-embedding-3-large" },
          { id: "claude-haiku-5-5" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const catalog = await fetchAiModelCatalog({
      provider: "openai",
      apiKey: "sk-fixture",
      env: {},
    });
    expect(catalog.source).toBe("live");
    expect(catalog.models.map((model) => model.id)).toEqual([
      "gpt-6.2-sol",
      "gpt-6-luna",
    ]);
    expect(getResponseProvider("gpt-6.2-sol")).toBe("openai");
    expect(catalog.models[0]).toMatchObject({
      label: "GPT-6.2 Sol",
      supportsReasoning: false,
      supportsStructuredOutputs: true,
    });
    expect(catalog.models[0]).not.toHaveProperty("qaReasoningEffort");
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://api.openai.com/v1/models"),
      expect.objectContaining({
        redirect: "manual",
        cache: "no-store",
        headers: { authorization: "Bearer sk-fixture" },
      }),
    );
  });

  it("follows Claude pagination and uses capability and output-limit metadata for new models", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: "claude-sonnet-5-6",
              display_name: "Claude Sonnet 5.6",
              capabilities,
              max_tokens: 2048,
              created_at: "2026-10-24",
            },
            { id: "claude-haiku-5-5", lifecycle: "retired" },
            {
              id: "claude-fable-5-2",
              capabilities: {
                ...capabilities,
                structured_outputs: { supported: false },
              },
            },
          ],
          has_more: true,
          last_id: "cursor",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [
            { id: "claude-opus-5-5", capabilities, created_at: "2026-09-01" },
          ],
          has_more: false,
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const catalog = await fetchAiModelCatalog({
      provider: "anthropic",
      apiKey: "sk-ant-fixture",
      env: {},
    });
    expect(catalog.models.map((model) => model.id)).toEqual([
      "claude-sonnet-5-6",
      "claude-opus-5-5",
    ]);
    expect(catalog.models[0]).toMatchObject({
      label: "Claude Sonnet 5.6",
      provider: "anthropic",
      qaMaxOutputTokens: 2048,
      minutesMaxOutputTokens: 2048,
    });
    expect(getResponseProvider("claude-sonnet-5-6")).toBe("anthropic");
    expect(String(fetcher.mock.calls[1][0])).toContain("after_id=cursor");
    expect(isResponseModel("claude/../../admin")).toBe(false);
  });

  it("keeps inference-only keys usable and marks built-in choices when listing is forbidden", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 })),
    );
    const catalog = await fetchAiModelCatalog({
      provider: "openai",
      apiKey: "sk-inference-only",
      env: {},
    });
    expect(catalog).toMatchObject({
      source: "built-in",
      error: expect.stringContaining("cannot list models") as unknown,
    });
    expect(catalog.models.map((model) => model.id)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-luna",
      "gpt-6-astra",
    ]);
  });

  it("does not replace an account's empty compatible list with unavailable built-ins", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [{ id: "gpt-image-2" }] })),
    );
    expect(
      await fetchAiModelCatalog({
        provider: "openai",
        apiKey: "sk-fixture",
        env: {},
      }),
    ).toMatchObject({ source: "live", models: [] });
  });

  it("refuses redirects without following or logging the credential", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example/models" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const catalog = await fetchAiModelCatalog({
      provider: "anthropic",
      apiKey: "sk-ant-private",
      env: {},
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(catalog.source).toBe("built-in");
    expect(JSON.stringify(catalog)).not.toContain("sk-ant-private");
  });
});
