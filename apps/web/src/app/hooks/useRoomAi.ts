"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { parseRoomAiFeatureSettings, resolveAiFeatureSettings, type AiFeature, type AiFeatureSettings } from "@conclave/ai/room-settings";
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
  try {
    const features = (value as Record<string, unknown>).features;
    if (features !== undefined) state.features = parseRoomAiFeatureSettings(features);
  } catch { return null; }
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
  requestAccessToken?: (purpose: "voice" | "speech") => Promise<string>;
  requestModels?: (options?: {
    provider?: AiTextProvider;
    apiKey?: string;
    refresh?: boolean;
  }) => Promise<AiModelCatalog[]>;
  configureFeature?: (feature: AiFeature, settings: Partial<AiFeatureSettings>) => Promise<string | null>;
  configure: (
    provider: RoomAiProvider,
    apiKey: string | null | undefined,
    // null shares a credential without changing the legacy Chat model.
    model?: string | null,
  ) => Promise<string | null>;
};

// Compact setup controls use the same room credential store as full settings.
// Save before starting a feature so its server request can resolve the key.
export async function configureRoomAiForFeature(
  controller: RoomAiController,
  keys: Partial<Record<RoomAiProvider, string>>,
  model: string,
  features: AiFeature[] = ["assistant"],
): Promise<string | null> {
  const modelProvider = getResponseProvider(model);
  for (const provider of ROOM_AI_PROVIDERS) {
    const key = keys[provider]?.trim();
    if (!key) continue;
    const error = await controller.configure(
      provider,
      key,
      provider === modelProvider && features.includes("assistant") ? model : null,
    );
    if (error) return error;
  }
  if (controller.configureFeature) {
    for (const feature of features) {
      const current = resolveAiFeatureSettings({CONCLAVE_ASSISTANT_MODEL: controller.state.assistantModel ?? undefined}, feature, controller.state.features ?? {});
      if (current.model !== model) {
        const error = await controller.configureFeature(feature, {model});
        if (error) return error;
      }
    }
  } else if (features.includes("assistant") && controller.state.assistantModel !== model)
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

  const saveConfiguration = useCallback(
    async (data: Record<string, unknown>): Promise<string | null> => {
      if (!socket?.connected || !joined)
        return "Reconnect to the meeting to change AI settings.";
      const generation = epoch.current;
      return new Promise((resolve) => {
        socket.timeout(8000).emit(
          "ai:configure",
          {
            ...data,
            roomId,
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
  const configure = useCallback((provider: RoomAiProvider, apiKey: string | null | undefined, model?: string | null) => saveConfiguration({provider, ...(apiKey === null ? {remove: true} : apiKey !== undefined ? {apiKey} : {}), ...(model !== undefined ? {model} : {})}), [saveConfiguration]);
  const configureFeature = useCallback((feature: AiFeature, settings: Partial<AiFeatureSettings>) => saveConfiguration({feature, settings}), [saveConfiguration]);
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
  const accessTokens = useRef(new Map<string, {token: string; expiresAt: number; epoch: number}>());
  const requestAccessToken = useCallback(async (purpose: "voice" | "speech"): Promise<string> => {
    if (!socket?.connected || !joined) throw new Error("Reconnect to the meeting.");
    const generation = epoch.current;
    const cached = accessTokens.current.get(purpose);
    if (cached && cached.epoch === generation && cached.expiresAt > Date.now() + 15_000) return cached.token;
    return new Promise((resolve, reject) => socket.timeout(8000).emit("ai:access", {purpose}, (error: Error | null, result: {token?: string; expiresAt?: number; error?: string} | undefined) => {
      if (error || !socket.connected || generation !== epoch.current || typeof result?.token !== "string" || typeof result.expiresAt !== "number") {reject(new Error(result?.error || "AI access could not be loaded.")); return;}
      accessTokens.current.set(purpose, {token: result.token, expiresAt: result.expiresAt, epoch: generation});
      resolve(result.token);
    }));
  }, [socket, joined]);
  return {
    state,
    ready,
    connected,
    currentUserId,
    isAdmin,
    configure,
    configureFeature,
    requestModels,
    requestAccessToken,
  };
}
