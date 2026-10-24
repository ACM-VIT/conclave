import type {
  AiEnvironment,
  TranscriptReasoningEffort,
  TranscriptTextVerbosity,
} from "@conclave/ai/models";
import type { AiFeature } from "@conclave/ai/room-settings";

export interface AiFunctionTool {
  type: "function";
  name: string;
  description?: string | null;
  parameters: Record<string, unknown> | null;
  strict?: boolean | null;
}
export interface AiWebSearchTool {
  type: "web_search";
  search_context_size?: "low" | "medium" | "high";
}
export type AiTool = AiFunctionTool | AiWebSearchTool;
export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface AiToolResult {
  id: string;
  output: string;
}
export interface AiTextOptions {
  feature?: AiFeature;
  env: AiEnvironment;
  apiKey: string;
  model: string;
  instructions: string;
  maxOutputTokens: number;
  researchTokens?: number;
  maxSearchUses?: number;
  reasoningEffort?: TranscriptReasoningEffort;
  verbosity?: TranscriptTextVerbosity;
  format?: { name: string; schema: Record<string, unknown> };
  tools?: AiTool[];
  timeoutMs?: number;
  signal?: AbortSignal;
}
export type AiEvent =
  | { type: "text"; id: string; delta: string; text: string }
  | { type: "reasoning"; delta?: string; done?: boolean }
  | {
      type: "activity";
      id: string;
      kind: "answer" | "reasoning" | "web_search" | "function";
      status: "running" | "done";
      name?: string;
      query?: string;
    }
  | { type: "complete"; text: string; calls: AiToolCall[] };

export interface AiTextSession {
  stream(input: string | AiToolResult[]): AsyncGenerator<AiEvent>;
}
