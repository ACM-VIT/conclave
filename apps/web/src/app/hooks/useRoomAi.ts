"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  isResponseModel,
  getResponseProvider,
  type AiModelCatalog,
  type AiTextProvider,
} from "@conclave/ai/models";
import {
  ROOM_AI_PROVIDERS,
  emptyRoomAiState,
  type RoomAiProvider,
  type RoomAiState,
} from "@conclave/ai/room";

// Keep only public metadata from socket messages, never credentials.
export function parseRoomAiState(value: unknown): RoomAiState | null {
  if (!value || typeof value !== "object") return null;
  const state = emptyRoomAiState();
  const model = (value as Record<string, unknown>).assistantModel;
  if (model !== undefined && model !== null) {
    if (typeof model !== "string" || !isResponseModel(model)) return null;
    state.assistantModel = model;
  }
  for (const provider of ROOM_AI_PROVIDERS) {
    const entry = (value as Record<string, unknown>)[provider];
    if (!entry || typeof entry !== "object") return null;
    const { source, ownerId } = entry as Record<string, unknown>;
    if (source !== null && source !== "deployment" && source !== "room")
      return null;
    state[provider] = {
      source,
      ...(source === "room" && typeof ownerId === "string" ? { ownerId } : {}),
    };
  }
  return state;
}

export type RoomAiController = {
  state: RoomAiState;
  ready: boolean;
  connected: boolean;
  currentUserId: string;
  isAdmin: boolean;
  requestModels?: (options?: {
    provider?: AiTextProvider;
    apiKey?: string;
    refresh?: boolean;
  }) => Promise<AiModelCatalog[]>;
  configure: (
    provider: RoomAiProvider,
    apiKey: string | null | undefined,
    // null shares an audio/image-only credential without selecting text.
    model?: string | null,
  ) => Promise<string | null>;
};

// Compact setup controls use the same room credential store as full settings.
// Save before starting a feature so its server request can resolve the key.
export async function configureRoomAiForFeature(
  controller: RoomAiController,
  keys: Partial<Record<RoomAiProvider, string>>,
  model: string,
): Promise<string | null> {
  const modelProvider = getResponseProvider(model);
  for (const provider of ROOM_AI_PROVIDERS) {
    const key = keys[provider]?.trim();
    if (!key) continue;
    const error = await controller.configure(
      provider,
      key,
      provider === modelProvider ? model : null,
    );
    if (error) return error;
  }
  if (keys[modelProvider]?.trim() && controller.state.assistantModel !== model)
    return controller.configure(modelProvider, undefined, model);
  return null;
}

export function useRoomAi(
  socket: Socket | null,
  joined: boolean,
  currentUserId: string,
  isAdmin: boolean,
  roomId: string,
): RoomAiController {
  const [state, setState] = useState(emptyRoomAiState);
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const epoch = useRef(0);
  useEffect(() => {
    ++epoch.current;
    let active = true;
    setState(emptyRoomAiState());
    setReady(false);
    setConnected(Boolean(joined && socket?.connected));
    if (!socket || !joined) return;
    const refresh = () => {
      const generation = ++epoch.current;
      setConnected(true);
      socket
        .timeout(8000)
        .emit(
          "ai:settings",
          (error: Error | null, result: { state?: unknown } | undefined) => {
            if (
              !active ||
              epoch.current !== generation ||
              !socket.connected ||
              error
            )
              return;
            const next = parseRoomAiState(result?.state);
            if (next) {
              setState(next);
              setReady(true);
            }
          },
        );
    };
    const changed = (value: unknown) => {
      if (!active || !socket.connected) return;
      const next = parseRoomAiState(value);
      if (next) {
        setState(next);
        setReady(true);
      }
    };
    const disconnected = () => {
      ++epoch.current;
      setConnected(false);
      setReady(false);
      setState(emptyRoomAiState());
    };
    // The SFU sends ai:changed after joinRoom restores membership. Connecting
    // the transport alone is too early to request room settings.
    const reconnected = () => setConnected(true);
    socket.on("connect", reconnected);
    socket.on("disconnect", disconnected);
    socket.on("ai:changed", changed);
    if (socket.connected) refresh();
    return () => {
      active = false;
      ++epoch.current;
      socket.off("connect", reconnected);
      socket.off("disconnect", disconnected);
      socket.off("ai:changed", changed);
    };
  }, [socket, joined, currentUserId, roomId]);

  const configure = useCallback(
    async (
      provider: RoomAiProvider,
      apiKey: string | null | undefined,
      model?: string | null,
    ): Promise<string | null> => {
      if (!socket?.connected || !joined)
        return "Reconnect to the meeting to change AI settings.";
      const generation = epoch.current;
      return new Promise((resolve) => {
        socket.timeout(8000).emit(
          "ai:configure",
          {
            provider,
            roomId,
            ...(apiKey === null
              ? { remove: true }
              : apiKey !== undefined
                ? { apiKey }
                : {}),
            ...(model !== undefined ? { model } : {}),
          },
          (
            error: Error | null,
            result: { state?: unknown; error?: string } | undefined,
          ) => {
            if (generation !== epoch.current || !socket.connected) {
              resolve("The meeting connection changed. Please try again.");
              return;
            }
            if (error) {
              resolve("Room AI settings did not respond. Please try again.");
              return;
            }
            const next = parseRoomAiState(result?.state);
            if (!next) {
              resolve(result?.error || "Room AI settings could not be saved.");
              return;
            }
            setState(next);
            setReady(true);
            resolve(null);
          },
        );
      });
    },
    [socket, joined, roomId],
  );
  const requestModels = useCallback(
    async (
      options: {
        provider?: AiTextProvider;
        apiKey?: string;
        refresh?: boolean;
      } = {},
    ): Promise<AiModelCatalog[]> => {
      if (!socket?.connected || !joined)
        throw new Error("Reconnect to load models.");
      const generation = epoch.current;
      return new Promise((resolve, reject) => {
        socket
          .timeout(10_000)
          .emit(
            "ai:models",
            { roomId, ...options },
            (
              error: Error | null,
              result:
                { catalogs?: AiModelCatalog[]; error?: string } | undefined,
            ) => {
              if (
                error ||
                !socket.connected ||
                generation !== epoch.current ||
                !Array.isArray(result?.catalogs)
              ) {
                reject(
                  new Error(
                    result?.error || "Could not refresh models. Try again.",
                  ),
                );
                return;
              }
              resolve(result.catalogs);
            },
          );
      });
    },
    [socket, joined, roomId],
  );
  return {
    state,
    ready,
    connected,
    currentUserId,
    isAdmin,
    configure,
    requestModels,
  };
}
