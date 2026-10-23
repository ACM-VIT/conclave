import type { AiTextProvider } from "@conclave/ai/models";
import { AI_PROVIDERS } from "@conclave/ai/models";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

// SDK Error objects lose their useful fields when Workers serializes the stack.
// Return plain, redacted diagnostics; never log the request or its headers.
export function describeAiError(
  error: unknown,
  provider: AiTextProvider,
  apiKey: string,
) {
  const detail = record(error);
  const body = record(detail.error);
  const cause = record(body.error ?? body);
  const rawMessage =
    typeof cause.message === "string"
      ? cause.message
      : typeof detail.message === "string"
        ? detail.message
        : "Unknown provider error";
  const message = (
    apiKey ? rawMessage.split(apiKey).join("[redacted]") : rawMessage
  )
    .replace(/sk-[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 600);
  const status = typeof detail.status === "number" ? detail.status : undefined;
  const label = AI_PROVIDERS[provider].label;
  const userMessage =
    status === 401
      ? `${label} rejected the API key. Update it in AI settings.`
      : status === 403
        ? `This ${label} key cannot access the selected model.`
        : status === 404
          ? `The selected ${label} model is unavailable for this account.`
          : /credit balance|insufficient.{0,20}(credit|quota)|billing/i.test(
                message,
              )
            ? `Check the credits and billing on your ${label} account.`
            : status === 429
              ? `${label} is rate limited. Try again shortly.`
              : status === 400
                ? `${label} rejected the request. Check the selected model and account settings.`
                : `Conclave could not reach ${label}. Try again shortly.`;
  return {
    provider,
    status,
    type: typeof cause.type === "string" ? cause.type.slice(0, 80) : undefined,
    requestId:
      typeof detail.request_id === "string"
        ? detail.request_id.slice(0, 120)
        : undefined,
    message,
    userMessage,
  };
}
