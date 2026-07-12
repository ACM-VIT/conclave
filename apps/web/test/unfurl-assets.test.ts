import { describe, expect, it } from "vitest";
import { toUnfurlAssetUrl } from "../src/app/lib/unfurl-assets";

describe("toUnfurlAssetUrl", () => {
  it("rewrites a public remote asset through the same-origin proxy", () => {
    expect(toUnfurlAssetUrl("https://cdn.example.com/image.png?a=1&b=2")).toBe(
      "/api/unfurl/asset?url=https%3A%2F%2Fcdn.example.com%2Fimage.png%3Fa%3D1%26b%3D2",
    );
  });

  it("does not create proxy URLs for private or non-http targets", () => {
    expect(toUnfurlAssetUrl("http://127.0.0.1/private.png")).toBeUndefined();
    expect(toUnfurlAssetUrl("data:image/png;base64,abc")).toBeUndefined();
    expect(toUnfurlAssetUrl(undefined)).toBeUndefined();
  });
});
