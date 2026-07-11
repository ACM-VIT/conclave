import { describe, expect, it, vi } from "vitest";
import { findClipboardImageFile } from "../src/app/lib/chat-images";

const emptyFiles: ArrayLike<File> = { length: 0 };

describe("chat image clipboard handling", () => {
  it("returns the first pasted image file", () => {
    const image = { name: "clipboard.png", type: "image/png" } as File;
    const getAsFile = vi.fn(() => image);

    const result = findClipboardImageFile({
      items: {
        0: { kind: "string", type: "text/plain", getAsFile: () => null },
        1: { kind: "file", type: "image/png", getAsFile },
        length: 2,
      },
      files: emptyFiles,
    });

    expect(result).toBe(image);
    expect(getAsFile).toHaveBeenCalledOnce();
  });

  it("falls back to clipboard files and ignores non-images", () => {
    const textFile = { name: "notes.txt", type: "text/plain" } as File;
    const image = { name: "clipboard.webp", type: "image/webp" } as File;

    expect(
      findClipboardImageFile({
        items: { length: 0 },
        files: { 0: textFile, 1: image, length: 2 },
      }),
    ).toBe(image);
  });

  it("leaves ordinary text-only clipboard data alone", () => {
    expect(
      findClipboardImageFile({
        items: {
          0: { kind: "string", type: "text/plain", getAsFile: () => null },
          length: 1,
        },
        files: emptyFiles,
      }),
    ).toBeNull();
  });
});
