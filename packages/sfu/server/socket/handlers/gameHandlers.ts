import { Admin } from "../../../config/classes/Admin.js";
import { config as sfuConfig } from "../../../config/config.js";
import type { Room } from "../../../config/classes/Room.js";
import { GameSession } from "../../games/engine.js";
import { normalizeConfig } from "../../games/config.js";
import { getGameCatalog, getGameModule } from "../../games/registry.js";
import type {
  GameCatalogEntry,
  GameEndResponse,
  GameMoveData,
  GameMoveResponse,
  GamePlayer,
  GameStartData,
  GameStartResponse,
  GameStateResponse,
  GameVoteCastData,
  GameVoteOpenData,
  GameVoteResponse,
  GameVoteState,
} from "../../games/types.js";
import { Logger } from "../../../utilities/loggers.js";
import type { Server as SocketIOServer, Socket } from "socket.io";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { respond } from "./ack.js";

const MAX_GAME_ID_LENGTH = 64;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const normalizeGameId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > MAX_GAME_ID_LENGTH || CONTROL_CHARACTER_PATTERN.test(id)) {
    return null;
  }
  return id;
};

/** Snapshot the current in-meeting participants as game players. */
const snapshotPlayers = (room: Room): GamePlayer[] => {
  const players: GamePlayer[] = [];
  for (const client of room.clients.values()) {
    if (client.isObserver) continue;
    players.push({
      id: client.id,
      name: room.getDisplayNameForUser(client.id) ?? "Guest",
    });
  }
  return players;
};

const countPlayers = (room: Room): number => {
  let count = 0;
  for (const client of room.clients.values()) {
    if (!client.isObserver) count += 1;
  }
  return count;
};

const validatePlayerCount = (
  players: GamePlayer[],
  module: { minPlayers: number; maxPlayers: number },
): string | null => {
  if (players.length < module.minPlayers) {
    return `Need at least ${module.minPlayers} players`;
  }
  if (players.length > module.maxPlayers) {
    return `Supports up to ${module.maxPlayers} players`;
  }
  return null;
};

const collectAdminIds = (room: Room): string[] => {
  const ids: string[] = [];
  for (const client of room.clients.values()) {
    if (client instanceof Admin && !client.isObserver) ids.push(client.id);
  }
  return ids;
};

const syncGameSessionRoomMembership = (room: Room): GameSession | null => {
  const session = room.gameSession;
  if (!session) return null;
  session.updateRoomMembership({
    players: snapshotPlayers(room),
    adminIds: collectAdminIds(room),
  });
  return session;
};

/**
 * Push the latest projections to the room: one public broadcast, plus a private
 * per-player view to each player's own socket. The private emit is the
 * hidden-information boundary. A player only ever receives their own view.
 */
const broadcastGame = (io: SocketIOServer, room: Room): void => {
  const session = syncGameSessionRoomMembership(room);
  if (!session) return;
  const now = Date.now();
  io.to(room.channelId).emit("game:state", session.getPublicState(now));
  for (const player of session.getPlayers()) {
    const client = room.clients.get(player.id);
    if (!client) continue;
    client.socket.emit("game:view", {
      gameId: session.gameId,
      view: session.getPlayerView(player.id, now),
    });
  }
};

const buildVoteState = (room: Room): GameVoteState | null => {
  const vote = room.gameVote;
  if (!vote) return null;
  const candidates: GameCatalogEntry[] = [];
  for (const id of vote.candidates) {
    const module = getGameModule(id);
    if (module) {
      candidates.push({
        id: module.id,
        name: module.name,
        description: module.description,
        minPlayers: module.minPlayers,
        maxPlayers: module.maxPlayers,
        options: module.options ?? [],
        hasLeaderboard: Boolean(module.hasLeaderboard),
      });
    }
  }
  const tally: Record<string, number> = {};
  for (const id of vote.candidates) tally[id] = 0;
  for (const choice of Object.values(vote.votes)) {
    tally[choice] = (tally[choice] ?? 0) + 1;
  }
  return {
    candidates,
    tally,
    votes: vote.votes,
    totalPlayers: countPlayers(room),
  };
};

const broadcastVote = (io: SocketIOServer, room: Room): void => {
  io.to(room.channelId).emit("game:vote", buildVoteState(room));
};

export const buildGameStateResponse = (
  room: Room | null | undefined,
  playerId: string | null | undefined,
): GameStateResponse => {
  if (!room) {
    return { active: false, vote: null };
  }

  const session = syncGameSessionRoomMembership(room);
  const vote = buildVoteState(room);
  if (!session) {
    return { active: false, vote };
  }

  const now = Date.now();
  const response: GameStateResponse = {
    active: true,
    public: session.getPublicState(now),
    vote,
  };
  if (playerId && session.hasPlayer(playerId)) {
    response.view = session.getPlayerView(playerId, now);
  }
  return response;
};

export const emitGameSnapshot = (
  socket: Socket,
  room: Room,
  playerId: string | null | undefined,
): void => {
  socket.emit("game:snapshot", buildGameStateResponse(room, playerId));
};

const stopGameLoop = (room: Room): void => {
  if (room.gameTickTimer) {
    clearInterval(room.gameTickTimer);
    room.gameTickTimer = null;
  }
};

const startGameLoop = (io: SocketIOServer, room: Room): void => {
  stopGameLoop(room);
  const session = room.gameSession;
  if (!session || session.tickMs == null) return;
  room.gameTickTimer = setInterval(() => {
    const active = room.gameSession;
    if (!active) {
      stopGameLoop(room);
      return;
    }
    try {
      syncGameSessionRoomMembership(room);
      if (active.tick()) {
        broadcastGame(io, room);
      }
      if (active.isFinished()) {
        stopGameLoop(room);
      }
    } catch (error) {
      Logger.warn("[Games] tick failed", error);
      stopGameLoop(room);
    }
  }, session.tickMs);
};

export const registerGameHandlers = (context: ConnectionContext): void => {
  const { socket, io } = context;

  socket.on(
    "game:list",
    (callback: (catalog: GameCatalogEntry[]) => void) => {
      respond(callback, getGameCatalog());
    },
  );

  socket.on(
    "game:start",
    async (data: GameStartData, callback: (response: GameStartResponse) => void) => {
      if (!context.currentRoom || !context.currentClient) {
        respond(callback, { success: false, error: "Not in a room" });
        return;
      }
      if (!(context.currentClient instanceof Admin) || context.currentClient.isObserver) {
        respond(callback, { success: false, error: "Only the host can start a game" });
        return;
      }
      if (!takeToken(socket, "game:start", RATE_LIMITS.gameControl)) {
        respond(callback, { success: false, error: "Slow down" });
        return;
      }
      const room = context.currentRoom;
      const hostId = context.currentClient.id;
      if (room.gameSession) {
        respond(callback, { success: false, error: "A game is already running" });
        return;
      }
      const gameId = normalizeGameId(data?.gameId);
      if (!gameId) {
        respond(callback, { success: false, error: "Invalid game id" });
        return;
      }
      const module = getGameModule(gameId);
      if (!module) {
        respond(callback, { success: false, error: "Unknown game" });
        return;
      }
      let players = snapshotPlayers(room);
      const initialPlayerError = validatePlayerCount(players, module);
      if (initialPlayerError) {
        respond(callback, { success: false, error: initialPlayerError });
        return;
      }
      const gameConfig = normalizeConfig(module.options, data?.options);

      let content: unknown | null = null;
      if (module.generateContent) {
        try {
          content = await module.generateContent({
            players,
            config: gameConfig,
            now: Date.now(),
          });
        } catch (error) {
          Logger.warn(`[Games] content generation failed for ${gameId}`, error);
        }
        if (sfuConfig.gameAi.enabled && content == null) {
          Logger.warn(`[Games] using bundled content fallback for ${gameId}`);
        }
      }

      try {
        if (room.gameSession) {
          respond(callback, { success: false, error: "A game is already running" });
          return;
        }
        const hostClient = room.clients.get(hostId);
        if (!(hostClient instanceof Admin) || hostClient.isObserver) {
          respond(callback, { success: false, error: "Only the host can start a game" });
          return;
        }
        players = snapshotPlayers(room);
        const currentPlayerError = validatePlayerCount(players, module);
        if (currentPlayerError) {
          respond(callback, { success: false, error: currentPlayerError });
          return;
        }
        stopGameLoop(room);
        room.gameSession = new GameSession({
          module,
          players,
          adminIds: collectAdminIds(room),
          hostId,
          config: gameConfig,
          content,
        });
      } catch (error) {
        Logger.error("[Games] failed to start", error);
        room.gameSession = null;
        respond(callback, { success: false, error: "Failed to start game" });
        return;
      }

      room.gameVote = null;
      broadcastVote(io, room);
      startGameLoop(io, room);
      broadcastGame(io, room);
      respond(callback, { success: true, gameId });
    },
  );

  socket.on(
    "game:vote:open",
    (data: GameVoteOpenData, callback: (response: GameVoteResponse) => void) => {
      if (!context.currentRoom || !context.currentClient) {
        respond(callback, { success: false, error: "Not in a room" });
        return;
      }
      if (!(context.currentClient instanceof Admin) || context.currentClient.isObserver) {
        respond(callback, { success: false, error: "Only the host can open a vote" });
        return;
      }
      if (context.currentRoom.gameSession) {
        respond(callback, { success: false, error: "A game is already running" });
        return;
      }
      if (!takeToken(socket, "game:vote:open", RATE_LIMITS.gameControl)) {
        respond(callback, { success: false, error: "Slow down" });
        return;
      }
      const allIds = getGameCatalog().map((entry) => entry.id);
      let candidates = allIds;
      if (Array.isArray(data?.candidates)) {
        const picked = data.candidates
          .map((value) => normalizeGameId(value))
          .filter((id): id is string => Boolean(id && getGameModule(id)));
        if (picked.length >= 2) candidates = Array.from(new Set(picked));
      }
      context.currentRoom.gameVote = { candidates, votes: {} };
      broadcastVote(io, context.currentRoom);
      respond(callback, { success: true });
    },
  );

  socket.on(
    "game:vote:cast",
    (data: GameVoteCastData, callback: (response: GameVoteResponse) => void) => {
      if (!context.currentRoom || !context.currentClient) {
        respond(callback, { success: false, error: "Not in a room" });
        return;
      }
      if (context.currentClient.isObserver) {
        respond(callback, { success: false, error: "Watch-only attendees cannot vote" });
        return;
      }
      if (!takeToken(socket, "game:vote:cast", RATE_LIMITS.gameMove)) {
        respond(callback, { success: false, error: "Slow down" });
        return;
      }
      const vote = context.currentRoom.gameVote;
      if (!vote) {
        respond(callback, { success: false, error: "No vote in progress" });
        return;
      }
      const gameId = normalizeGameId(data?.gameId);
      if (!gameId || !vote.candidates.includes(gameId)) {
        respond(callback, { success: false, error: "Invalid choice" });
        return;
      }
      vote.votes[context.currentClient.id] = gameId;
      broadcastVote(io, context.currentRoom);
      respond(callback, { success: true });
    },
  );

  socket.on("game:vote:cancel", (callback: (response: GameVoteResponse) => void) => {
    if (!context.currentRoom || !context.currentClient) {
      respond(callback, { success: false, error: "Not in a room" });
      return;
    }
    if (!(context.currentClient instanceof Admin) || context.currentClient.isObserver) {
      respond(callback, { success: false, error: "Only the host can cancel the vote" });
      return;
    }
    context.currentRoom.gameVote = null;
    broadcastVote(io, context.currentRoom);
    respond(callback, { success: true });
  });

  socket.on(
    "game:move",
    (data: GameMoveData, callback: (response: GameMoveResponse) => void) => {
      if (!context.currentRoom || !context.currentClient) {
        respond(callback, { success: false, error: "Not in a room" });
        return;
      }
      if (context.currentClient.isObserver) {
        respond(callback, { success: false, error: "Watch-only attendees cannot play" });
        return;
      }
      if (!takeToken(socket, "game:move", RATE_LIMITS.gameMove)) {
        respond(callback, { success: false, error: "Too many moves" });
        return;
      }
      const room = context.currentRoom;
      const session = room.gameSession;
      const gameId = normalizeGameId(data?.gameId);
      if (!session || !gameId || session.gameId !== gameId) {
        respond(callback, { success: false, error: "No active game" });
        return;
      }
      if (typeof data?.type !== "string" || data.type.length > MAX_GAME_ID_LENGTH) {
        respond(callback, { success: false, error: "Invalid move" });
        return;
      }

      let result: { ok: true } | { ok: false; error: string };
      try {
        syncGameSessionRoomMembership(room);
        result = session.applyMove(context.currentClient.id, data.type, data.payload);
      } catch (error) {
        Logger.warn("[Games] move failed", error);
        respond(callback, { success: false, error: "Move failed" });
        return;
      }
      if (!result.ok) {
        respond(callback, { success: false, error: result.error });
        return;
      }

      broadcastGame(io, room);
      if (session.isFinished()) {
        stopGameLoop(room);
      } else if (!room.gameTickTimer) {
        startGameLoop(io, room);
      }
      respond(callback, { success: true });
    },
  );

  socket.on("game:end", (callback: (response: GameEndResponse) => void) => {
    if (!context.currentRoom || !context.currentClient) {
      respond(callback, { success: false, error: "Not in a room" });
      return;
    }
    if (!(context.currentClient instanceof Admin) || context.currentClient.isObserver) {
      respond(callback, { success: false, error: "Only the host can end the game" });
      return;
    }
    const room = context.currentRoom;
    const gameId = room.gameSession?.gameId ?? null;
    room.clearGame();
    if (gameId) {
      io.to(room.channelId).emit("game:ended", { gameId });
    }
    respond(callback, { success: true });
  });

  socket.on("game:getState", (callback: (state: GameStateResponse) => void) => {
    respond(
      callback,
      buildGameStateResponse(
        context.currentRoom,
        context.currentClient?.id ?? null,
      ),
    );
  });
};
