"use client";

import type { MeetError } from "../lib/types";
import { isCameraAccessBlocked } from "../lib/utils";
import { useMediaPermissionState } from "./useMediaPermissionState";

export function useCameraAccessBlocked({
  hasLiveCamera,
  mediaError,
}: {
  hasLiveCamera: boolean;
  mediaError: MeetError | null | undefined;
}): boolean {
  const permissionState = useMediaPermissionState("camera");
  return isCameraAccessBlocked({ hasLiveCamera, permissionState, mediaError });
}
