import {
  AI_PROVIDERS,
  AI_RESPONSE_MODELS,
  getTranscriptResponseModelConfig,
  getResponseProvider,
  isResponseModel,
  type AiEnvironment,
  type AiModelCatalog,
  type AiTextProvider,
} from "@conclave/ai/models";
import { baseUrl } from "#request-options";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const supported = (value: unknown) => record(value).supported === true;

export async function fetchAiModelCatalog(options: {
  provider: AiTextProvider;
  apiKey: string;
  env: AiEnvironment;
  signal?: AbortSignal;
  includeSnapshots?: boolean;
}): Promise<AiModelCatalog> {
  const { provider, apiKey, env } = options;
  const fallback: AiModelCatalog = {
    provider,
    source: "built-in",
    models: AI_RESPONSE_MODELS.filter((model) => model.provider === provider),
  };
  if (!apiKey) return fallback;
  const root =
    provider === "openai"
      ? (baseUrl(env.CLOUDFLARE_AI_GATEWAY_OPENAI_URL, env.OPENAI_BASE_URL) ??
        "https://api.openai.com/v1")
      : (baseUrl(
          env.CLOUDFLARE_AI_GATEWAY_ANTHROPIC_URL,
          env.ANTHROPIC_BASE_URL,
        ) ?? "https://api.anthropic.com");
  const signal = AbortSignal.any([
    AbortSignal.timeout(7000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const rows: Record<string, unknown>[] = [];
  const cursors = new Set<string>();
  try {
    const url = new URL(
      `${root}/${provider === "anthropic" ? "v1/" : ""}models`,
    );
    if (provider === "anthropic") url.searchParams.set("limit", "100");
    for (let page = 0; page < 10; page++) {
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(provider === "anthropic"
            ? { "anthropic-version": "2026-10-21" }
            : {}),
        },
        signal,
        cache: "no-store",
        // Never forward a provider credential to a redirect target.
        redirect: "manual",
      });
      if (!response.ok) {
        return {
          ...fallback,
          status: response.status,
          error:
            response.status === 403
              ? `${AI_PROVIDERS[provider].label} key cannot list models. Showing built-in models.`
              : `Could not refresh ${AI_PROVIDERS[provider].label} models (${response.status}).`,
        };
      }
      const body = record(await response.json());
      if (!Array.isArray(body.data)) throw new Error("Invalid model list");
      rows.push(...body.data.map(record));
      if (provider !== "anthropic" || !body.has_more) break;
      if (
        typeof body.last_id !== "string" ||
        cursors.has(body.last_id) ||
        page === 9
      )
        throw new Error("Invalid model pagination");
      cursors.add(body.last_id);
      url.searchParams.set("after_id", body.last_id);
    }
    const today = new Date().toISOString().slice(0, 10);
    const eligible = rows.filter((row) => {
      if (
        typeof row.id !== "string" ||
        !isResponseModel(row.id) ||
        getResponseProvider(row.id) !== provider
      )
        return false;
      if (row.lifecycle === "retired") return false;
      if (typeof row.shutdown_date === "string" && row.shutdown_date <= today)
        return false;
      if (provider === "anthropic" && row.capabilities) {
        const capabilities = record(row.capabilities);
        // All pickers cover both assistant tools and structured meeting minutes.
        if (
          !supported(capabilities.structured_outputs) ||
          !supported(record(capabilities.server_tools).web_search)
        )
          return false;
      }
      return true;
    });
    const ids = new Set(eligible.map((row) => row.id as string));
    const seen = new Set<string>();
    const models = eligible
      .sort((a, b) => {
        const date = (row: Record<string, unknown>) =>
          typeof row.created === "number"
            ? row.created * 1000
            : Date.parse(String(row.created_at)) || 0;
        return date(b) - date(a) || String(a.id).localeCompare(String(b.id));
      })
      .filter((row) => {
        const id = row.id as string;
        const alias = id.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");
        if (
          seen.has(id) ||
          (!options.includeSnapshots && id !== alias && ids.has(alias))
        )
          return false;
        seen.add(id);
        return true;
      })
      .map((row) => {
        const config = getTranscriptResponseModelConfig(row.id as string);
        return {
          ...config,
          ...(typeof row.display_name === "string"
            ? { label: row.display_name.slice(0, 100) }
            : {}),
          ...(typeof row.max_tokens === "number" && row.max_tokens > 0
            ? {
                qaMaxOutputTokens: Math.min(
                  config.qaMaxOutputTokens,
                  row.max_tokens,
                ),
                minutesMaxOutputTokens: Math.min(
                  config.minutesMaxOutputTokens,
                  row.max_tokens,
                ),
              }
            : {}),
        };
      });
    return { provider, source: "live", models };
  } catch {
    // Do not log SDK errors, request objects, or credentials for model discovery.
    return {
      ...fallback,
      error: `Could not refresh ${AI_PROVIDERS[provider].label} models. Showing built-in models.`,
    };
  }
}
