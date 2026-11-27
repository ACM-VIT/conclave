"use client";

import type { MeetError } from "../lib/types";
import { isCameraAccessBlocked } from "../lib/utils";
import { useCameraPermissionState } from "./useCameraPermissionState";

export function useCameraAccessBlocked({
  hasLiveCamera,
  mediaError,
}: {
  hasLiveCamera: boolean;
  mediaError: MeetError | null | undefined;
}): boolean {
  const permissionState = useCameraPermissionState();
  return isCameraAccessBlocked({ hasLiveCamera, permissionState, mediaError });
}
