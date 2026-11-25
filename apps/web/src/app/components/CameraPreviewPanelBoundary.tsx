"use client";

import type { ReactNode } from "react";
import MeetingPanelBoundary from "./MeetingPanelBoundary";

export default function CameraPreviewPanelBoundary({
  name,
  onClose,
  onStopCameraPreview,
  children,
}: {
  name: string;
  onClose: () => void;
  onStopCameraPreview?: () => void;
  children: ReactNode;
}) {
  return (
    <MeetingPanelBoundary name={name} onClose={onClose} onFailed={onStopCameraPreview}>
      {children}
    </MeetingPanelBoundary>
  );
}
