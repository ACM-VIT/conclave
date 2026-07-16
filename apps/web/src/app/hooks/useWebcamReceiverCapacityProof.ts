"use client";

import { useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  createWebcamReceiverCapacityProofCache,
  reduceWebcamReceiverCapacityProofCache,
  type WebcamReceiverCapacityProofCache,
} from "../lib/webcam-receiver-capacity-proof";

type UseWebcamReceiverCapacityProofOptions = {
  enabled: boolean;
  roomId: string | null;
  socket: Socket | null;
};

const nowMonotonic = () => performance.now();

export function useWebcamReceiverCapacityProof({
  enabled,
  roomId,
  socket,
}: UseWebcamReceiverCapacityProofOptions): WebcamReceiverCapacityProofCache {
  const [cache, setCache] = useState<WebcamReceiverCapacityProofCache>(() =>
    createWebcamReceiverCapacityProofCache(roomId),
  );

  useEffect(() => {
    if (!enabled || !roomId || !socket) {
      setCache(createWebcamReceiverCapacityProofCache(roomId));
      return;
    }

    setCache(createWebcamReceiverCapacityProofCache(roomId));
    const clear = () => {
      setCache(createWebcamReceiverCapacityProofCache(roomId));
    };
    const handleProof = (payload: unknown) => {
      setCache((current) =>
        reduceWebcamReceiverCapacityProofCache(
          current.roomId === roomId
            ? current
            : createWebcamReceiverCapacityProofCache(roomId),
          payload,
          roomId,
          nowMonotonic(),
        ),
      );
    };
    socket.on("webcamReceiverCapacityProof", handleProof);
    socket.on("disconnect", clear);
    return () => {
      socket.off("webcamReceiverCapacityProof", handleProof);
      socket.off("disconnect", clear);
      clear();
    };
  }, [enabled, roomId, socket]);

  return cache;
}
