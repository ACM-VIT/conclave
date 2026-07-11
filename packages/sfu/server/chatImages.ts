import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";

export const CHAT_IMAGE_UPLOAD_TOKEN_TTL_SECONDS = 60;
export const SUPPORTED_CHAT_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
] as const;

export type SupportedChatImageType =
  (typeof SUPPORTED_CHAT_IMAGE_TYPES)[number];

type ChatImageUploadPayload = {
  type: "chat-image-upload";
  roomChannelId: string;
  userId: string;
};

export type ChatImageUploadClaims = ChatImageUploadPayload & {
  tokenId: string;
  expiresAt: number;
};

export const createChatImageUploadToken = (
  secret: string,
  roomChannelId: string,
  userId: string,
): string =>
  jwt.sign(
    {
      type: "chat-image-upload",
      roomChannelId,
      userId,
    } satisfies ChatImageUploadPayload,
    secret,
    {
      expiresIn: CHAT_IMAGE_UPLOAD_TOKEN_TTL_SECONDS,
      jwtid: randomBytes(12).toString("hex"),
    },
  );

export const verifyChatImageUploadToken = (
  secret: string,
  token: string,
): ChatImageUploadClaims | null => {
  try {
    const decoded = jwt.verify(token, secret);
    if (!decoded || typeof decoded !== "object") return null;
    if (
      decoded.type !== "chat-image-upload" ||
      typeof decoded.roomChannelId !== "string" ||
      typeof decoded.userId !== "string" ||
      typeof decoded.jti !== "string" ||
      typeof decoded.exp !== "number"
    ) {
      return null;
    }
    return {
      type: "chat-image-upload",
      roomChannelId: decoded.roomChannelId,
      userId: decoded.userId,
      tokenId: decoded.jti,
      expiresAt: decoded.exp,
    };
  } catch {
    return null;
  }
};

export const consumeChatImageUploadToken = (
  claims: ChatImageUploadClaims,
  consumedTokens: Map<string, number>,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean => {
  for (const [tokenId, expiresAt] of consumedTokens) {
    if (expiresAt <= nowSeconds) consumedTokens.delete(tokenId);
  }
  if (consumedTokens.has(claims.tokenId)) return false;
  consumedTokens.set(claims.tokenId, claims.expiresAt);
  return true;
};

export const detectChatImageType = (
  data: Buffer,
): SupportedChatImageType | null => {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  const signature = data.subarray(0, 12).toString("ascii");
  if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  if (
    data.length >= 16 &&
    data.subarray(4, 8).toString("ascii") === "ftyp" &&
    /avif|avis/.test(data.subarray(8, 32).toString("ascii"))
  ) {
    return "image/avif";
  }
  return null;
};

export const sanitizeChatImageFileName = (value: unknown): string => {
  const fileName = typeof value === "string" ? value.trim() : "";
  const cleaned = fileName
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "-")
    .slice(0, 140);
  return cleaned || "image";
};

export const createChatImageReadSignature = (
  secret: string,
  roomChannelId: string,
  assetId: string,
): string =>
  createHmac("sha256", secret)
    .update(`${roomChannelId}\n${assetId}`)
    .digest("base64url");

export const verifyChatImageReadSignature = (
  secret: string,
  roomChannelId: string,
  assetId: string,
  signature: string,
): boolean => {
  const expected = Buffer.from(
    createChatImageReadSignature(secret, roomChannelId, assetId),
  );
  const received = Buffer.from(signature);
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
};
