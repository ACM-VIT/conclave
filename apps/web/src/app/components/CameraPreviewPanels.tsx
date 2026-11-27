"use client";

import { lazy, type ComponentProps } from "react";
import type DeviceSettingsPanelComponent from "./DeviceSettingsPanel";
import MeetingPanelBoundary from "./MeetingPanelBoundary";
import type VideoEffectsPanelComponent from "./VideoEffectsPanel";

const VideoEffectsPanel = lazy(() => import("./VideoEffectsPanel"));
const DeviceSettingsPanel = lazy(() => import("./DeviceSettingsPanel"));

export type VideoEffectsPanelProps = ComponentProps<typeof VideoEffectsPanelComponent>;
export type DeviceSettingsPanelProps = ComponentProps<typeof DeviceSettingsPanelComponent>;

export default function CameraPreviewPanels({
  effects,
  settings,
}: {
  effects: VideoEffectsPanelProps | null;
  settings: DeviceSettingsPanelProps | null;
}) {
  return (
    <>
      {effects ? (
        <MeetingPanelBoundary
          key="video-effects"
          name="Backgrounds and effects"
          onClose={effects.onClose}
          onFailed={effects.onStopCameraPreview}
        >
          <VideoEffectsPanel {...effects} />
        </MeetingPanelBoundary>
      ) : null}
      {settings ? (
        <MeetingPanelBoundary
          key="device-settings"
          name="Settings"
          onClose={settings.onClose}
          onFailed={settings.onStopCameraPreview}
        >
          <DeviceSettingsPanel {...settings} />
        </MeetingPanelBoundary>
      ) : null}
    </>
  );
}
