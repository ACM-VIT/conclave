import type { Server as SocketIOServer } from "socket.io";
import { Logger } from "../../utilities/loggers.js";
import type { SfuState } from "../state.js";
import { createConnectionContext, setSocketContext } from "./context.js";
import { registerChatHandlers } from "./handlers/chatHandlers.js";
import { registerDisconnectHandlers } from "./handlers/disconnectHandlers.js";
import { registerDisplayNameHandlers } from "./handlers/displayNameHandlers.js";
import { registerHandHandlers } from "./handlers/handHandlers.js";
import { registerJoinRoomHandler } from "./handlers/joinRoom.js";
import { registerMediaHandlers } from "./handlers/mediaHandlers.js";
import { registerMeetingHandlers } from "./handlers/meetingHandlers.js";
import { registerReactionHandlers } from "./handlers/reactionHandlers.js";
import { registerRouterHandlers } from "./handlers/routerHandlers.js";
import { registerSharedBrowserHandlers } from "./handlers/sharedBrowserHandlers.js";
import { registerTransportHandlers } from "./handlers/transportHandlers.js";
import { registerTranscriptHandlers } from "./handlers/transcriptHandlers.js";
import { registerAppsHandlers } from "./handlers/appsHandlers.js";
import { registerGameHandlers } from "./handlers/gameHandlers.js";
import { registerWebinarHandlers } from "./handlers/webinarHandlers.js";

export const registerConnectionHandlers = (
  io: SocketIOServer,
  state: SfuState,
): void => {
  io.on("connection", (socket) => {
    Logger.info(`Client connected: ${socket.id}`);

    const context = createConnectionContext(io, socket, state);
    setSocketContext(socket, context);

    registerJoinRoomHandler(context);
    registerRouterHandlers(context);
    registerTransportHandlers(context);
    registerMediaHandlers(context);
    registerDisplayNameHandlers(context);
    registerChatHandlers(context);
    registerReactionHandlers(context);
    registerHandHandlers(context);
    registerAppsHandlers(context);
    registerGameHandlers(context);
    registerMeetingHandlers(context);
    registerWebinarHandlers(context);
    registerSharedBrowserHandlers(context);
    registerTranscriptHandlers(context);
    registerDisconnectHandlers(context);
  });
};
