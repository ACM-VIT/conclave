import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const files = {
  webConstants: "apps/web/src/app/lib/constants.ts",
  webCodec: "apps/web/src/app/lib/webcam-codec.ts",
  webNetworkInformation: "apps/web/src/app/lib/network-information.ts",
  webConnectionQuality: "apps/web/src/app/hooks/useConnectionQuality.ts",
  webAdaptivePublishQuality:
    "apps/web/src/app/hooks/useAdaptivePublishQuality.ts",
  webAdaptiveConsumerPreferences:
    "apps/web/src/app/hooks/useAdaptiveConsumerPreferences.ts",
  webPlaybackRecovery: "apps/web/src/app/lib/playback-recovery.ts",
  webParticipantVideo: "apps/web/src/app/components/ParticipantVideo.tsx",
  webGridLayout: "apps/web/src/app/components/GridLayout.tsx",
  webPresentationLayout: "apps/web/src/app/components/PresentationLayout.tsx",
  webMobilePresentationLayout:
    "apps/web/src/app/components/mobile/MobilePresentationLayout.tsx",
  webMeetClient: "apps/web/src/app/meets-client.tsx",
  webMeetMedia: "apps/web/src/app/hooks/useMeetMedia.ts",
  webMeetSocket: "apps/web/src/app/hooks/useMeetSocket.ts",
  webJoinScreen: "apps/web/src/app/components/JoinScreen.tsx",
  webMobileJoinScreen: "apps/web/src/app/components/mobile/MobileJoinScreen.tsx",
  webLowBandwidthProbe: "scripts/probe-low-bandwidth-meet.mjs",
  iosWebrtc:
    "apps/conclave-skip/Sources/Conclave/Core/WebRTC/WebRTCClient.swift",
  androidWebrtc:
    "apps/conclave-skip/Sources/Conclave/Skip/WebRTCClient+Android.kt",
  nativeMeetingViewModel:
    "apps/conclave-skip/Sources/Conclave/Features/Meeting/MeetingViewModel.swift",
  iosReachability:
    "apps/conclave-skip/Sources/Conclave/Core/Networking/NetworkReachabilityMonitor.swift",
  androidReachability:
    "apps/conclave-skip/Sources/Conclave/Skip/NetworkReachabilityMonitor.kt",
  sfuRoom: "packages/sfu/config/classes/Room.ts",
  sfuConfig: "packages/sfu/config/config.ts",
  sfuDisconnectHandlers:
    "packages/sfu/server/socket/handlers/disconnectHandlers.ts",
};

const source = Object.fromEntries(
  Object.entries(files).map(([key, file]) => [
    key,
    readFileSync(resolve(root, file), "utf8"),
  ]),
);

const failures = [];

const assertIncludes = (key, snippet, label) => {
  if (!source[key].includes(snippet)) {
    failures.push(`${label} missing in ${relative(root, resolve(root, files[key]))}`);
  }
};

const assertRegex = (key, regex, label) => {
  if (!regex.test(source[key])) {
    failures.push(`${label} missing in ${relative(root, resolve(root, files[key]))}`);
  }
};

const assertNotIncludes = (key, snippet, label) => {
  if (source[key].includes(snippet)) {
    failures.push(`${label} present in ${relative(root, resolve(root, files[key]))}`);
  }
};

const compact = (value) => value.replace(/\s+/g, " ");
const includesAny = (value, needles) =>
  needles.some((needle) => value.includes(needle));

// Audio has to stay codec-identical per profile for bundled audio m-lines.
assertRegex(
  "webConstants",
  /fair:\s*48000,[\s\S]*poor:\s*32000,[\s\S]*emergency:\s*24000,/,
  "web microphone Opus crisp constrained ladder",
);
assertRegex(
  "webConstants",
  /fair:\s*MICROPHONE_OPUS_MAX_AVERAGE_BITRATE_BY_PROFILE\.fair,[\s\S]*poor:\s*MICROPHONE_OPUS_MAX_AVERAGE_BITRATE_BY_PROFILE\.poor,[\s\S]*emergency:\s*MICROPHONE_OPUS_MAX_AVERAGE_BITRATE_BY_PROFILE\.emergency,/,
  "web screen-audio Opus tracks microphone ladder",
);
assertRegex(
  "iosWebrtc",
  /case \.emergency:\s*return 18_000[\s\S]*case \.poor:\s*return 24_000[\s\S]*case \.fair:\s*return 32_000/,
  "iOS microphone Opus constrained ladder",
);
assertRegex(
  "androidWebrtc",
  /ConnectionQuality\.emergency -> 18_000[\s\S]*ConnectionQuality\.poor -> 24_000[\s\S]*ConnectionQuality\.fair -> 32_000/,
  "Android microphone Opus constrained ladder",
);

// Codec preference should not globally force VP8: Safari/iOS/Android benefit
// from H264 hardware acceleration, while desktop browsers can still prefer VP8
// for simulcast.
assertIncludes(
  "webCodec",
  "isLikelyHardwareAcceleratedH264Browser",
  "web hardware-sensitive browser codec detection",
);
assertIncludes(
  "webCodec",
  "SOFTWARE_VP8_SENSITIVE_CODEC_MIME_TYPES",
  "web H264-first codec list for hardware-sensitive browsers",
);
assertIncludes(
  "webCodec",
  "SIMULCAST_FRIENDLY_CODEC_MIME_TYPES",
  "web VP8-first codec list for simulcast-friendly browsers",
);
assertIncludes(
  "webCodec",
  "getPreferredVideoCodecMimeTypes()",
  "web codec preference is browser-aware",
);
assertNotIncludes(
  "webCodec",
  'PREFERRED_WEBCAM_CODEC_MIME_TYPES = ["video/VP8"]',
  "web must not globally force VP8 webcam codec",
);

// Webcam publish must keep poor distinct from emergency: poor preserves more
// motion/detail, while emergency is the survival floor.
assertIncludes(
  "webCodec",
  "layerRank === 0 ? 120000 : 160000",
  "web poor webcam bitrate cap",
);
assertIncludes(
  "webCodec",
  "maxFramerate: Math.min(base.maxFramerate, 12)",
  "web poor webcam framerate cap",
);
assertIncludes(
  "webCodec",
  "const fairFramerateCaps = [15, 24, 30];",
  "web fair webcam preserves motion cadence",
);
assertIncludes(
  "webCodec",
  "layerRank === 0 ? 65000 : 90000",
  "web emergency webcam bitrate cap",
);
assertIncludes(
  "webCodec",
  "maxFramerate: Math.min(base.maxFramerate, 8)",
  "web emergency webcam framerate cap",
);
assertIncludes(
  "webCodec",
  "LOW_BANDWIDTH_BASE_LAYER_TARGETS",
  "web low-bandwidth webcam sender downscale targets",
);
assertIncludes(
  "webCodec",
  "Math.max(profileAdjusted, targetScale)",
  "web poor/emergency webcam keeps sender downscale without capture churn",
);
assertRegex(
  "webCodec",
  /const fallbackScaleResolutionDownBy = getCaptureAdjustedScaleResolutionDownBy\(\s*undefined,\s*profile,\s*0,\s*captureSize,\s*\);[\s\S]*scaleResolutionDownBy: fallbackScaleResolutionDownBy/,
  "web fallback webcam profile caps include sender downscale",
);
assertIncludes(
  "webCodec",
  "FAIR_BANDWIDTH_ACTIVE_LAYER_TARGET",
  "web fair webcam sender downscale target",
);
assertIncludes(
  "webCodec",
  'profile === "fair" && layerRank <= 1',
  "web fair active webcam layers downscale without capture churn",
);
assertIncludes(
  "iosWebrtc",
  "case .poor:\n            let bitrateCaps = [120_000, 160_000, 180_000]\n            let framerateCaps: [Double] = [12, 12, 15]",
  "iOS poor webcam caps",
);
assertIncludes(
  "iosWebrtc",
  "case .emergency:\n            let bitrateCaps = [65_000, 90_000, 120_000]\n            let framerateCaps: [Double] = [8, 8, 8]",
  "iOS emergency webcam caps",
);
assertIncludes(
  "iosWebrtc",
  "return min(spec.scaleResolutionDownBy, 2)",
  "iOS constrained active webcam layer avoids 160x90",
);
assertIncludes(
  "androidWebrtc",
  "ConnectionQuality.poor -> {\n                bitrateCaps = listOf(120_000, 160_000, 180_000)\n                framerateCaps = listOf(12, 12, 15)",
  "Android poor webcam caps",
);
assertIncludes(
  "androidWebrtc",
  "ConnectionQuality.emergency -> {\n                bitrateCaps = listOf(65_000, 90_000, 120_000)\n                framerateCaps = listOf(8, 8, 8)",
  "Android emergency webcam caps",
);
assertIncludes(
  "androidWebrtc",
  "minOf(spec.scaleResolutionDownBy, 2.0)",
  "Android constrained active webcam layer avoids 160x90",
);

// Screen share must preserve text/detail by maintaining resolution and cutting
// frame rate first.
for (const [key, label] of [
  ["webCodec", "web"],
  ["iosWebrtc", "iOS"],
  ["androidWebrtc", "Android"],
]) {
  const text = compact(source[key]);
  if (
    !text.includes("emergency") ||
    !includesAny(text, ["220_000", "220000"]) ||
    !includesAny(text, ["maxFramerate: 3", "maxFramerate = 3"])
  ) {
    failures.push(`${label} emergency screen-share cap missing`);
  }
  if (
    !text.includes("poor") ||
    !includesAny(text, ["450_000", "450000"]) ||
    !includesAny(text, ["maxFramerate: 5", "maxFramerate = 5"])
  ) {
    failures.push(`${label} poor screen-share cap missing`);
  }
}
assertIncludes(
  "webCodec",
  "SCREEN_SHARE_DEGRADATION_PREFERENCE",
  "web screen share maintain-resolution preference",
);
assertIncludes(
  "iosWebrtc",
  "next.degradationPreference = .maintainResolution",
  "iOS screen share maintain-resolution preference",
);
assertIncludes(
  "androidWebrtc",
  "screenShareTemporalLayerCount",
  "Android screen share temporal layering",
);

// Multi-stream rooms should not downgrade because one RTP stream has a short
// startup jitter spike. Use aggregate/weighted jitter and leave the first loss
// downgrade tolerant enough for otherwise healthy links.
assertIncludes(
  "webConnectionQuality",
  "const LOSS_FAIR = 0.05; // 5%",
  "web fair packet-loss threshold",
);
assertIncludes(
  "webConnectionQuality",
  "const JITTER_EMERGENCY_MS = 120;",
  "web emergency jitter threshold",
);
assertIncludes(
  "webConnectionQuality",
  "inboundJitterWeightedMs += jitter * 1000 * jitterWeight",
  "web weighted inbound jitter",
);
assertIncludes(
  "webPlaybackRecovery",
  "const MAX_ANIMATION_FRAME_REPLAYS = 8;",
  "web playback recovery animation-frame replay cap",
);
assertIncludes(
  "webPlaybackRecovery",
  "const MIN_SCHEDULE_INTERVAL_MS = 350;",
  "web playback recovery schedule throttle",
);
for (const [key, label] of [
  ["webParticipantVideo", "participant video"],
  ["webGridLayout", "grid video"],
  ["webPresentationLayout", "presentation video"],
  ["webMobilePresentationLayout", "mobile presentation video"],
]) {
  assertNotIncludes(
    key,
    'addEventListener("suspend", scheduleReplay)',
    `web ${label} should not replay on benign suspend events`,
  );
}
assertRegex(
  "webAdaptiveConsumerPreferences",
  /const effectiveQuality = worstQuality\([\s\S]*options\.quality === "good" \|\| options\.quality === "fair"[\s\S]*\? "unknown"[\s\S]*: getConsumerScoreQualityHint/,
  "web consumer scores must not lower good/fair receive stats",
);
assertIncludes(
  "webConnectionQuality",
  "if (browserNetwork.emergency || browserNetwork.saveData === true)",
  "web live browser hints only force adaptation for emergency/save-data",
);
assertIncludes(
  "webConnectionQuality",
  "const hasBandwidthQualityLimitation = (reason: string | null): boolean =>",
  "web connection quality ignores non-network encoder limitations",
);
assertIncludes(
  "webConnectionQuality",
  "mediaBitrate >= threshold * AVAILABLE_BITRATE_SATURATION_RATIO",
  "web available-bitrate quality must not be sustained by intentional caps",
);
assertIncludes(
  "webConnectionQuality",
  "mediaBitrate >= emergencyBitrate * AVAILABLE_BITRATE_SATURATION_RATIO",
  "web emergency mode must not be sustained by intentional caps",
);
assertNotIncludes(
  "webConnectionQuality",
  'reason === "cpu"',
  "web CPU encoder limitation must not drive network downgrades",
);
assertIncludes(
  "webAdaptiveConsumerPreferences",
  "const MAX_WEBCAMS_TO_KEEP_FULL_ON_GOOD_LINKS = 4;",
  "web good-link rooms keep small calls at full webcam layers",
);
assertRegex(
  "webMeetSocket",
  /const existingWebcamVideoConsumerCount = Array\.from\([\s\S]*producerMapRef\.current\.values\(\)[\s\S]*info\.kind === "video" && info\.type === "webcam"[\s\S]*preferHighWebcamLayer:[\s\S]*joinMode === "webinar_attendee" \|\|[\s\S]*existingWebcamVideoConsumerCount < 4/,
  "web initial small-call webcam consumers request high layers immediately",
);
assertIncludes(
  "webAdaptiveConsumerPreferences",
  "isFocus ||\n      isVisible ||",
  "web visible good-link webcams keep full spatial layer",
);
assertIncludes(
  "webAdaptiveConsumerPreferences",
  "isVisible ? bounds.maxTemporalLayer : 0",
  "web visible good-link tiles keep max temporal layer",
);
assertIncludes(
  "webAdaptiveConsumerPreferences",
  "isVisible || isFocus ? bounds.maxTemporalLayer : 1",
  "web visible fair-link tiles keep max temporal layer",
);
assertIncludes(
  "webAdaptiveConsumerPreferences",
  "paused: quality === \"poor\"",
  "web hidden consumers stay warm unless receive quality is poor",
);
assertIncludes(
  "webConstants",
  "export const BACKGROUND_TRANSPORT_DISCONNECT_GRACE_MS = 18000;",
  "web background transport disconnect grace",
);
assertRegex(
  "webMeetClient",
  /const browserPublishRecoveryQuality = selfConnectionStats\.browserNetwork[\s\S]*browserPublishRecoveryQuality === "good"[\s\S]*\? "good"[\s\S]*: selfPublishQuality/,
  "web cap recovery browser hint only restores good profile",
);
assertNotIncludes(
  "webMeetClient",
  "? (selfConnectionStats.browserNetwork.quality as ConnectionQuality)",
  "web raw browser quality must not hold live publish caps down",
);
assertNotIncludes(
  "webMeetMedia",
  "shouldReopenVideoTrackForQuality",
  "web must not reopen live cameras because settings undershoot constraints",
);
assertNotIncludes(
  "webMeetMedia",
  "cameraQualityReopenBackoffRef",
  "web camera quality changes must not create reopen/backoff churn",
);
assertIncludes(
  "webMeetMedia",
  "Camera constraints update failed; refreshing capture once",
  "web quality switch refreshes capture when constraints fail",
);
assertIncludes(
  "webMeetMedia",
  "shouldRefreshVideoTrackForQualitySwitch",
  "web quality switch refreshes capture when constraints undershoot",
);
assertIncludes(
  "webMeetMedia",
  "settings.width <= lowQualityWidth * 1.05",
  "web standard-quality camera refresh only reopens low-width captures",
);
assertIncludes(
  "webMeetMedia",
  "settings.height <= lowQualityHeight * 1.05",
  "web standard-quality camera refresh only reopens low-height captures",
);
assertIncludes(
  "webMeetMedia",
  "shouldUpdateCaptureConstraintsForQualitySwitch",
  "web capture constraint updates are gated to upgrades",
);
assertIncludes(
  "webMeetMedia",
  'quality === "standard" && profile === "good"',
  "web downgrades avoid camera capture restarts",
);
assertIncludes(
  "webMeetMedia",
  "const getUsableProducerTransport =",
  "web media publish paths centralize producer transport usability",
);
assertIncludes(
  "webMeetMedia",
  'transport.connectionState === "failed"',
  "web media publish paths rebuild failed producer transports",
);
assertIncludes(
  "webMeetSocket",
  "const getUsableProducerTransport =",
  "web socket producer transport creation centralizes usability",
);
assertIncludes(
  "webMeetSocket",
  "existingTransport.close();",
  "web producer transport recovery closes unusable transports before rebuilding",
);
{
  const text = source.webMeetMedia;
  const start = text.indexOf("const handleLocalTrackEnded = useCallback(");
  const end = text.indexOf("const requestMediaPermissions = useCallback", start);
  if (start < 0 || end < 0) {
    failures.push("web local track-ended handler missing");
  } else {
    const section = compact(text.slice(start, end));
    if (
      !section.includes(
        'connectionStateRef.current === "joined") { console.warn( "[Meets] Local audio track ended unexpectedly; recovering audio producer."',
      )
    ) {
      failures.push(
        "web unexpected audio track ends must preserve mic intent in joined meetings",
      );
    }
    if (!section.includes("setAudioProducerRecoveryPulse((value) => value + 1)")) {
      failures.push(
        "web unexpected audio track ends must trigger producer recovery",
      );
    }
    if (
      !section.includes(
        'connectionStateRef.current === "joined") { console.warn( "[Meets] Local video track ended unexpectedly; recovering camera producer."',
      )
    ) {
      failures.push(
        "web unexpected camera track ends must preserve camera intent in joined meetings",
      );
    }
    if (!section.includes("setCameraProducerRecoveryPulse((value) => value + 1)")) {
      failures.push(
        "web unexpected camera track ends must trigger producer recovery",
      );
    }
  }
}
{
  const text = source.webMeetMedia;
  const start = text.indexOf("const updateVideoQuality = useCallback(");
  const end = text.indexOf(
    "useEffect(() => {\n    updateVideoQualityRef.current = updateVideoQuality;",
    start,
  );
  if (start < 0 || end < 0) {
    failures.push("web video-quality update section missing");
  } else {
    const section = text.slice(start, end);
    if (!section.includes("let transport = getUsableProducerTransport(")) {
      failures.push(
        "web video-quality producer recreation must reject failed transports",
      );
    }
    if (!section.includes("await ensureProducerTransportRef?.current?.()")) {
      failures.push(
        "web video-quality producer recreation must rebuild failed transports",
      );
    }
  }
}
{
  const text = source.webMeetMedia;
  const start = text.indexOf("const recoverAudioProducer = async () => {");
  const end = text.indexOf("void recoverAudioProducer();", start);
  if (start < 0 || end < 0) {
    failures.push("web audio producer recovery section missing");
  } else {
    const section = text.slice(start, end);
    if (!section.includes("let transport = getUsableProducerTransport(")) {
      failures.push("web audio producer recovery must reject failed transports");
    }
    if (!section.includes("await ensureProducerTransportRef?.current?.()")) {
      failures.push("web audio producer recovery must rebuild failed transports");
    }
    const transportSectionEnd = section.indexOf("let audioTrack");
    const transportSection =
      transportSectionEnd >= 0 ? section.slice(0, transportSectionEnd) : section;
    if (
      !transportSection.includes(
        "Audio producer recovery waiting for producer transport.",
      )
    ) {
      failures.push(
        "web audio producer recovery must treat transport rebuild as retryable",
      );
    }
    if (
      transportSection.includes('throw new Error("Audio transport unavailable")')
    ) {
      failures.push(
        "web audio producer recovery must not mute users for retryable transport rebuilds",
      );
    }
    if (!text.includes("audioProducerRecoveryPulse,")) {
      failures.push("web audio producer recovery must be pulse-triggered");
    }
    if (!section.includes("setAudioProducerRecoveryPulse((value) => value + 1)")) {
      failures.push(
        "web audio producer transport close must trigger producer recovery",
      );
    }
  }
}
{
  const text = source.webMeetMedia;
  const start = text.indexOf('"[Meets] Audio producer recovery triggered:"');
  const end = text.indexOf("const recoverAudioProducer = async () => {", start);
  if (start < 0 || end < 0) {
    failures.push("web audio producer recovery watchdog missing");
  } else {
    const section = text.slice(start, end);
    if (!section.includes("requestAudioProducerRecovery();")) {
      failures.push(
        "web audio producer watchdog must pulse producer recovery",
      );
    }
    if (!section.includes('connectionState !== "joined"')) {
      failures.push(
        "web audio producer watchdog must only run in joined meetings",
      );
    }
    if (!section.includes("if (isMuted) return;")) {
      failures.push(
        "web audio producer watchdog must preserve muted intent",
      );
    }
    if (!section.includes("window.setInterval(")) {
      failures.push(
        "web audio producer watchdog must retry after transport rebuild delays",
      );
    }
  }
}
{
  const mediaText = source.webMeetMedia;
  if (!mediaText.includes("const requestAudioProducerRecovery = useCallback(")) {
    failures.push(
      "web media hook must expose explicit audio producer recovery pulse",
    );
  }
  if (!source.webMeetClient.includes("requestAudioProducerRecovery,")) {
    failures.push(
      "web meet client must pass audio producer recovery pulse to socket hook",
    );
  }
  if (!mediaText.includes("const requestCameraProducerRecovery = useCallback(")) {
    failures.push(
      "web media hook must expose explicit camera producer recovery pulse",
    );
  }
  if (!source.webMeetClient.includes("requestCameraProducerRecovery,")) {
    failures.push(
      "web meet client must pass camera producer recovery pulse to socket hook",
    );
  }

  const socketText = source.webMeetSocket;
  const start = socketText.indexOf('"producerClosed"');
  const end = socketText.indexOf('"userJoined"', start);
  if (start < 0 || end < 0) {
    failures.push("web producer-closed socket handler missing");
  } else {
    const section = socketText.slice(start, end);
    if (!section.includes("const liveAudioTrack = getFirstLiveTrack(")) {
      failures.push(
        "web local audio producer-close recovery must inspect live mic tracks",
      );
    }
    if (
      !section.includes("!isMutedRef.current && liveAudioTrack !== null")
    ) {
      failures.push(
        "web local audio producer-close recovery must preserve unmuted mic intent",
      );
    }
    if (!section.includes("requestAudioProducerRecovery();")) {
      failures.push(
        "web local audio producer-close recovery must pulse audio producer recovery",
      );
    }
    if (!section.includes("requestCameraProducerRecovery();")) {
      failures.push(
        "web local camera producer-close recovery must pulse camera producer recovery",
      );
    }
  }
}
{
  const text = source.webMeetMedia;
  const start = text.indexOf("const updateVideoQuality = useCallback(");
  const end = text.indexOf(
    "useEffect(() => {\n    updateVideoQualityRef.current = updateVideoQuality;",
    start,
  );
  if (start >= 0 && end >= 0) {
    const section = text.slice(start, end);
    if (!section.includes("requestCameraProducerRecovery();")) {
      failures.push(
        "web quality-switch video producer transport close must pulse camera recovery",
      );
    }
  }
  const toggleStart = text.indexOf("const toggleCamera = useCallback(");
  const toggleEnd = text.indexOf("useEffect(() => {\n    if (ghostEnabled", toggleStart);
  if (toggleStart >= 0 && toggleEnd >= 0) {
    const section = text.slice(toggleStart, toggleEnd);
    if (!section.includes("requestCameraProducerRecovery();")) {
      failures.push(
        "web camera-toggle video producer transport close must pulse camera recovery",
      );
    }
  }
}
{
  const text = source.webMeetSocket;
  const start = text.indexOf("const produce = useCallback(");
  const end = text.indexOf("const consumeProducer = useCallback(", start);
  if (start < 0 || end < 0) {
    failures.push("web socket publish section missing");
  } else {
    const section = text.slice(start, end);
    if (!section.includes("requestAudioProducerRecovery();")) {
      failures.push(
        "web socket audio producer transport close must pulse audio recovery",
      );
    }
    if (!section.includes("requestCameraProducerRecovery();")) {
      failures.push(
        "web socket video producer transport close must pulse camera recovery",
      );
    }
    if (
      !section.includes("if (!shouldPauseAudio)") ||
      !section.includes("if (!shouldPauseVideo)")
    ) {
      failures.push(
        "web socket producer transport-close recovery must preserve muted/camera-off intent",
      );
    }
  }
}
{
  const text = source.webMeetMedia;
  const audioWatchdogStart = text.indexOf(
    'const requestRecovery = (reason: "initial" | "watchdog") => {',
  );
  const start = text.indexOf(
    'const requestRecovery = (reason: "initial" | "watchdog") => {',
    audioWatchdogStart + 1,
  );
  const end = text.indexOf("const initialTimeout = window.setTimeout", start);
  if (start < 0 || end < 0) {
    failures.push("web camera producer watchdog section missing");
  } else {
    const section = text.slice(start, end);
    if (
      !section.includes("const rawCameraTrack = getFirstLiveTrack(") ||
      !section.includes("await producer.replaceTrack({ track: rawCameraTrack });")
    ) {
      failures.push(
        "web camera producer watchdog must repair dead published tracks with live raw camera before recreating",
      );
    }
    const repairIndex = section.indexOf("await producer.replaceTrack");
    const closeIndex = section.indexOf("closeLocalVideoProducerForReplacement");
    if (closeIndex >= 0 && repairIndex >= 0 && closeIndex < repairIndex) {
      failures.push(
        "web camera producer watchdog must try raw-track repair before closing the producer",
      );
    }
  }
}
{
  const text = source.webMeetMedia;
  const start = text.indexOf("const recoverCameraProducer = async () => {");
  const end = text.indexOf("void recoverCameraProducer();", start);
  if (start < 0 || end < 0) {
    failures.push("web camera producer recovery section missing");
  } else {
    const section = text.slice(start, end);
    if (!section.includes("let transport = getUsableProducerTransport(")) {
      failures.push("web camera producer recovery must reject failed transports");
    }
    if (!section.includes("await ensureProducerTransportRef?.current?.()")) {
      failures.push("web camera producer recovery must rebuild failed transports");
    }
    const transportSectionEnd = section.indexOf("let videoTrack");
    const transportSection =
      transportSectionEnd >= 0 ? section.slice(0, transportSectionEnd) : section;
    if (
      !transportSection.includes(
        "Camera producer recovery waiting for producer transport.",
      )
    ) {
      failures.push(
        "web camera producer recovery must treat transport rebuild as retryable",
      );
    }
    if (transportSection.includes('throw new Error("Video transport unavailable")')) {
      failures.push(
        "web camera producer recovery must not turn cameras off for retryable transport rebuilds",
      );
    }
  }
}
{
  const text = source.webMeetSocket;
  const start = text.indexOf('socket.on(\n              "setVideoQuality"');
  const end = text.indexOf('socket.on("chatMessage"', start);
  if (start < 0 || end < 0) {
    failures.push("web SFU video-quality socket handler missing");
  } else {
    const section = text.slice(start, end);
    if (!section.includes("setNetworkManagedVideoQuality(quality);")) {
      failures.push(
        "web SFU video-quality downgrades must remain network-managed for auto-recovery",
      );
    }
    if (!section.includes("setNetworkManagedVideoQuality(previousQuality);")) {
      failures.push(
        "web SFU video-quality rollback must preserve network-managed state",
      );
    }
  }
}
assertIncludes(
  "webMeetSocket",
  "retrying consumer later",
  "web stale consumer recovery retries only the affected consumer",
);
assertIncludes(
  "webMeetSocket",
  "if (consumer.paused || shouldRequestKeyFrame)",
  "web producer sync avoids no-op consumer resumes",
);
{
  const text = source.webMeetSocket;
  const start = text.indexOf("const handleTrackMuted = () => {");
  const end = text.indexOf("const handleTrackUnmuted = () => {", start);
  if (start < 0 || end < 0) {
    failures.push("web remote track mute handler missing");
  } else {
    const section = text.slice(start, end);
    if (
      section.includes("updateCameraState(true)") ||
      section.includes("updateMutedState(true)")
    ) {
      failures.push(
        "web remote track mute must not be treated as user camera-off/mute",
      );
    }
    if (!section.includes("scheduleStaleConsumerRecovery();")) {
      failures.push(
        "web remote track mute should still schedule stale consumer recovery",
      );
    }
  }
}
{
  const text = source.webMeetSocket;
  const start = text.indexOf("if (producerInfo.paused) {");
  const end = text.indexOf("socket.emit(\n                \"resumeConsumer\"", start);
  if (start < 0 || end < 0) {
    failures.push("web consume producer paused-state section missing");
  } else {
    const section = text.slice(start, end);
    if (
      !section.includes("updateCameraState(false)") ||
      !section.includes("updateMutedState(false)")
    ) {
      failures.push(
        "web consume must restore remote user mute/camera state from producer pause state",
      );
    }
  }
}
{
  const text = source.webMeetSocket;
  const start = text.indexOf("const recoverStaleConsumer = useCallback(");
  const end = text.indexOf("recoverStaleConsumerRef.current", start);
  if (start < 0 || end < 0) {
    failures.push("web stale consumer recovery section missing");
  } else if (text.slice(start, end).includes("handleReconnectRef.current")) {
    failures.push(
      "web stale consumer recovery must not trigger full meeting reconnect",
    );
  }
}
{
  const text = source.webAdaptivePublishQuality;
  const start = text.indexOf("const applyLiveProducerProfile = useCallback(");
  const end = text.indexOf("const switchQuality = useCallback(", start);
  if (start < 0 || end < 0) {
    failures.push("web adaptive live-profile section missing");
  } else if (text.slice(start, end).includes("updateVideoQualityRef.current")) {
    failures.push(
      "web adaptive live-profile tick must not refresh camera capture constraints",
    );
  }
}
{
  const text = source.webAdaptivePublishQuality;
  const start = text.indexOf(
    "autoDowngradedRef.current ||\n          networkManagedVideoQualityRef?.current === true",
  );
  const end = text.indexOf("applyStableLiveProfile();", start);
  if (start < 0 || end < 0) {
    failures.push("web adaptive auto-upgrade section missing");
  } else {
    const section = text.slice(start, end);
    const switchIndex = section.indexOf("void switchQuality(");
    const clearIndex = section.indexOf("autoDowngradedRef.current = false");
    if (switchIndex < 0 || clearIndex < 0 || clearIndex < switchIndex) {
      failures.push(
        "web adaptive auto-upgrade must clear network-managed flags only after switchQuality succeeds",
      );
    }
    if (!section.includes(".then((switched) => {")) {
      failures.push(
        "web adaptive auto-upgrade must retain retry state when switchQuality is skipped",
      );
    }
  }
}
assertIncludes(
  "sfuDisconnectHandlers",
  "room.scheduleDisconnect",
  "SFU still delays disconnect cleanup inside the grace window",
);
assertNotIncludes(
  "sfuDisconnectHandlers",
  "room.schedulePendingDisconnectNotification",
  "SFU must not show peer-facing reconnect badges for grace-window disconnects",
);
assertIncludes(
  "sfuDisconnectHandlers",
  "Browser background throttling",
  "SFU documents why grace-window reconnect badges are suppressed",
);
assertIncludes(
  "webMeetSocket",
  "const PARTICIPANT_RECONNECTING_STATUS_FALLBACK_MS = 30000;",
  "web reconnecting participant badges have a grace-window fallback TTL",
);
assertRegex(
  "webMeetSocket",
  /status\.state === "reconnected"[\s\S]*PARTICIPANT_RECONNECTED_STATUS_MS[\s\S]*PARTICIPANT_RECONNECTING_STATUS_FALLBACK_MS[\s\S]*PARTICIPANT_RECONNECTING_STATUS_BUFFER_MS/,
  "web reconnecting participant badges expire even if recovery event is missed",
);
assertIncludes(
  "sfuConfig",
  "30000",
  "SFU socket disconnect grace tolerates backgrounded tabs",
);
assertIncludes(
  "webMeetMedia",
  "closeLocalVideoProducerForReplacement",
  "web camera recovery closes stale producer on the SFU before replacement",
);
assertIncludes(
  "webMeetMedia",
  "intentionalLocalProducerCloseIdsRef.current.add(producer.id)",
  "web camera recovery marks replacement closes as intentional",
);
assertIncludes(
  "iosWebrtc",
  "(packetLoss ?? 0) >= 0.05",
  "iOS fair packet-loss threshold",
);
assertIncludes(
  "iosWebrtc",
  "(jitterMs ?? 0) >= 120",
  "iOS emergency jitter threshold",
);
assertIncludes(
  "iosWebrtc",
  "inboundJitterWeightedMs += jitter * 1000 * weight",
  "iOS weighted inbound RTP jitter",
);
assertIncludes(
  "iosWebrtc",
  "remoteInboundJitterWeightedMs += jitter * 1000 * weight",
  "iOS weighted remote-inbound RTP jitter",
);
assertIncludes(
  "androidWebrtc",
  "(packetLoss ?: 0.0) >= 0.05",
  "Android fair packet-loss threshold",
);
assertIncludes(
  "androidWebrtc",
  "(jitterMs ?: 0.0) >= 120.0",
  "Android emergency jitter threshold",
);
assertIncludes(
  "androidWebrtc",
  "inboundJitterWeightedMs += value * 1000.0 * weight",
  "Android weighted inbound RTP jitter",
);
assertIncludes(
  "androidWebrtc",
  "remoteInboundJitterWeightedMs += value * 1000.0 * weight",
  "Android weighted remote-inbound RTP jitter",
);
assertIncludes(
  "iosWebrtc",
  "remoteInboundLossFraction = max(remoteInboundLossFraction ?? 0, fractionLost)",
  "iOS remote-inbound publish loss fraction",
);
assertIncludes(
  "androidWebrtc",
  "normalizeFractionLost(jsonNumber(obj, \"fractionLost\"))",
  "Android remote-inbound publish loss fraction",
);

// Native clients must apply bandwidth hints before and during calls. Android
// must re-produce where sender parameters cannot be updated reliably.
assertIncludes(
  "nativeMeetingViewModel",
  "webRTCClient.applyLocalBandwidthProfile(connectionQuality: startupQuality)",
  "native startup bandwidth profile",
);
assertIncludes(
  "nativeMeetingViewModel",
  "self.networkQualityHint = quality",
  "native reachability quality hint wiring",
);
assertIncludes(
  "nativeMeetingViewModel",
  "self.applyAdaptiveVideoQuality(self.publishConnectionQuality)",
  "native publish-side adaptive quality application",
);
assertIncludes(
  "nativeMeetingViewModel",
  "publishConnectionQuality = combinedConnectionQuality(sample.publishQuality)",
  "native publish quality sample split",
);
assertIncludes(
  "nativeMeetingViewModel",
  "receiveConnectionQuality = combinedConnectionQuality(sample.receiveQuality)",
  "native receive quality sample split",
);
assertIncludes(
  "nativeMeetingViewModel",
  "connectionQuality: receiveConnectionQuality",
  "native receive-side remote consumer policy",
);
assertIncludes(
  "nativeMeetingViewModel",
  "self.publishConnectionQuality == quality",
  "native publish-side producer refresh guard",
);
assertIncludes(
  "nativeMeetingViewModel",
  "scheduleLocalVideoBandwidthProfileRefresh(quality, allowGoodRecovery: allowGoodRecovery)",
  "native webcam producer refresh scheduling",
);
assertIncludes(
  "nativeMeetingViewModel",
  "scheduleLocalAudioBandwidthProfileRefresh(quality, allowGoodRecovery: allowGoodRecovery)",
  "native audio producer refresh scheduling",
);
assertIncludes(
  "nativeMeetingViewModel",
  "scheduleLocalScreenBandwidthProfileRefresh(quality, allowGoodRecovery: allowGoodRecovery)",
  "native screen producer refresh scheduling",
);
assertIncludes(
  "nativeMeetingViewModel",
  "await webRTCClient.applyRemoteConsumerBandwidthPolicy(",
  "native remote consumer bandwidth policy application",
);
assertRegex(
  "nativeMeetingViewModel",
  /emergencyVideoDowngradeSeconds\s*:\s*TimeInterval\s*=\s*2\.5[\s\S]*goodVideoRestoreSeconds\s*:\s*TimeInterval\s*=\s*45/,
  "native adaptive downgrade/recovery windows",
);
assertIncludes(
  "iosReachability",
  "if path.isConstrained && path.isExpensive { return .emergency }",
  "iOS constrained+expensive emergency quality hint",
);
assertIncludes(
  "iosReachability",
  "if path.isConstrained { return .poor }",
  "iOS constrained poor quality hint",
);
assertIncludes(
  "iosReachability",
  "if path.isExpensive { return .fair }",
  "iOS expensive fair quality hint",
);
assertRegex(
  "androidReachability",
  /if \(\(upstream != null && upstream <= 120\) \|\| \(downstream != null && downstream <= 300\)\)[\s\S]*return ConnectionQuality\.emergency/,
  "Android emergency bandwidth quality hint",
);
assertRegex(
  "androidReachability",
  /if \(\(upstream != null && upstream <= 240\) \|\| \(downstream != null && downstream <= 800\)\)[\s\S]*return ConnectionQuality\.poor/,
  "Android poor bandwidth quality hint",
);
assertRegex(
  "androidReachability",
  /if \(\(upstream != null && upstream <= 500\) \|\| \(downstream != null && downstream <= 1_500\)\)[\s\S]*return ConnectionQuality\.fair/,
  "Android fair bandwidth quality hint",
);

// Bandwidth-heavy video effects assets must not auto-load on constrained links.
// Camera/screen publishing should stay raw and cheap unless the user has enough
// bandwidth and real effects are active.
assertIncludes(
  "webNetworkInformation",
  "export function shouldDeferBandwidthHeavyPreload",
  "web constrained-link heavy preload gate",
);
assertIncludes(
  "webNetworkInformation",
  "if (!connection) return isLikelyMobileOrTabletNavigator();",
  "web mobile no-NetworkInformation preload deferral",
);
assertIncludes(
  "webMeetClient",
  "const shouldSuppressVideoEffectsForBandwidth =\n    useBandwidthHeavyVideoEffectsSuppressed();",
  "web meet-shell video effects bandwidth suppression",
);
assertRegex(
  "webMeetClient",
  /const shouldRunVideoEffects =\s*activeVideoEffectsCount > 0 &&\s*isDocumentVisible &&\s*!shouldSuppressVideoEffectsForBandwidth;/,
  "web meet-shell effects only run when active, visible, and not constrained",
);
assertRegex(
  "webMeetClient",
  /document\.addEventListener\("visibilitychange", syncDocumentVisibility\);[\s\S]*window\.addEventListener\("pageshow", syncDocumentVisibility\);/,
  "web meet-shell tracks page visibility for processed video publishing",
);
assertIncludes(
  "webMeetClient",
  "const shouldPublishProcessedVideo = shouldRunVideoEffects;",
  "web hidden tabs publish raw camera while effects pipeline is suspended",
);
assertRegex(
  "webMeetClient",
  /if \(activeVideoEffectsCount <= 0\) return;[\s\S]*if \(!isDocumentVisible\) return;[\s\S]*if \(shouldSuppressVideoEffectsForBandwidth\) return;[\s\S]*prewarmVideoEffectsRuntimeDeferred/,
  "web meet-shell runtime prewarm constrained-link guard",
);
assertRegex(
  "webMeetClient",
  /if \(restoredVideoEffectsPrewarmDoneRef\.current\) return;[\s\S]*if \(!isDocumentVisible\) return;[\s\S]*if \(shouldSuppressVideoEffectsForBandwidth\) return;[\s\S]*reason: "restored-effects-state"/,
  "web restored-effects asset prewarm constrained-link guard",
);
assertRegex(
  "webMeetClient",
  /if \(activeVideoEffectsCount <= 0\) return;[\s\S]*if \(isCameraOff \|\| !hasLiveVideoTrack\(localStream\)\) return;[\s\S]*if \(!isDocumentVisible\) return;[\s\S]*if \(shouldSuppressVideoEffectsForBandwidth\) return;[\s\S]*reason: "camera-live"/,
  "web live-camera asset prewarm constrained-link guard",
);
assertRegex(
  "webMeetClient",
  /\{shouldRunVideoEffects \? \([\s\S]*<VideoEffectsBridge[\s\S]*mirrorOutput=\{false\}/,
  "web mirror preview does not activate published effects pipeline",
);
assertRegex(
  "webMeetMedia",
  /activeVideoEffectsCount > 0 &&\s*!shouldDeferBandwidthHeavyPreload\(\)[\s\S]*reason: "camera-toggle-live"/,
  "web camera-toggle effects prewarm constrained-link guard",
);
for (const [key, label] of [
  ["webJoinScreen", "web prejoin"],
  ["webMobileJoinScreen", "web mobile prejoin"],
]) {
  assertRegex(
    key,
    /const shouldRunPreviewVideoEffects =\s*activeVideoEffectsCount > 0 &&\s*!shouldSuppressPreviewVideoEffectsForBandwidth;/,
    `${label} effects only run when active and not constrained`,
  );
  assertRegex(
    key,
    /if \(shouldDeferPreviewVideoEffectsPreload\) return;[\s\S]*prewarmVideoEffectsAssetsDeferred/,
    `${label} effects prewarm constrained-link guard`,
  );
  assertIncludes(
    key,
    "deferPreload={shouldDeferPreviewVideoEffectsPreload}",
    `${label} effects panel preload deferral`,
  );
}
assertIncludes(
  "webLowBandwidthProbe",
  "videoEffectsNetworkResourceCount",
  "low-bandwidth browser probe tracks video effects resource loads",
);
assertIncludes(
  "webLowBandwidthProbe",
  "/mediapipe/models/",
  "low-bandwidth browser probe treats MediaPipe model fetches as heavy resources",
);
assertIncludes(
  "iosWebrtc",
  "audioProducer.updateSenderParameters",
  "iOS live audio sender parameter update",
);
assertIncludes(
  "iosWebrtc",
  "next.degradationPreference = .maintainFramerate",
  "iOS webcam maintain-framerate preference",
);
assertIncludes(
  "iosWebrtc",
  "ScreenCaptureManager.shared.updateMaxFrameRate(cap.maxFramerate)",
  "iOS screen capture frame limiter update",
);
assertIncludes(
  "iosWebrtc",
  "scalabilityMode: Self.screenShareScalabilityMode",
  "iOS screen-share temporal scalability on refresh",
);
assertRegex(
  "androidWebrtc",
  /refreshLocalVideoProducerForBandwidthProfile[\s\S]*transport\.produce\([\s\S]*webcamEncodings\(currentVideoQuality, connectionQuality\)[\s\S]*nextProducer\.setMaxSpatialLayer[\s\S]*socket\.closeProducer\(oldProducer\.id\)/,
  "Android webcam producer refresh for new bandwidth profile",
);
assertRegex(
  "androidWebrtc",
  /refreshLocalAudioProducerForBandwidthProfile[\s\S]*socket\.closeProducer\(oldProducerId\)[\s\S]*startProducingAudio\(\)/,
  "Android microphone producer refresh for new Opus profile",
);
assertRegex(
  "androidWebrtc",
  /refreshLocalScreenProducerForBandwidthProfile[\s\S]*transport\.produce\([\s\S]*screenShareEncodings\(connectionQuality\)[\s\S]*socket\.closeProducer\(oldProducer\.id\)/,
  "Android screen producer refresh for new bandwidth profile",
);

// Native receive adaptation must keep audio crisp, preserve screen shares, and
// pause extra webcam video only in emergency mode.
for (const [key, label] of [
  ["iosWebrtc", "iOS"],
  ["androidWebrtc", "Android"],
]) {
  assertRegex(
    key,
    /kind == "audio"[\s\S]*priority\s*[:=]\s*255[\s\S]*paused\s*[:=]\s*false/,
    `${label} remote audio protected from adaptive pausing`,
  );
  assertRegex(
    key,
    /type == ProducerType\.screen\.rawValue[\s\S]*(case \.emergency|ConnectionQuality\.emergency)[\s\S]*(temporalLayer\s*=\s*0|->\s*0)[\s\S]*(case \.poor|ConnectionQuality\.poor)[\s\S]*(temporalLayer\s*=\s*1|->\s*1)[\s\S]*priority\s*[:=]\s*240[\s\S]*paused\s*[:=]\s*false/,
    `${label} screen-share receive temporal adaptation`,
  );
  assertRegex(
    key,
    /(if isEmergency && !emergencyKeepVideo|if \(isEmergency && !emergencyKeepVideo\))[\s\S]*spatialLayer\s*[:=]\s*0[\s\S]*temporalLayer\s*[:=]\s*0[\s\S]*priority\s*[:=]\s*8[\s\S]*paused\s*[:=]\s*true/,
    `${label} emergency pauses extra remote webcams`,
  );
  assertRegex(
    key,
    /isFocused[\s\S]*spatialLayer\s*[:=][\s\S]*(isEmergency|\? 0)[\s\S]*temporalLayer\s*[:=][\s\S]*(isEmergency|\? 0)[\s\S]*priority\s*[:=][\s\S]*145[\s\S]*paused\s*[:=]\s*false/,
    `${label} emergency keeps focused webcam live`,
  );
}

if (failures.length > 0) {
  console.error("Low-bandwidth profile check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Low-bandwidth profile check passed.");
