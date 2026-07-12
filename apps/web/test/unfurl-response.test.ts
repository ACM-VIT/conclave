import { describe, expect, it } from "vitest";
import {
  readBoundedResponseBytes,
  readHtmlPrefix,
} from "../src/app/lib/unfurl-response";

const responseFromChunks = (...chunks: Uint8Array[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );

describe("readHtmlPrefix", () => {
  it("does not decode bytes beyond the configured limit", async () => {
    const body = new TextEncoder().encode(`${"a".repeat(64)}SECRET`);

    const html = await readHtmlPrefix(responseFromChunks(body), 64);

    expect(html).toBe("a".repeat(64));
    expect(html).not.toContain("SECRET");
  });

  it("applies the limit across multiple chunks", async () => {
    const encoder = new TextEncoder();

    const html = await readHtmlPrefix(
      responseFromChunks(
        encoder.encode("a".repeat(40)),
        encoder.encode(`${"b".repeat(40)}SECRET`),
      ),
      64,
    );

    expect(html).toBe(`${"a".repeat(40)}${"b".repeat(24)}`);
  });
});

describe("readBoundedResponseBytes", () => {
  it("returns the complete body when it fits", async () => {
    const encoder = new TextEncoder();
    const bytes = await readBoundedResponseBytes(
      responseFromChunks(encoder.encode("first"), encoder.encode("second")),
      11,
    );

    expect(new TextDecoder().decode(bytes)).toBe("firstsecond");
  });

  it("rejects a body as soon as it exceeds the limit", async () => {
    const bytes = await readBoundedResponseBytes(
      responseFromChunks(new Uint8Array(65)),
      64,
    );

    expect(bytes).toBeNull();
  });
});
