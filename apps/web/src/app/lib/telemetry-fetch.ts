export type TelemetryRequest = {
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  keepalive?: boolean;
  signal?: AbortSignal;
  deadlineMs: number;
};

export function telemetryFetch(url: string, { deadlineMs, signal, ...request }: TelemetryRequest): Promise<Response> {
  const controller = new AbortController();
  const end = () => controller.abort();
  const deadline = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(deadlineMs) : null;
  if (deadline) deadline.addEventListener("abort", end, { once: true });
  else setTimeout(end, deadlineMs);
  if (signal?.aborted) end();
  else signal?.addEventListener("abort", end, { once: true });
  return fetch(url, {
    ...request,
    signal: controller.signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
  });
}
