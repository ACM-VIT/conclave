import type { Router } from "mediasoup/types";
import { describe, expect, it, vi } from "vitest";
import { Room } from "../config/classes/Room.js";
import {
  consumeChatImageUploadToken,
  createChatImageReadSignature,
  createChatImageUploadToken,
  detectChatImageType,
  sanitizeChatImageFileName,
  verifyChatImageReadSignature,
  verifyChatImageUploadToken,
} from "../server/chatImages.js";

const SECRET = "chat-image-test-secret";

describe("chat image validation", () => {
  it.each([
    ["jpeg", Buffer.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"],
    [
      "png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      "image/png",
    ],
    ["gif", Buffer.from("GIF89a", "ascii"), "image/gif"],
    ["webp", Buffer.from("RIFF0000WEBP", "ascii"), "image/webp"],
    ["avif", Buffer.from("0000ftypavif0000", "ascii"), "image/avif"],
  ])("detects %s by file signature", (_name, bytes, expected) => {
    expect(detectChatImageType(bytes)).toBe(expected);
  });

  it("rejects content that only claims to be an image", () => {
    expect(detectChatImageType(Buffer.from("<svg onload=alert(1) />"))).toBeNull();
  });

  it("normalizes attachment names", () => {
    expect(sanitizeChatImageFileName("../screenshots\\demo.png\u0000")).toBe(
      "..-screenshots-demo.png",
    );
  });
});

describe("chat image capabilities", () => {
  it("binds upload authorization to a room and user", () => {
    const token = createChatImageUploadToken(SECRET, "client:room", "user-1");
    const claims = verifyChatImageUploadToken(SECRET, token);
    expect(claims).toMatchObject({
      type: "chat-image-upload",
      roomChannelId: "client:room",
      userId: "user-1",
    });
    expect(claims?.tokenId).toEqual(expect.any(String));
    expect(claims?.expiresAt).toEqual(expect.any(Number));
    expect(verifyChatImageUploadToken("wrong-secret", token)).toBeNull();
  });

  it("consumes each upload capability once", () => {
    const token = createChatImageUploadToken(SECRET, "client:room", "user-1");
    const claims = verifyChatImageUploadToken(SECRET, token);
    expect(claims).not.toBeNull();
    const consumed = new Map<string, number>();

    expect(consumeChatImageUploadToken(claims!, consumed)).toBe(true);
    expect(consumeChatImageUploadToken(claims!, consumed)).toBe(false);
  });

  it("rejects read signatures copied to another room or asset", () => {
    const signature = createChatImageReadSignature(
      SECRET,
      "client:room",
      "asset-1",
    );
    expect(
      verifyChatImageReadSignature(
        SECRET,
        "client:room",
        "asset-1",
        signature,
      ),
    ).toBe(true);
    expect(
      verifyChatImageReadSignature(
        SECRET,
        "client:other-room",
        "asset-1",
        signature,
      ),
    ).toBe(false);
  });
});

describe("room-scoped chat image lifecycle", () => {
  it("drops image bytes when the room closes", () => {
    const closeRouter = vi.fn();
    const room = new Room({
      id: "room",
      clientId: "client",
      workerPid: null,
      router: {
        closed: false,
        close: closeRouter,
        rtpCapabilities: {},
      } as unknown as Router,
    });
    const data = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    expect(
      room.addChatImageAsset({
        id: "asset",
        url: "https://sfu.test/chat-images/asset",
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        size: data.length,
        data,
        uploadedBy: "user",
        createdAt: Date.now(),
        attached: false,
      }),
    ).toEqual({ ok: true });
    expect(room.getChatImageAsset("asset")?.data).toBe(data);

    room.close();

    expect(room.getChatImageAsset("asset")).toBeUndefined();
    expect(closeRouter).toHaveBeenCalledOnce();
  });

  it("reclaims abandoned uploads but preserves attached images", () => {
    const room = new Room({
      id: "room",
      clientId: "client",
      workerPid: null,
      router: {
        closed: false,
        close: vi.fn(),
        rtpCapabilities: {},
      } as unknown as Router,
    });
    const data = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const addAsset = (id: string) =>
      room.addChatImageAsset({
        id,
        url: `https://sfu.test/chat-images/${id}`,
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        size: data.length,
        data,
        uploadedBy: "user",
        createdAt: Date.now(),
        attached: false,
      });

    expect(addAsset("abandoned")).toEqual({ ok: true });
    expect(room.removeUnattachedChatImageAsset("abandoned", "user")).toBe(true);
    expect(room.getChatImageAsset("abandoned")).toBeUndefined();

    expect(addAsset("sent")).toEqual({ ok: true });
    expect(room.markChatImageAssetAttached("sent", "user")).toBe(true);
    expect(room.removeUnattachedChatImageAsset("sent", "user")).toBe(false);
    expect(room.getChatImageAsset("sent")?.attached).toBe(true);
    room.close();
  });
});
