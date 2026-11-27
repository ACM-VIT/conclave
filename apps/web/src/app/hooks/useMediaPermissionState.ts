"use client";

import { useEffect, useState } from "react";

export type MediaPermissionName = "camera" | "microphone";
export type MediaPermissionState = PermissionState | "unknown";

export function useMediaPermissionState(
  name: MediaPermissionName,
): MediaPermissionState {
  const [permissionState, setPermissionState] =
    useState<MediaPermissionState>("unknown");

  useEffect(() => {
    let cancelled = false;
    let permissionStatus: PermissionStatus | null = null;

    if (!navigator.permissions?.query) {
      return;
    }

    const handlePermissionChange = () => {
      if (!cancelled && permissionStatus) {
        setPermissionState(permissionStatus.state);
      }
    };

    navigator.permissions
      .query({ name })
      .then((status) => {
        if (cancelled) return;
        permissionStatus = status;
        setPermissionState(status.state);
        status.addEventListener("change", handlePermissionChange);
      })
      .catch(() => {
        if (!cancelled) setPermissionState("unknown");
      });

    return () => {
      cancelled = true;
      permissionStatus?.removeEventListener("change", handlePermissionChange);
    };
  }, [name]);

  return permissionState;
}
