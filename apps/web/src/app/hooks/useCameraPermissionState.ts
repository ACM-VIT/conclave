"use client";

import { useEffect, useState } from "react";

export type CameraPermissionState = PermissionState | "unknown";

export function useCameraPermissionState(): CameraPermissionState {
  const [permissionState, setPermissionState] =
    useState<CameraPermissionState>("unknown");

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
      .query({ name: "camera" as PermissionName })
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
  }, []);

  return permissionState;
}
