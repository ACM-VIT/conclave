"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type PrewarmState = {
  mediasoupDevice: typeof import("mediasoup-client").Device | null;
  socketIo: typeof import("socket.io-client").io | null;
  isReady: boolean;
};

type JoinInfo = {
  token: string;
  sfuUrl: string;
  iceServers?: RTCIceServer[];
};

type TokenCache = {
  roomId: string;
  token: string;
  sfuUrl: string;
  iceServers?: RTCIceServer[];
  timestamp: number;
};

const TOKEN_CACHE_TTL_MS = 30000;

export type PrewarmModules = {
  Device: typeof import("mediasoup-client").Device | null;
  io: typeof import("socket.io-client").io | null;
  isReady: boolean;
  prefetchToken: (
    roomId: string,
    sessionId: string,
    getJoinInfo: (
      roomId: string,
      sessionId: string,
      options?: { user?: { id?: string; email?: string | null; name?: string | null }; isHost?: boolean }
    ) => Promise<JoinInfo>,
    options?: { user?: { id?: string; email?: string | null; name?: string | null }; isHost?: boolean }
  ) => void;
  getCachedToken: (roomId: string) => JoinInfo | null;
};

export function usePrewarmSocket(): PrewarmModules {
  const [state, setState] = useState<PrewarmState>({
    mediasoupDevice: null,
    socketIo: null,
    isReady: false,
  });

  const startedRef = useRef(false);
  const tokenCacheRef = useRef<TokenCache | null>(null);
  const prefetchingRef = useRef<string | null>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const prewarm = async () => {
      const startTime = performance.now();

      const [mediasoupModule, socketIoModule] = await Promise.all([
        import("mediasoup-client"),
        import("socket.io-client"),
      ]);

      const duration = performance.now() - startTime;
      console.log(`[Meets] Pre-warmed libraries in ${duration.toFixed(0)}ms`);

      setState({
        mediasoupDevice: mediasoupModule.Device,
        socketIo: socketIoModule.io,
        isReady: true,
      });
    };

    prewarm().catch((err) => {
      console.warn("[Meets] Failed to prewarm libraries:", err);
    });
  }, []);

  const prefetchToken = useCallback(
    (
      roomId: string,
      sessionId: string,
      getJoinInfo: (
        roomId: string,
        sessionId: string,
        options?: { user?: { id?: string; email?: string | null; name?: string | null }; isHost?: boolean }
      ) => Promise<JoinInfo>,
      options?: { user?: { id?: string; email?: string | null; name?: string | null }; isHost?: boolean }
    ) => {
      if (!roomId.trim()) return;

      const cached = tokenCacheRef.current;
      if (
        cached &&
        cached.roomId === roomId &&
        Date.now() - cached.timestamp < TOKEN_CACHE_TTL_MS
      ) {
        return;
      }

      if (prefetchingRef.current === roomId) return;
      prefetchingRef.current = roomId;

      const startTime = performance.now();

      getJoinInfo(roomId, sessionId, options)
        .then(({ token, sfuUrl, iceServers }) => {
          const duration = performance.now() - startTime;
          console.log(`[Meets] Pre-fetched token in ${duration.toFixed(0)}ms`);

          tokenCacheRef.current = {
            roomId,
            token,
            sfuUrl,
            iceServers,
            timestamp: Date.now(),
          };
        })
        .catch((err) => {
          console.warn("[Meets] Failed to prefetch token:", err);
        })
        .finally(() => {
          if (prefetchingRef.current === roomId) {
            prefetchingRef.current = null;
          }
        });
    },
    []
  );

  const getCachedToken = useCallback(
    (roomId: string): JoinInfo | null => {
      const cached = tokenCacheRef.current;
      if (!cached) return null;
      if (cached.roomId !== roomId) return null;
      if (Date.now() - cached.timestamp >= TOKEN_CACHE_TTL_MS) {
        tokenCacheRef.current = null;
        return null;
      }
      console.log("[Meets] Using cached token");
      return {
        token: cached.token,
        sfuUrl: cached.sfuUrl,
        iceServers: cached.iceServers,
      };
    },
    []
  );

  return {
    Device: state.mediasoupDevice,
    io: state.socketIo,
    isReady: state.isReady,
    prefetchToken,
    getCachedToken,
  };
}
