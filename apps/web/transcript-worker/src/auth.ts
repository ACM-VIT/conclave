import type { TranscriptTokenPayload } from "./types";
import { safeJsonParse } from "./utils";

const TOKEN_HEADER = { alg: "HS256", typ: "JWT" };

const base64UrlEncode = (value: Uint8Array | string): string => {
  const binary =
    typeof value === "string"
      ? value
      : String.fromCharCode(...Array.from(value));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const base64UrlToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const signHs256Jwt = async (
  payload: TranscriptTokenPayload,
  secret: string,
): Promise<string> => {
  const header = base64UrlEncode(JSON.stringify(TOKEN_HEADER));
  const body = base64UrlEncode(JSON.stringify(payload));
  const input = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
};

export const signTranscriptSfuRelayStartToken = async (
  options: {
    userId: string;
    displayName: string;
    roomId: string;
    clientId?: string;
    channelId?: string;
    connectionId: string;
  },
  secret: string,
  ttlSeconds = 30,
): Promise<{ token: string; expiresAt: number }> => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = (nowSeconds + ttlSeconds) * 1000;
  const token = await signHs256Jwt(
    {
      iss: "conclave-transcript-worker",
      aud: "conclave-sfu",
      sub: options.userId,
      tokenUse: "transcript:sfuRelayStart",
      userId: options.userId,
      displayName: options.displayName,
      roomId: options.roomId,
      clientId: options.clientId,
      channelId: options.channelId,
      connectionId: options.connectionId,
      sessionStatus: "live",
      transportMode: "sfu",
      exp: nowSeconds + ttlSeconds,
    },
    secret,
  );
  return { token, expiresAt };
};

export const verifyTranscriptToken = async (
  token: string,
  secret: string,
): Promise<TranscriptTokenPayload | null> => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) return null;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlToBytes(signature),
    encoder.encode(`${header}.${payload}`),
  );
  if (!valid) return null;

  const parsed = safeJsonParse(
    new TextDecoder().decode(base64UrlToBytes(payload)),
  );
  if (!parsed || typeof parsed !== "object") return null;
  const data = parsed as TranscriptTokenPayload;
  if (data.aud !== "conclave-transcript-worker") return null;
  if (!data.exp || data.exp * 1000 < Date.now()) return null;
  if (!data.userId || !data.roomId) return null;
  return {
    aud: data.aud,
    exp: data.exp,
    sub: data.sub,
    userId: data.userId,
    displayName: data.displayName,
    roomId: data.roomId,
    clientId: data.clientId,
    channelId: data.channelId,
    isAdmin: data.isAdmin,
    isHost: data.isHost,
    isGhost: data.isGhost,
    capabilities: data.capabilities,
  };
};

export const verifyTranscriptRoomToken = async (
  token: string,
  secret: string,
  roomId: string,
): Promise<TranscriptTokenPayload | null> => {
  const payload = await verifyTranscriptToken(token, secret);
  if (!payload || payload.roomId !== roomId) return null;
  return payload;
};
