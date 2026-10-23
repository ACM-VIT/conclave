import type { AiTextOptions } from "#types";
export const baseUrl = (
  gateway?: string,
  direct?: string,
): string | undefined =>
  (gateway?.trim() || direct?.trim() || "").replace(/\/+$/, "") || undefined;

export const requestOptions = (options: AiTextOptions) => ({
  ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
  ...(options.signal ? { signal: options.signal } : {}),
});
