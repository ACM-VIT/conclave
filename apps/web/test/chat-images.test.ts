import { describe, expect, it, vi } from "vitest";
import {
  findClipboardImageFile,
  prepareChatImageFile,
  resolveChatImageType,
} from "../src/app/lib/chat-images";

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

  it("prefers a supported format when the clipboard carries several", () => {
    const tiff = { name: "image.tiff", type: "image/tiff" } as File;
    const png = { name: "image.png", type: "image/png" } as File;

    expect(
      findClipboardImageFile({
        items: {
          0: { kind: "file", type: "image/tiff", getAsFile: () => tiff },
          1: { kind: "file", type: "image/png", getAsFile: () => png },
          length: 2,
        },
        files: emptyFiles,
      }),
    ).toBe(png);
  });

  it("accepts pasted image files that arrive without a MIME type", () => {
    const untyped = { name: "Screenshot.PNG", type: "" } as File;

    expect(
      findClipboardImageFile({
        items: {
          0: { kind: "file", type: "", getAsFile: () => untyped },
          length: 1,
        },
        files: emptyFiles,
      }),
    ).toBe(untyped);
  });
});

describe("chat image type resolution", () => {
  it("normalizes aliases and falls back to the extension for untyped files", () => {
    expect(resolveChatImageType({ name: "a.jpg", type: "image/jpg" })).toBe(
      "image/jpeg",
    );
    expect(resolveChatImageType({ name: "a.webp", type: "" })).toBe(
      "image/webp",
    );
    expect(
      resolveChatImageType({ name: "a.png", type: "application/octet-stream" }),
    ).toBe("image/png");
    expect(resolveChatImageType({ name: "a.png", type: "image/png" })).toBe(
      "image/png",
    );
  });

  it("rejects unsupported formats even when the extension looks supported", () => {
    expect(resolveChatImageType({ name: "a.png", type: "image/tiff" })).toBeNull();
    expect(resolveChatImageType({ name: "notes.txt", type: "" })).toBeNull();
  });

  it("retypes supported files and refuses non-images", async () => {
    const png = new File([new Uint8Array([1])], "shot.png", {
      type: "image/png",
    });
    await expect(prepareChatImageFile(png)).resolves.toBe(png);

    const untyped = new File([new Uint8Array([1])], "shot.jpeg");
    const prepared = await prepareChatImageFile(untyped);
    expect(prepared?.type).toBe("image/jpeg");
    expect(prepared?.name).toBe("shot.jpeg");

    const text = new File(["hi"], "notes.txt", { type: "text/plain" });
    await expect(prepareChatImageFile(text)).resolves.toBeNull();
  });
});
