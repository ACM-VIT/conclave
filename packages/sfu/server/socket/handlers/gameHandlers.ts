import { AI_PROVIDERS, readAiEnvironment } from "@conclave/ai/models";
import { ROOM_AI_PROVIDERS } from "@conclave/ai/room";
import { Admin } from "../../../config/classes/Admin.js";
import { config as sfuConfig } from "../../../config/config.js";
import { resolveAiFeatureSettings } from "@conclave/ai/room-settings";
import type { Room } from "../../../config/classes/Room.js";
import { GameSession } from "../../games/engine.js";
import { createGameDecider } from "../../games/decisions.js";
import type { AiEnvironment } from "@conclave/ai/models";
import { GameContentGenerationError, gameContentTopic } from "../../games/aiContent.js";
import { normalizeConfig } from "../../games/config.js";
import { getGameCatalog, getGameModule } from "../../games/registry.js";
import type {
  GameCatalogEntry,
  GameEndResponse,
  GameJoinResponse,
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
import { randomUUID } from "crypto";
import {
  captureGameEvent,
  registerGameCatalog,
  type AnalyticsProperties,
} from "../../analytics/posthog.js";
import { analyticsDistinctId } from "../../analytics/identity.js";

// Game events name only these games and their options (analytics/outbound.ts).
registerGameCatalog(getGameCatalog());

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

const TEXT_TOPIC_OPTION_ID = "topic";

type PlayAnalytics = {
  instanceId: string;
  gameId: string;
  startedAtMs: number;
  playerCount: number;
  hasLeaderboard: boolean;
  finishedSent: boolean;
};

const playAnalyticsBySession = new WeakMap<GameSession, PlayAnalytics>();

const describeDecisionError = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";

const roomGameAiEnvironment = (room: Room): AiEnvironment => ({
  ...Object.fromEntries(
    ROOM_AI_PROVIDERS.map((provider) => [
      AI_PROVIDERS[provider].keyEnv,
      room.aiCredentials.get(provider),
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(readAiEnvironment(process.env)).filter(([, value]) => Boolean(value)),
  ),
  CONCLAVE_AI_SETTINGS: JSON.stringify(
    room.aiCredentials.effectiveFeatureSettings(readAiEnvironment(process.env)),
  ),
  ...(room.aiCredentials.assistantModel
    ? { CONCLAVE_ASSISTANT_MODEL: room.aiCredentials.assistantModel }
    : {}),
});

const stableDistinctId = (room: Room, clientId: string): string =>
  analyticsDistinctId(room.userKeysById.get(clientId) ?? clientId);

const buildConfigProps = (
  gameId: string,
  config: Record<string, number | string> | undefined,
): AnalyticsProperties => {
  const module = getGameModule(gameId);
  const props: AnalyticsProperties = {};
  if (!config) return props;
  for (const opt of module?.options ?? []) {
    const value = config[opt.id];
    if (opt.type === "number") {
      if (typeof value === "number") props[`config_${opt.id}`] = value;
    } else if (opt.type === "select") {
      if (typeof value === "string") props[`config_${opt.id}`] = value;
    } else if (opt.id === TEXT_TOPIC_OPTION_ID) {
      props.has_topic = typeof value === "string" && value.trim().length > 0;
    } else {
      props[`has_${opt.id}`] =
        typeof value === "string" && value.trim().length > 0;
    }
  }
  return props;
};

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
  if (session.spectatable) {
    for (const client of room.clients.values()) {
      if (session.hasPlayer(client.id)) continue;
      client.socket.emit("game:view", {
        gameId: session.gameId,
        view: session.getPlayerView(client.id, now),
      });
    }
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

const buildGameStateResponse = (
  room: Room | null | undefined,
  playerId: string | null | undefined,
): GameStateResponse => {
  const selfId = playerId || undefined;
  if (!room) {
    return { active: false, vote: null, selfId };
  }

  const session = syncGameSessionRoomMembership(room);
  const vote = buildVoteState(room);
  if (!session) {
    return { active: false, vote, selfId };
  }

  const now = Date.now();
  const response: GameStateResponse = {
    active: true,
    public: session.getPublicState(now),
    vote,
    selfId,
  };
  if (playerId && (session.hasPlayer(playerId) || session.spectatable)) {
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
    maybeCaptureGameFinished(room);
  }, session.tickMs);
};

const maybeCaptureGameFinished = (room: Room): void => {
  const session = room.gameSession;
  if (!session || !session.isFinished()) return;
  const play = playAnalyticsBySession.get(session);
  if (!play || play.finishedSent) return;
  play.finishedSent = true;

  const now = Date.now();
  captureGameEvent({
    event: "game_finished",
    distinctId: stableDistinctId(room, session.hostId),
    roomKey: room.channelId,
    properties: {
      instance_id: play.instanceId,
      game_id: play.gameId,
      player_count: play.playerCount,
      duration_ms: now - play.startedAtMs,
      phase: session.getPublicState(now).phase,
      has_leaderboard: play.hasLeaderboard,
    },
  });
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
      if (room.gameSession && !room.gameSession.isFinished()) {
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
      if (room.gameGeneration) {
        respond(callback, {success: false, error: "A game is already starting."});
        return;
      }
      const generation = new AbortController();
      room.gameGeneration = {controller: generation, requestedBy: hostId};
      try {

        let content: unknown | null = null;
        if (module.generateContent) {
          try {
            content = await module.generateContent({
              signal: generation.signal,
              players,
              aiEnvironment: roomGameAiEnvironment(room),
              config: gameConfig,
              now: Date.now(),
            });
          } catch (error) {
            if (generation.signal.aborted) { respond(callback, {success: false, error: "Game creation cancelled."}); return; }
            Logger.warn(`[Games] content generation failed for ${gameId}`);
            respond(callback, {
              success: false,
              error:
                error instanceof GameContentGenerationError
                  ? error.message
                  : "Could not generate questions. Try again.",
            });
            return;
          }
          if (content == null && gameContentTopic(gameConfig)) {
            const serverDisabled = !sfuConfig.gameAi.enabled || /^(0|false)$/i.test(process.env.SFU_GAME_AI_ENABLED || "");
            const roomDisabled = !resolveAiFeatureSettings({}, "games", room.aiCredentials.featureSettings).enabled;
            respond(callback, {
              success: false,
              error:
                serverDisabled ? "AI generation is disabled on this server. Clear Topic for built-in content."
                  : roomDisabled ? "Enable Games in Room AI settings or clear Topic for built-in content."
                    : "Add a room AI key to generate a topic, or leave Topic blank for built-in content.",
            });
            return;
          }
        }

        try {
          if (generation.signal.aborted) { respond(callback, {success: false, error: "Game creation cancelled."}); return; }
          if (room.gameSession && !room.gameSession.isFinished()) {
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

        const session = room.gameSession;
        const startedAtMs = Date.now();
        const play: PlayAnalytics = {
          instanceId: randomUUID(),
          gameId,
          startedAtMs,
          playerCount: players.length,
          hasLeaderboard: Boolean(module.hasLeaderboard),
          finishedSent: false,
        };
        playAnalyticsBySession.set(session, play);
        captureGameEvent({
          event: "game_started",
          distinctId: stableDistinctId(room, hostId),
          roomKey: room.channelId,
          properties: {
            instance_id: play.instanceId,
            game_id: gameId,
            player_count: play.playerCount,
            has_leaderboard: play.hasLeaderboard,
            ...buildConfigProps(gameId, gameConfig),
          },
        });

        const resolvedVote = room.gameVote;
        if (resolvedVote) {
          captureGameEvent({
            event: "game_vote_resolved",
            distinctId: stableDistinctId(room, hostId),
            roomKey: room.channelId,
            properties: {
              instance_id: play.instanceId,
              game_id: gameId,
              candidate_count: resolvedVote.candidates.length,
              vote_count: Object.keys(resolvedVote.votes).length,
              player_count: play.playerCount,
            },
          });
        }

        room.gameVote = null;
        broadcastVote(io, room);
        startGameLoop(io, room);
        broadcastGame(io, room);
        maybeCaptureGameFinished(room);
        respond(callback, { success: true, gameId });
      } finally {
        if (room.gameGeneration?.controller === generation) room.gameGeneration = null;
      }
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
      captureGameEvent({
        event: "game_vote_opened",
        distinctId: stableDistinctId(
          context.currentRoom,
          context.currentClient.id,
        ),
        roomKey: context.currentRoom.channelId,
        properties: {
          candidate_count: candidates.length,
          player_count: countPlayers(context.currentRoom),
          is_full_catalog: candidates.length === allIds.length,
        },
      });
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
    const room = context.currentRoom;
    const cancelledVote = room.gameVote;
    if (cancelledVote) {
      captureGameEvent({
        event: "game_vote_cancelled",
        distinctId: stableDistinctId(room, context.currentClient.id),
        roomKey: room.channelId,
        properties: {
          candidate_count: cancelledVote.candidates.length,
          vote_count: Object.keys(cancelledVote.votes).length,
          player_count: countPlayers(room),
        },
      });
    }
    room.gameVote = null;
    broadcastVote(io, room);
    respond(callback, { success: true });
  });

  socket.on(
    "game:move",
    async (data: GameMoveData, callback: (response: GameMoveResponse) => void) => {
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

      const playerId = context.currentClient.id;
      const receivedAt = Date.now();
      let verified: unknown = null;
      if (session.module.prepareMove) {
        const prepared = await session.prepareMove(playerId, data.type, data.payload, {
          decide: createGameDecider(roomGameAiEnvironment(room)),
          signal: new AbortController().signal,
          receivedAt,
          onError: (error) => Logger.warn("[Games] move check failed", describeDecisionError(error)),
        });
        if (room.gameSession !== session || session.isFinished()) {
          respond(callback, { success: false, error: "Game has ended" });
          return;
        }
        if (!prepared.ok) {
          respond(callback, { success: false, error: prepared.error });
          return;
        }
        verified = prepared.verified;
      }

      let result: { ok: true } | { ok: false; error: string };
      try {
        syncGameSessionRoomMembership(room);
        result = session.applyMove(playerId, data.type, data.payload, { verified, receivedAt });
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
        maybeCaptureGameFinished(room);
      } else if (!room.gameTickTimer) {
        startGameLoop(io, room);
      }
      respond(callback, { success: true });
    },
  );

  socket.on("game:join", (callback: (response: GameJoinResponse) => void) => {
    if (!context.currentRoom || !context.currentClient) {
      respond(callback, { success: false, error: "Not in a room" });
      return;
    }
    if (context.currentClient.isObserver) {
      respond(callback, { success: false, error: "Observers cannot join games" });
      return;
    }
    if (!takeToken(socket, "game:join", RATE_LIMITS.gameControl)) {
      respond(callback, { success: false, error: "Slow down" });
      return;
    }
    const room = context.currentRoom;
    const session = room.gameSession;
    if (!session || session.isFinished()) {
      respond(callback, { success: false, error: "No game to join" });
      return;
    }
    const playerId = context.currentClient.id;
    const result = session.requestSeat({
      id: playerId,
      name: room.getDisplayNameForUser(playerId) ?? "Guest",
    });
    if (!result.ok) {
      respond(callback, { success: false, error: result.error });
      return;
    }
    broadcastGame(io, room);
    respond(callback, { success: true });
  });

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
    room.gameGeneration?.controller.abort();
    room.gameGeneration = null;
    const session = room.gameSession;
    const gameId = session?.gameId ?? null;

    if (session && !session.isFinished()) {
      const play = playAnalyticsBySession.get(session);
      if (play) {
        const now = Date.now();
        captureGameEvent({
          event: "game_ended",
          distinctId: stableDistinctId(room, context.currentClient.id),
          roomKey: room.channelId,
          properties: {
            instance_id: play.instanceId,
            game_id: play.gameId,
            player_count: play.playerCount,
            duration_ms: now - play.startedAtMs,
            phase: session.getPublicState(now).phase,
            has_leaderboard: play.hasLeaderboard,
          },
        });
      }
    }

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
