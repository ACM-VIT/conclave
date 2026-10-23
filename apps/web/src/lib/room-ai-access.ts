import jwt from "jsonwebtoken";
import { fetchRoomAiEnvironment } from "@conclave/ai/room-server";
import { resolveAiFeatureSettings } from "@conclave/ai/room-settings";
import type { RoomAiIdentity } from "@conclave/ai/room";

export async function roomAiAccess(token: string, purpose: "voice" | "speech") {
  const secret = process.env.SFU_SECRET?.trim() || "development-secret";
  const value = jwt.verify(token, secret, {
    algorithms: ["HS256"],
    issuer: "conclave-sfu",
    audience: "conclave-web",
  });
  if (
    typeof value === "string" ||
    value.tokenUse !== "room-ai:access" ||
    value.purpose !== purpose ||
    typeof value.sfuUrl !== "string"
  )
    throw new Error("Room AI access is invalid or expired.");
  const identity: RoomAiIdentity = {
    userId: String(value.userId || ""),
    roomId: String(value.roomId || ""),
    clientId: String(value.clientId || ""),
    channelId: String(value.channelId || ""),
  };
  if (Object.values(identity).some((value) => !value))
    throw new Error("Room AI access is incomplete.");
  const env = await fetchRoomAiEnvironment({
    sfuUrl: value.sfuUrl,
    secret,
    identity,
    providers: purpose === "voice" ? ["openai"] : [],
    requireHost: purpose === "voice",
  });
  const settings = resolveAiFeatureSettings(env, purpose);
  if (!settings.enabled)
    throw new Error("This feature is disabled in Room AI settings.");
  return { env, settings, identity };
}
