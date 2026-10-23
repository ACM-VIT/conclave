import { describe, expect, it } from "vitest";
import { describeAiError } from "../src/errors.js";

describe("provider error diagnostics", () => {
  it("keeps actionable status and request IDs without exposing credentials", () => {
    const detail = describeAiError(
      {
        status: 401,
        request_id: "req_123",
        error: {
          type: "authentication_error",
          message: "Rejected sk-ant-private-key and Bearer another-secret",
        },
        request: { headers: { authorization: "another-secret" } },
      },
      "anthropic",
      "sk-ant-private-key",
    );
    expect(detail).toMatchObject({
      status: 401,
      type: "authentication_error",
      requestId: "req_123",
    });
    expect(detail.userMessage).toContain("rejected the API key");
    expect(JSON.stringify(detail)).not.toContain("sk-ant-private-key");
    expect(JSON.stringify(detail)).not.toContain("another-secret");
    expect(detail).not.toHaveProperty("request");
  });

  it("explains billing and rate limits without showing raw provider responses", () => {
    expect(
      describeAiError(
        {
          status: 400,
          error: {
            error: {
              type: "invalid_request_error",
              message: "Your credit balance is too low",
            },
          },
        },
        "anthropic",
        "",
      ).userMessage,
    ).toContain("credits and billing");
    expect(
      describeAiError({ status: 429 }, "openai", "").userMessage,
    ).toContain("rate limited");
    expect(
      describeAiError({ status: 404 }, "anthropic", "").userMessage,
    ).toContain("model is unavailable");
  });
});
