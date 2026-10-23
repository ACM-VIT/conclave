"use client";

import { useEffect, useRef, useState } from "react";
import {
  AI_RESPONSE_MODELS,
  isProviderApiKey,
  type AiModelCatalog,
  type AiTextProvider,
  type TranscriptResponseModelConfig,
} from "@conclave/ai/models";
import type { RoomAiController } from "./useRoomAi";

export function useAiModels(
  controller?: RoomAiController,
  options: {
    enabled?: boolean;
    provider?: AiTextProvider;
    apiKey?: string;
  } = {},
) {
  const { enabled = true, provider, apiKey = "" } = options;
  const [models, setModels] =
    useState<readonly TranscriptResponseModelConfig[]>(AI_RESPONSE_MODELS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const force = useRef(false);
  const requestModels = controller?.requestModels;
  const roomState = controller?.state;
  const ready = controller?.ready && controller.connected;
  useEffect(() => {
    let active = true;
    setError(null);
    setLoading(false);
    if (!enabled || !ready || !requestModels) {
      setModels(AI_RESPONSE_MODELS);
      return;
    }
    const personalKey = apiKey.trim();
    if (
      personalKey &&
      (!provider ||
        personalKey.length < 20 ||
        !isProviderApiKey(provider, personalKey))
    )
      return;
    setLoading(true);
    const refresh = force.current;
    force.current = false;
    const timer = setTimeout(
      () => {
        void requestModels({
          ...(personalKey ? { provider, apiKey: personalKey } : {}),
          refresh,
        })
          .then((catalogs: AiModelCatalog[]) => {
            if (!active) return;
            setModels(catalogs.flatMap((catalog) => catalog.models));
            setError(
              catalogs
                .map((catalog) => catalog.error)
                .filter(Boolean)
                .join(" ") || null,
            );
          })
          .catch((failure: unknown) => {
            if (active)
              setError(
                failure instanceof Error
                  ? failure.message
                  : "Could not refresh models.",
              );
          })
          .finally(() => {
            if (active) setLoading(false);
          });
      },
      personalKey ? 600 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [requestModels, ready, roomState, enabled, provider, apiKey, revision]);
  return {
    models,
    loading,
    error,
    refresh: requestModels
      ? () => {
          force.current = true;
          setRevision((value) => value + 1);
        }
      : undefined,
  };
}
