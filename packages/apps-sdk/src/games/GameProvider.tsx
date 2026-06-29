import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Socket } from "socket.io-client";
import type {
  GameCatalogEntry,
  GameConfig,
  GameContextValue,
  GameMoveResult,
  GamePublicState,
  GameUser,
  GameVote,
} from "./types";

const ACK_TIMEOUT_MS = 8_000;
const START_GAME_ACK_TIMEOUT_MS = 45_000;

const GameContext = createContext<GameContextValue | null>(null);

const isPublicState = (value: unknown): value is GamePublicState => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.gameId === "string" &&
    typeof record.phase === "string" &&
    Array.isArray(record.players)
  );
};

const emitWithAck = <T,>(
  socket: Socket,
  event: string,
  payload: unknown,
  fallback: T,
  timeoutMs = ACK_TIMEOUT_MS,
): Promise<T> =>
  new Promise((resolve) => {
    let settled = false;
    const done = (value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => done(fallback), timeoutMs);
    const ack = (response: T) => {
      clearTimeout(timer);
      done(response);
    };
    if (payload === undefined) {
      socket.emit(event, ack);
    } else {
      socket.emit(event, payload, ack);
    }
  });

export type GameProviderProps = {
  socket: Socket | null;
  user?: GameUser;
  isAdmin?: boolean;
  isReadOnly?: boolean;
  children: React.ReactNode;
};

export function GameProvider({
  socket,
  user,
  isAdmin = false,
  isReadOnly = false,
  children,
}: GameProviderProps) {
  const [catalog, setCatalog] = useState<GameCatalogEntry[]>([]);
  const [publicState, setPublicState] = useState<GamePublicState | null>(null);
  const [view, setView] = useState<unknown>(null);
  const [vote, setVote] = useState<GameVote | null>(null);
  const activeGameIdRef = useRef<string | null>(null);

  const userId = user?.id ?? null;

  const applySnapshot = useCallback((state: unknown) => {
    if (!state || typeof state !== "object") return;
    const record = state as {
      active?: boolean;
      public?: unknown;
      view?: unknown;
      vote?: unknown;
    };
    if (record.active && isPublicState(record.public)) {
      activeGameIdRef.current = record.public.gameId;
      setPublicState(record.public);
      setView(record.view ?? null);
    } else {
      activeGameIdRef.current = null;
      setPublicState(null);
      setView(null);
    }
    setVote((record.vote as GameVote | null) ?? null);
  }, []);

  const refresh = useCallback(() => {
    if (!socket) return;
    socket.emit("game:getState", (state: unknown) => {
      applySnapshot(state);
    });
    socket.emit("game:list", (entries: unknown) => {
      if (Array.isArray(entries)) {
        setCatalog(entries as GameCatalogEntry[]);
      }
    });
  }, [socket, applySnapshot]);

  useEffect(() => {
    if (!socket) {
      setPublicState(null);
      setView(null);
      setVote(null);
      activeGameIdRef.current = null;
      return;
    }

    const onSnapshot = (state: unknown) => applySnapshot(state);

    const onState = (state: unknown) => {
      if (!isPublicState(state)) return;
      activeGameIdRef.current = state.gameId;
      setPublicState(state);
    };
    const onView = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const record = payload as { gameId?: unknown; view?: unknown };
      if (
        typeof record.gameId === "string" &&
        record.gameId === activeGameIdRef.current
      ) {
        setView(record.view ?? null);
      }
    };
    const onEnded = () => {
      activeGameIdRef.current = null;
      setPublicState(null);
      setView(null);
      setVote(null);
    };
    const onVote = (payload: unknown) => {
      setVote((payload as GameVote | null) ?? null);
    };

    socket.on("game:state", onState);
    socket.on("game:view", onView);
    socket.on("game:snapshot", onSnapshot);
    socket.on("game:ended", onEnded);
    socket.on("game:vote", onVote);
    socket.on("connect", refresh);
    refresh();

    return () => {
      socket.off("game:state", onState);
      socket.off("game:view", onView);
      socket.off("game:snapshot", onSnapshot);
      socket.off("game:ended", onEnded);
      socket.off("game:vote", onVote);
      socket.off("connect", refresh);
    };
  }, [socket, refresh, applySnapshot]);

  const startGame = useCallback(
    async (gameId: string, options?: GameConfig): Promise<GameMoveResult> => {
      if (isReadOnly) {
        return { success: false, error: "Observer mode is read-only" };
      }
      if (!socket) return { success: false, error: "Not connected" };
      return emitWithAck<GameMoveResult>(
        socket,
        "game:start",
        { gameId, options },
        { success: false, error: "Timed out" },
        START_GAME_ACK_TIMEOUT_MS,
      );
    },
    [socket, isReadOnly],
  );

  const endGame = useCallback(async (): Promise<GameMoveResult> => {
    if (isReadOnly) {
      return { success: false, error: "Observer mode is read-only" };
    }
    if (!socket) return { success: false, error: "Not connected" };
    return emitWithAck<GameMoveResult>(
      socket,
      "game:end",
      undefined,
      { success: false, error: "Timed out" },
    );
  }, [socket, isReadOnly]);

  const move = useCallback(
    async (type: string, payload?: unknown): Promise<GameMoveResult> => {
      if (isReadOnly) {
        return { success: false, error: "Observer mode is read-only" };
      }
      if (!socket) return { success: false, error: "Not connected" };
      const gameId = activeGameIdRef.current;
      if (!gameId) return { success: false, error: "No active game" };
      return emitWithAck<GameMoveResult>(
        socket,
        "game:move",
        { gameId, type, payload },
        { success: false, error: "Timed out" },
      );
    },
    [socket, isReadOnly],
  );

  const openVote = useCallback(
    async (candidateIds?: string[]): Promise<GameMoveResult> => {
      if (isReadOnly) {
        return { success: false, error: "Observer mode is read-only" };
      }
      if (!socket) return { success: false, error: "Not connected" };
      return emitWithAck<GameMoveResult>(
        socket,
        "game:vote:open",
        { candidates: candidateIds },
        { success: false, error: "Timed out" },
      );
    },
    [socket, isReadOnly],
  );

  const castVote = useCallback(
    async (gameId: string): Promise<GameMoveResult> => {
      if (isReadOnly) {
        return { success: false, error: "Observer mode is read-only" };
      }
      if (!socket) return { success: false, error: "Not connected" };
      return emitWithAck<GameMoveResult>(
        socket,
        "game:vote:cast",
        { gameId },
        { success: false, error: "Timed out" },
      );
    },
    [socket, isReadOnly],
  );

  const cancelVote = useCallback(async (): Promise<GameMoveResult> => {
    if (isReadOnly) {
      return { success: false, error: "Observer mode is read-only" };
    }
    if (!socket) return { success: false, error: "Not connected" };
    return emitWithAck<GameMoveResult>(
      socket,
      "game:vote:cancel",
      undefined,
      { success: false, error: "Timed out" },
    );
  }, [socket, isReadOnly]);

  const value = useMemo<GameContextValue>(
    () => ({
      catalog,
      publicState,
      view,
      vote,
      isActive: publicState !== null,
      isAdmin: isReadOnly ? false : isAdmin,
      isReadOnly,
      userId,
      startGame,
      endGame,
      move,
      openVote,
      castVote,
      cancelVote,
      refresh,
    }),
    [
      catalog,
      publicState,
      view,
      vote,
      isAdmin,
      isReadOnly,
      userId,
      startGame,
      endGame,
      move,
      openVote,
      castVote,
      cancelVote,
      refresh,
    ],
  );

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export const useGame = (): GameContextValue => {
  const context = useContext(GameContext);
  if (!context) {
    throw new Error("useGame must be used within a GameProvider");
  }
  return context;
};
