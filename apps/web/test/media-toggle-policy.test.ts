import { describe, expect, it, vi } from "vitest";
import { resumeProducerWithServerConfirmation } from "../src/app/lib/media-toggle-policy";

describe("media toggle policy", () => {
  it("keeps a resumed producer active after server confirmation", async () => {
    const producer = { resume: vi.fn(), pause: vi.fn() };

    const result = await resumeProducerWithServerConfirmation(
      producer,
      async () => ({ ok: true }),
    );

    expect(result).toEqual({ ok: true });
    expect(producer.resume).toHaveBeenCalledOnce();
    expect(producer.pause).not.toHaveBeenCalled();
  });

  it("re-pauses a producer when the server rejects its resume", async () => {
    const producer = { resume: vi.fn(), pause: vi.fn() };

    const result = await resumeProducerWithServerConfirmation(
      producer,
      async () => ({ ok: false, error: "Video permission revoked" }),
    );

    expect(result).toEqual({
      ok: false,
      error: "Video permission revoked",
    });
    expect(producer.resume).toHaveBeenCalledOnce();
    expect(producer.pause).toHaveBeenCalledOnce();
  });

  it("re-pauses a producer when resume confirmation fails", async () => {
    const producer = { resume: vi.fn(), pause: vi.fn() };

    await expect(
      resumeProducerWithServerConfirmation(producer, async () => {
        throw new Error("Socket disconnected");
      }),
    ).rejects.toThrow("Socket disconnected");

    expect(producer.resume).toHaveBeenCalledOnce();
    expect(producer.pause).toHaveBeenCalledOnce();
  });
});
