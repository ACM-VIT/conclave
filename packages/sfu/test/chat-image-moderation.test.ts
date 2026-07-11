import { describe, expect, it, vi } from "vitest";
import type { ModerationCreateParams } from "openai/resources/moderations";

vi.mock("../config/config.js", () => ({
  config: {
    openAi: {
      apiKey: "",
      maxRetries: 2,
    },
  },
}));

import {
  CHAT_IMAGE_MODERATION_MODEL,
  type ChatImageModerationClient,
  moderateChatImage,
} from "../server/chatImageModeration.js";

const image = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

const makeClient = (response: {
  results: Array<{ flagged: boolean; categories: object }>;
  _request_id?: string;
}) => {
  const create = vi.fn(
    async (_body: ModerationCreateParams, _options?: { timeout?: number }) =>
      response,
  );
  const client: ChatImageModerationClient = {
    moderations: { create },
  };
  return { client, create };
};

describe("chat image moderation", () => {
  it("uses the SDK to send image bytes and accepts a safe image", async () => {
    const { client, create } = makeClient({
      results: [{ flagged: false, categories: { violence: false } }],
      _request_id: "req-safe",
    });

    await expect(
      moderateChatImage({
        data: image,
        mimeType: "image/jpeg",
        timeoutMs: 1000,
        client,
      }),
    ).resolves.toEqual({
      blocked: false,
      categories: [],
      requestId: "req-safe",
    });

    expect(create).toHaveBeenCalledWith(
      {
        model: CHAT_IMAGE_MODERATION_MODEL,
        input: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${image.toString("base64")}`,
            },
          },
        ],
      },
      { timeout: 1000 },
    );
  });

  it("returns the flagged harm categories", async () => {
    const { client } = makeClient({
      results: [
        {
          flagged: true,
          categories: {
            sexual: false,
            violence: true,
            "violence/graphic": true,
          },
        },
      ],
    });

    await expect(
      moderateChatImage({
        data: image,
        mimeType: "image/jpeg",
        timeoutMs: 1000,
        client,
      }),
    ).resolves.toEqual({
      blocked: true,
      categories: ["violence", "violence/graphic"],
      requestId: undefined,
    });
  });

  it("fails closed when configuration or the provider response is invalid", async () => {
    await expect(
      moderateChatImage({
        data: image,
        mimeType: "image/jpeg",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("not configured");

    const { client } = makeClient({ results: [] });
    await expect(
      moderateChatImage({
        data: image,
        mimeType: "image/jpeg",
        timeoutMs: 1000,
        client,
      }),
    ).rejects.toThrow("invalid response");
  });
});
