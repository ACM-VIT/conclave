import { readAiEnvironment } from "@conclave/ai/models";
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
          );
        else throw new Error("Enter an API key.");
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
