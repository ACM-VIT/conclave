import { describe, expect, it, vi } from "vitest";
import {
  CAMERA_QUALITY_PRESETS,
  DEFAULT_MEDIA_QUALITY_SETTINGS,
  MEDIA_QUALITY_SETTINGS_STORAGE_KEY,
  SCREEN_SHARE_QUALITY_PRESETS,
  applyCameraQualityPreset,
  applyScreenSharePickerPreferences,
  applyScreenShareQualityPreset,
  getScreenShareLiveVideoSettingsSignature,
  getCameraBaseVideoQuality,
  normalizeMediaQualitySettings,
  readStoredMediaQualitySettings,
  resolveCameraPublishSettings,
  resolveEffectiveCameraPublishSettings,
  resolveScreenSharePublishSettings,
  writeStoredMediaQualitySettings,
} from "../src/app/lib/media-quality-settings";
import { buildCameraVideoConstraints } from "../src/app/lib/constants";
import {
  applyWebcamProducerNetworkProfile,
  buildScreenShareVideoConstraintsForNetworkProfile,
  produceScreenShareTrack,
  produceWebcamTrack,
} from "../src/app/lib/webcam-codec";
import type { Producer, Transport } from "../src/app/lib/types";

const createStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
};

const createTrack = (
  settings: MediaTrackSettings,
): MediaStreamTrack =>
  ({
    getSettings: () => settings,
  }) as unknown as MediaStreamTrack;

describe("media quality settings", () => {
  it("keeps the current optimized behavior as the persisted default", () => {
    const settings = normalizeMediaQualitySettings(null);

    expect(settings).toEqual(DEFAULT_MEDIA_QUALITY_SETTINGS);
    expect(resolveCameraPublishSettings(settings.camera)).toMatchObject({
      width: 1280,
      height: 720,
      frameRate: 30,
      maxBitrate: 1_650_000,
      contentHint: "motion",
    });
    expect(resolveScreenSharePublishSettings(settings.screenShare)).toMatchObject({
      idealWidth: 1920,
      idealHeight: 1080,
      maxWidth: 3840,
      maxHeight: 2160,
      frameRate: 24,
      maxBitrate: 2_500_000,
      includeAudio: true,
    });
  });

  it("sanitizes stale or hostile stored values", () => {
    const settings = normalizeMediaQualitySettings({
      camera: {
        preset: "unknown",
        resolution: "8k",
        frameRate: 500,
        maxBitrateKbps: -20,
        contentHint: "speech",
        degradationPreference: "never-degrade",
      },
      screenShare: {
        preset: "custom",
        resolution: "1440p",
        frameRate: 0,
        maxBitrateKbps: 999_999,
        contentHint: "motion",
        degradationPreference: "balanced",
        cursor: "never",
        includeAudio: false,
      },
    });

    expect(settings.camera).toEqual({
      ...DEFAULT_MEDIA_QUALITY_SETTINGS.camera,
      frameRate: 60,
      maxBitrateKbps: 100,
    });
    expect(settings.screenShare).toMatchObject({
      preset: "custom",
      resolution: "1440p",
      frameRate: 1,
      maxBitrateKbps: 15_000,
      contentHint: "motion",
      degradationPreference: "balanced",
      cursor: "never",
      includeAudio: false,
    });
  });

  it("round-trips versioned settings through storage", () => {
    const storage = createStorage();
    const settings = {
      camera: applyCameraQualityPreset(
        DEFAULT_MEDIA_QUALITY_SETTINGS.camera,
        "studio",
      ),
      screenShare: applyScreenShareQualityPreset(
        DEFAULT_MEDIA_QUALITY_SETTINGS.screenShare,
        "presentation",
      ),
    };

    writeStoredMediaQualitySettings(settings, storage);

    expect(storage.values.has(MEDIA_QUALITY_SETTINGS_STORAGE_KEY)).toBe(true);
    expect(readStoredMediaQualitySettings(storage)).toEqual(settings);
  });

  it("maps presets to real capture and publishing ceilings", () => {
    const dataSaver = applyCameraQualityPreset(
      DEFAULT_MEDIA_QUALITY_SETTINGS.camera,
      "data-saver",
    );
    const studio = applyCameraQualityPreset(
      dataSaver,
      "studio",
    );
    const presentation = applyScreenShareQualityPreset(
      DEFAULT_MEDIA_QUALITY_SETTINGS.screenShare,
      "presentation",
    );

    expect(dataSaver).toEqual({
      preset: "data-saver",
      ...CAMERA_QUALITY_PRESETS["data-saver"],
    });
    expect(getCameraBaseVideoQuality(dataSaver)).toBe("low");
    expect(resolveCameraPublishSettings(studio)).toMatchObject({
      width: 1920,
      height: 1080,
      frameRate: 60,
      maxBitrate: 4_000_000,
    });
    expect(presentation).toEqual({
      preset: "presentation",
      ...SCREEN_SHARE_QUALITY_PRESETS.presentation,
    });
  });

  it("reports the real effects output ceiling while preserving the configured camera ceiling", () => {
    const studio = applyCameraQualityPreset(
      DEFAULT_MEDIA_QUALITY_SETTINGS.camera,
      "studio",
    );

    expect(resolveEffectiveCameraPublishSettings(studio, true)).toMatchObject({
      width: 1280,
      height: 720,
      frameRate: 30,
      maxBitrate: 4_000_000,
    });
    expect(resolveEffectiveCameraPublishSettings(studio, false)).toMatchObject({
      width: 1920,
      height: 1080,
      frameRate: 60,
      maxBitrate: 4_000_000,
    });
  });

  it("keeps picker-only screen-share preferences out of the live video profile", () => {
    const current = DEFAULT_MEDIA_QUALITY_SETTINGS.screenShare;
    const currentSignature = getScreenShareLiveVideoSettingsSignature(current);
    const updated = applyScreenSharePickerPreferences(current, {
      includeAudio: false,
      cursor: "never",
    });

    expect(updated.preset).toBe("auto");
    expect(getScreenShareLiveVideoSettingsSignature(updated)).toBe(
      currentSignature,
    );
    expect(resolveScreenSharePublishSettings(updated)).toMatchObject({
      idealWidth: 1920,
      idealHeight: 1080,
      maxWidth: 3840,
      maxHeight: 2160,
      includeAudio: false,
      cursor: "never",
    });

    // Preserve the conservative ideal for settings written by the previous
    // picker updater, which incorrectly marked the otherwise-auto profile as
    // custom.
    expect(
      resolveScreenSharePublishSettings({ ...updated, preset: "custom" }),
    ).toMatchObject({
      idealWidth: 1920,
      idealHeight: 1080,
    });
  });

  it("honors a manual camera ceiling on good links and keeps safe downshifts", () => {
    const studio = resolveCameraPublishSettings({
      preset: "studio",
      ...CAMERA_QUALITY_PRESETS.studio,
    });

    expect(
      buildCameraVideoConstraints("standard", "good", undefined, studio),
    ).toMatchObject({
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 60, max: 60 },
    });
    expect(
      buildCameraVideoConstraints("standard", "fair", undefined, studio),
    ).toMatchObject({
      width: { ideal: 640, max: 640 },
      height: { ideal: 360, max: 360 },
      frameRate: { ideal: 20, max: 20 },
    });
  });

  it("uses manual camera bitrate and cadence in the actual producer encodings", async () => {
    const publishSettings = resolveCameraPublishSettings({
      preset: "studio",
      ...CAMERA_QUALITY_PRESETS.studio,
    });
    const producer = {} as Producer;
    const produce = vi.fn(async () => producer);

    await produceWebcamTrack({
      transport: { produce } as unknown as Transport,
      track: createTrack({ width: 1920, height: 1080, frameRate: 60 }),
      quality: "standard",
      networkProfile: "good",
      paused: false,
      publishSettings,
    });

    const options = produce.mock.calls[0]?.[0];
    expect(options?.encodings).toHaveLength(3);
    expect(options?.encodings?.[2]).toMatchObject({
      maxBitrate: 4_000_000,
      maxFramerate: 60,
    });
    expect(options?.encodings?.[0]?.maxBitrate).toBeLessThan(250_000);
  });

  it("reapplies a manual HD bitrate to an existing adaptive sender", async () => {
    const publishSettings = resolveCameraPublishSettings({
      preset: "high-definition",
      ...CAMERA_QUALITY_PRESETS["high-definition"],
    });
    const currentParameters: RTCRtpSendParameters = {
      encodings: [
        { rid: "q", maxBitrate: 80_000, maxFramerate: 12 },
        { rid: "h", maxBitrate: 220_000, maxFramerate: 20 },
        { rid: "f", maxBitrate: 1_650_000, maxFramerate: 30 },
      ],
      codecs: [],
      headerExtensions: [],
      rtcp: { cname: "test", reducedSize: true },
      transactionId: "initial",
    };
    const setParameters = vi.fn(async (parameters: RTCRtpSendParameters) => {
      currentParameters.encodings = parameters.encodings;
    });
    const producer = {
      kind: "video",
      closed: false,
      track: createTrack({ width: 1920, height: 1080, frameRate: 30 }),
      rtpSender: {
        getParameters: () => ({ ...currentParameters }),
        setParameters,
      },
      rtpParameters: {
        codecs: [{ mimeType: "video/VP8" }],
        encodings: [{ rid: "q" }, { rid: "h" }, { rid: "f" }],
      },
    } as unknown as Producer;

    await applyWebcamProducerNetworkProfile(producer, "standard", "good", {
      optimizeForSingleReceiver: true,
      publishSettings,
    });

    expect(setParameters).toHaveBeenCalledTimes(1);
    expect(currentParameters.encodings[2]).toMatchObject({
      maxBitrate: 3_000_000,
      maxFramerate: 30,
    });
    expect(currentParameters.encodings[0]).toMatchObject({
      maxBitrate: 35_000,
    });
  });

  it("applies screen-share capture, encoder, and browser preferences", async () => {
    const publishSettings = resolveScreenSharePublishSettings({
      preset: "motion",
      ...SCREEN_SHARE_QUALITY_PRESETS.motion,
    });
    expect(
      buildScreenShareVideoConstraintsForNetworkProfile(
        "good",
        publishSettings,
      ),
    ).toMatchObject({
      width: { ideal: 2560, max: 2560 },
      height: { ideal: 1440, max: 1440 },
      frameRate: { ideal: 30, max: 30 },
      cursor: "motion",
    });
    expect(
      buildScreenShareVideoConstraintsForNetworkProfile(
        "poor",
        publishSettings,
      ),
    ).toMatchObject({
      width: { ideal: 1600, max: 1920 },
      height: { ideal: 900, max: 1080 },
      frameRate: { ideal: 5, max: 5 },
    });

    const producer = {} as Producer;
    const produce = vi.fn(async () => producer);
    await produceScreenShareTrack({
      transport: { produce } as unknown as Transport,
      track: createTrack({ width: 2560, height: 1440, frameRate: 30 }),
      networkProfile: "good",
      publishSettings,
    });
    expect(produce.mock.calls[0]?.[0]?.encodings?.[0]).toMatchObject({
      maxBitrate: 4_500_000,
      maxFramerate: 30,
      scaleResolutionDownBy: 1,
    });
  });
});
