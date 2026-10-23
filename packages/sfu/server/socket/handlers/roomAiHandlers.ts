import {
  getProviderApiKey,
  getResponseProvider,
  isResponseModel,
  readAiEnvironment,
  isProviderApiKey,
} from "@conclave/ai/models";
import { isRoomAiProvider } from "@conclave/ai/room";
import { Admin } from "../../../config/classes/Admin.js";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";

export const registerRoomAiHandlers = (context: ConnectionContext): void => {
  const { socket, io } = context;
  const active = () => {
    const room = context.currentRoom;
    const client = context.currentClient;
    return room &&
      client &&
      !client.isObserver &&
      room.getClient(client.id) === client &&
      client.socket.id === socket.id
      ? { room, client }
      : null;
  };
  socket.on("ai:settings", (callback: (result: unknown) => void) => {
    if (typeof callback !== "function") return;
    const member = active();
    if (!member) {
      callback({ error: "Join the meeting to manage room AI." });
      return;
    }
    callback({
      state: member.room.aiCredentials.status(readAiEnvironment(process.env)),
    });
  });
  socket.on(
    "ai:models",
    async (input: unknown, callback: (result: unknown) => void) => {
      if (typeof callback !== "function") return;
      const member = active();
      if (!member) {
        callback({ error: "Join the meeting to load AI models." });
        return;
      }
      if (!takeToken(socket, "ai:models", RATE_LIMITS.aiModels)) {
        callback({ error: "Please wait before refreshing models." });
        return;
      }
      const data =
        input && typeof input === "object"
          ? (input as Record<string, unknown>)
          : {};
      if (data.roomId !== member.room.id) {
        callback({ error: "The meeting changed. Reopen AI settings." });
        return;
      }
      if (
        data.apiKey !== undefined &&
        ((data.provider !== "openai" && data.provider !== "anthropic") ||
          typeof data.apiKey !== "string" ||
          data.apiKey.length > 512 ||
          !isProviderApiKey(data.provider, data.apiKey))
      ) {
        callback({ error: "Enter a valid provider key." });
        return;
      }
      const env = readAiEnvironment(process.env);
      const keyRevision = member.room.aiCredentials.keyRevision;
      const catalogs = await Promise.all(
        (["openai", "anthropic"] as const).map((provider) =>
          member.room.aiCredentials.models(provider, env, {
            ...(data.provider === provider && typeof data.apiKey === "string"
              ? { apiKey: data.apiKey.trim() }
              : {}),
            refresh: data.refresh === true,
          }),
        ),
      );
      const current = active();
      if (current?.room !== member.room || current?.client !== member.client) {
        callback({
          error: "The meeting connection changed. Please try again.",
        });
        return;
      }
      if (keyRevision !== member.room.aiCredentials.keyRevision) {
        callback({ error: "AI keys changed. Refresh models again." });
        return;
      }
      if (data.refresh === true && data.apiKey === undefined) {
        io.to(member.room.channelId).emit(
          "ai:changed",
          member.room.aiCredentials.status(readAiEnvironment(process.env)),
        );
      }
      callback({ catalogs });
    },
  );
  socket.on(
    "ai:configure",
    (input: unknown, callback: (result: unknown) => void) => {
      if (typeof callback !== "function") return;
      const member = active();
      if (!member) {
        callback({ error: "Join the meeting to manage room AI." });
        return;
      }
      if (!takeToken(socket, "ai:configure", RATE_LIMITS.chatImageUpload)) {
        callback({ error: "Please wait before changing room AI again." });
        return;
      }
      const data =
        input && typeof input === "object"
          ? (input as Record<string, unknown>)
          : {};
      if (data.roomId !== member.room.id) {
        callback({ error: "The meeting changed. Reopen room AI settings." });
        return;
      }
      if (!isRoomAiProvider(data.provider)) {
        callback({ error: "Choose a supported provider." });
        return;
      }
      try {
        const host = member.client instanceof Admin;
        const env = readAiEnvironment(process.env);
        if (
          data.model !== undefined &&
          data.model !== null &&
          (typeof data.model !== "string" ||
            !isResponseModel(data.model) ||
            getResponseProvider(data.model) !== data.provider)
        ) {
          throw new Error("Choose a supported model for this provider.");
        }
        if (data.model !== undefined && data.remove === true) {
          throw new Error("Remove a key or change its model separately.");
        }
        if (
          typeof data.model === "string" &&
          !host &&
          getProviderApiKey(env, data.provider)
        ) {
          throw new Error("Only a host can change deployment-backed models.");
        }
        if (data.remove === true)
          member.room.aiCredentials.remove(
            data.provider,
            member.client.id,
            host,
          );
        else if (typeof data.apiKey === "string")
          member.room.aiCredentials.set(
            data.provider,
            data.apiKey,
            member.client.id,
            host,
            env,
            { selectDefaultModel: data.model !== null },
          );
        else if (typeof data.model !== "string")
          throw new Error("Enter an API key.");
        if (typeof data.model === "string") {
          member.room.aiCredentials.setModel(
            data.model,
            member.client.id,
            host,
            env,
          );
        }
        const state = member.room.aiCredentials.status(
          readAiEnvironment(process.env),
        );
        io.to(member.room.channelId).emit("ai:changed", state);
        callback({ state });
      } catch (error) {
        callback({
          error:
            error instanceof Error
              ? error.message
              : "Room AI settings could not be saved.",
        });
      }
    },
  );
};
