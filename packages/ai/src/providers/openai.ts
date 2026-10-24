import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { getProviderApiKey, type AiEnvironment } from "@conclave/ai/models";
import type {
  AiTextOptions,
  AiTextSession,
  AiToolResult,
  AiEvent,
} from "#types";
import { baseUrl, requestOptions } from "#request-options";
// All OpenAI users, including moderation, share endpoint and retry policy.
export const createOpenAiClient = (
  env: AiEnvironment,
  apiKey = getProviderApiKey(env, "openai"),
): OpenAI =>
  new OpenAI({
    apiKey,
    baseURL: baseUrl(env.CLOUDFLARE_AI_GATEWAY_OPENAI_URL, env.OPENAI_BASE_URL),
    maxRetries: 2,
  });

const openAiParams = (options: AiTextOptions) => ({
  model: options.model,
  instructions: options.instructions,
  max_output_tokens: options.maxOutputTokens,
  ...(options.maxSearchUses ? { max_tool_calls: options.maxSearchUses } : {}),
  store: false,
  ...(options.tools?.length
    ? {
        tools: options.tools.map((tool) =>
          tool.type === "function"
            ? { ...tool, strict: tool.strict ?? false }
            : tool,
        ),
      }
    : {}),
  ...(options.reasoningEffort
    ? {
        reasoning: {
          effort: options.reasoningEffort,
          summary: "auto" as const,
        },
      }
    : {}),
  ...(options.verbosity || options.format
    ? {
        text: {
          ...(options.verbosity ? { verbosity: options.verbosity } : {}),
          ...(options.format
            ? {
                format: {
                  type: "json_schema" as const,
                  ...options.format,
                  strict: true,
                },
              }
            : {}),
        },
      }
    : {}),
});

export const generateOpenAiText = async (
  options: AiTextOptions & { input: string },
): Promise<string> => {
  const response = await createOpenAiClient(
    options.env,
    options.apiKey,
  ).responses.create(
    { ...openAiParams(options), input: options.input },
    requestOptions(options),
  );
  if (response.status && response.status !== "completed")
    throw new Error("OpenAI did not finish the response.");
  return response.output_text;
};

export const createOpenAiTextSession = (
  options: AiTextOptions,
): AiTextSession => {
  const openAiHistory: ResponseInputItem[] = [];
  return {
    async *stream(input: string | AiToolResult[]): AsyncGenerator<AiEvent> {
      openAiHistory.push(
        ...(typeof input === "string"
          ? [{ role: "user" as const, content: input }]
          : input.map((result) => ({
              type: "function_call_output" as const,
              call_id: result.id,
              output: result.output,
            }))),
      );
      const stream = createOpenAiClient(
        options.env,
        options.apiKey,
      ).responses.stream(
        { ...openAiParams(options), input: openAiHistory, stream: true },
        requestOptions(options),
      );
      let text = "";
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          text += event.delta;
          yield { type: "text", id: event.item_id, delta: event.delta, text };
        } else if (event.type === "response.reasoning_summary_text.delta") {
          yield { type: "reasoning", delta: event.delta };
        } else if (event.type === "response.reasoning_summary_text.done") {
          yield { type: "reasoning", done: true };
        } else if (
          event.type === "response.output_item.added" ||
          event.type === "response.output_item.done"
        ) {
          const item = event.item;
          const status =
            event.type === "response.output_item.done" ? "done" : "running";
          if (item.type === "function_call") {
            yield {
              type: "activity",
              id: item.call_id,
              kind: "function",
              name: item.name,
              status: "running",
            };
          } else if (
            item.type === "message" ||
            item.type === "reasoning" ||
            item.type === "web_search_call"
          ) {
            yield {
              type: "activity",
              id: item.id,
              kind:
                item.type === "message"
                  ? "answer"
                  : item.type === "reasoning"
                    ? "reasoning"
                    : "web_search",
              status,
              ...(item.type === "web_search_call" &&
              item.action?.type === "search"
                ? { query: item.action.query }
                : {}),
            };
          }
        }
      }
      const response = await stream.finalResponse();
      if (response.status !== "completed")
        throw new Error("OpenAI did not finish the response.");
      for (const item of response.output) {
        // SDK parsing adds fields that are not valid Responses input fields.
        if (item.type === "function_call") {
          openAiHistory.push({
            type: "function_call",
            call_id: item.call_id,
            name: item.name,
            arguments: item.arguments,
            ...(item.namespace ? { namespace: item.namespace } : {}),
          });
        } else if (item.type === "message") {
          openAiHistory.push({
            ...item,
            content: item.content.map((part) =>
              part.type === "output_text"
                ? {
                    type: "output_text",
                    text: part.text,
                    annotations: part.annotations,
                  }
                : part,
            ),
          });
        } else if (
          item.type === "reasoning" ||
          item.type === "web_search_call"
        ) {
          openAiHistory.push(item);
        }
      }
      yield {
        type: "complete",
        text: response.output_text || text,
        calls: response.output.flatMap((item) =>
          item.type === "function_call"
            ? [
                {
                  id: item.call_id,
                  name: item.name,
                  arguments: item.arguments,
                },
              ]
            : [],
        ),
      };
    },
  };
};
