import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const files = {
  webConstants: "apps/web/src/app/lib/constants.ts",
  webCodec: "apps/web/src/app/lib/webcam-codec.ts",
  webNetworkInformation: "apps/web/src/app/lib/network-information.ts",
  webConnectionQuality: "apps/web/src/app/hooks/useConnectionQuality.ts",
  webParticipantMedia: "apps/web/src/app/lib/participant-media.ts",
  webSmartParticipantOrder:
    "apps/web/src/app/hooks/useSmartParticipantOrder.ts",
  webAdaptivePublishQuality:
    "apps/web/src/app/hooks/useAdaptivePublishQuality.ts",
  webAdaptiveConsumerPreferences:
    "apps/web/src/app/hooks/useAdaptiveConsumerPreferences.ts",
  webPlaybackRecovery: "apps/web/src/app/lib/playback-recovery.ts",
  webParticipantVideo: "apps/web/src/app/components/ParticipantVideo.tsx",
  webMobileParticipantVideo:
    "apps/web/src/app/components/mobile/MobileParticipantVideo.tsx",
  webGridLayout: "apps/web/src/app/components/GridLayout.tsx",
  webMobileGridLayout:
    "apps/web/src/app/components/mobile/MobileGridLayout.tsx",
  webPresentationLayout: "apps/web/src/app/components/PresentationLayout.tsx",
  webMobilePresentationLayout:
    "apps/web/src/app/components/mobile/MobilePresentationLayout.tsx",
  webMobileBrowserLayout:
    "apps/web/src/app/components/mobile/MobileBrowserLayout.tsx",
  webMeetClient: "apps/web/src/app/meets-client.tsx",
  webMeetMedia: "apps/web/src/app/hooks/useMeetMedia.ts",
  webMeetSocket: "apps/web/src/app/hooks/useMeetSocket.ts",
  webVideoEffects: "apps/web/src/app/hooks/useVideoEffects.ts",
  meetingParticipantReducer: "packages/meeting-core/src/participant-reducer.ts",
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
  sfuClient: "packages/sfu/config/classes/Client.ts",
  sfuConfig: "packages/sfu/config/config.ts",
  sfuMediaHandlers: "packages/sfu/server/socket/handlers/mediaHandlers.ts",
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
assertRegex(
  "webMeetSocket",
  /track: audioTrack,[\s\S]*buildMicrophoneOpusCodecOptions\([\s\S]*stopTracks: false,[\s\S]*type: "webcam" as ProducerType/,
  "web initial microphone producer must preserve capture tracks during producer cleanup",
);
{
  const mediaAudioProduceMatches =
    source.webMeetMedia.match(
      /track: audioTrack,[\s\S]*?buildMicrophoneOpusCodecOptions\([\s\S]*?stopTracks: false,[\s\S]*?type: "webcam" as ProducerType/g,
    ) ?? [];
  if (
    mediaAudioProduceMatches.length < 1 ||
    !source.webMeetMedia.includes("requestAudioProducerRecovery();\n      return;")
  ) {
    failures.push(
      "web audio recovery microphone producers must preserve capture tracks and unmute must use recovery instead of cold publish",
    );
  }
}

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
assertIncludes(
  "webCodec",
  "export const shouldUseWebcamSimulcast =",
  "web webcam simulcast decision is codec/browser-aware",
);
assertIncludes(
  "webCodec",
  "export const getFallbackWebcamCodec =",
  "web webcam stalled-sender codec fallback",
);
assertRegex(
  "webCodec",
  /if \(!preferredCodec \|\| isPreferredVideoCodec\(preferredCodec, "video\/H264"\)\)[\s\S]*return false;/,
  "web hardware-sensitive H264 webcam publish starts single-layer",
);
assertRegex(
  "webCodec",
  /forceSingleLayer\?: boolean[\s\S]*if \(!forceSingleLayer && shouldUseWebcamSimulcast\(preferredCodec\)\) \{[\s\S]*buildOptions\(buildWebcamSimulcastEncodings\(quality\)\)[\s\S]*\}[\s\S]*buildOptions\(\[buildWebcamSingleLayerEncoding\(quality\)\]\)/,
  "web simulcast-friendly webcam publish keeps single-layer fallback",
);
assertRegex(
  "webCodec",
  /networkProfile !== "good" && hasMultipleSpatialLayers\(producer\)/,
  "web initial webcam spatial-layer cap only runs on multi-layer producers",
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
  ["webMobileParticipantVideo", "mobile participant video"],
  ["webGridLayout", "grid video"],
  ["webPresentationLayout", "presentation video"],
  ["webMobilePresentationLayout", "mobile presentation video"],
  ["webMobileBrowserLayout", "mobile browser video"],
]) {
  assertNotIncludes(
    key,
    'addEventListener("suspend", scheduleReplay)',
    `web ${label} should not replay on benign suspend events`,
  );
}
assertIncludes(
  "webMobileParticipantVideo",
  "createPlaybackRecoveryScheduler",
  "web mobile participant video uses playback recovery scheduler",
);
assertIncludes(
  "webMobileParticipantVideo",
  "shouldAttemptAnimationFrameReplay",
  "web mobile participant video retries stalled first-frame playback",
);
assertIncludes(
  "webMobileParticipantVideo",
  'document.addEventListener("visibilitychange", handleVisibilityChange)',
  "web mobile participant video retries playback after foregrounding",
);
assertRegex(
  "webMobileParticipantVideo",
  /<video[\s\S]*autoPlay[\s\S]*muted[\s\S]*playsInline/,
  "web mobile participant video is muted for autoplay reliability",
);
assertRegex(
  "webMobileGridLayout",
  /const ParticipantTile = memo[\s\S]*createPlaybackRecoveryScheduler[\s\S]*shouldAttemptAnimationFrameReplay[\s\S]*video\.addEventListener\("stalled", scheduleReplay\)[\s\S]*document\.addEventListener\("visibilitychange", handleVisibilityChange\)[\s\S]*window\.addEventListener\("orientationchange", handleOrientationChange\)/,
  "web mobile grid visible remote video retries stalled playback",
);
assertRegex(
  "webMobileGridLayout",
  /function WarmRemoteVideo[\s\S]*createPlaybackRecoveryScheduler[\s\S]*shouldAttemptAnimationFrameReplay[\s\S]*video\.addEventListener\("stalled", scheduleReplay\)[\s\S]*document\.addEventListener\("visibilitychange", handleVisibilityChange\)[\s\S]*window\.addEventListener\("orientationchange", handleOrientationChange\)/,
  "web mobile grid warm remote video keeps decoder playback live",
);
assertRegex(
  "webGridLayout",
  /const OverflowGalleryTile = memo\(function OverflowGalleryTile[\s\S]*createPlaybackRecoveryScheduler[\s\S]*shouldAttemptAnimationFrameReplay[\s\S]*video\.addEventListener\("stalled", scheduleReplay\)[\s\S]*document\.addEventListener\("visibilitychange", handleVisibilityChange\)[\s\S]*window\.addEventListener\("orientationchange", handleWindowChange\)/,
  "web overflow gallery remote video keeps decoder playback live",
);
assertRegex(
  "webMobilePresentationLayout",
  /const VideoThumbnail = memo\(function VideoThumbnail[\s\S]*createPlaybackRecoveryScheduler[\s\S]*shouldAttemptAnimationFrameReplay[\s\S]*video\.addEventListener\("stalled", scheduleReplay\)[\s\S]*document\.addEventListener\("visibilitychange", handleVisibilityChange\)[\s\S]*window\.addEventListener\("orientationchange", handleWindowChange\)/,
  "web mobile presentation thumbnails keep decoder playback live",
);
assertRegex(
  "webMobileBrowserLayout",
  /const VideoThumbnail = memo\(function VideoThumbnail[\s\S]*createPlaybackRecoveryScheduler[\s\S]*shouldAttemptAnimationFrameReplay[\s\S]*video\.addEventListener\("stalled", scheduleReplay\)[\s\S]*document\.addEventListener\("visibilitychange", handleVisibilityChange\)[\s\S]*window\.addEventListener\("orientationchange", handleWindowChange\)/,
  "web mobile browser thumbnails keep decoder playback live",
);
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
assertIncludes(
  "webAdaptiveConsumerPreferences",
  "const fallbackWebcamRanks = new Map<string, number>();",
  "web missing layout hints use deterministic webcam fallback ranks",
);
assertRegex(
  "webAdaptiveConsumerPreferences",
  /fallbackWebcamRanks[\s\S]*Array\.from\(refs\.consumersRef\.current\.entries\(\)\)[\s\S]*active: info\.userId === activeSpeakerId[\s\S]*left\.userId\.localeCompare\(right\.userId\)[\s\S]*left\.producerId\.localeCompare\(right\.producerId\)[\s\S]*fallbackWebcamRanks\.set\(candidate\.producerId, index\)/,
  "web missing layout fallback ranks are stable across clients",
);
assertRegex(
  "webAdaptiveConsumerPreferences",
  /const fallbackVisible =[\s\S]*options\.fallbackRank !== null[\s\S]*options\.fallbackRank < MAX_WEBCAMS_TO_KEEP_FULL_ON_GOOD_LINKS/,
  "web missing layout hints do not mark every webcam visible",
);
assertIncludes(
  "webAdaptiveConsumerPreferences",
  "const isWarm = layout?.warm === true || (!layout && !fallbackVisible);",
  "web missing layout hints keep non-primary webcams warm instead of full",
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
assertRegex(
  "webAdaptiveConsumerPreferences",
  /const isConsumerLayerUpgrade =[\s\S]*next\.spatialLayer > previous\.spatialLayer[\s\S]*next\.temporalLayer[\s\S]*previous\.temporalLayer[\s\S]*requestKeyFrame =[\s\S]*isConsumerLayerUpgrade\(previousLayers, preferredLayers!\)/,
  "web receive layer upgrades request keyframes for temporal recovery",
);
assertIncludes(
  "webAdaptiveConsumerPreferences",
  "priority: quality === \"poor\" ? 10 : 25,\n      paused: false,",
  "web hidden consumers degrade layers instead of pausing",
);
assertIncludes(
  "webAdaptiveConsumerPreferences",
  "priority: 8,\n        paused: false,",
  "web emergency receive adaptation keeps extra remote webcams live",
);
assertNotIncludes(
  "webAdaptiveConsumerPreferences",
  "paused: quality === \"poor\"",
  "web hidden consumers must not flicker from adaptive pausing",
);
assertNotIncludes(
  "webAdaptiveConsumerPreferences",
  "priority: 8,\n        paused: true,",
  "web emergency receive adaptation must not silently pause remote webcams",
);
assertNotIncludes(
  "webParticipantMedia",
  "participant.isCameraOff || participant.isVideoAdaptivelyPaused",
  "web adaptive receive state must not hide remote webcam streams",
);
assertNotIncludes(
  "webSmartParticipantOrder",
  "!participant.isVideoAdaptivelyPaused",
  "web adaptive receive state must not reshuffle remote webcams as video-off",
);
assertIncludes(
  "webAdaptiveConsumerPreferences",
  "const CONSUMER_PREFERENCE_ACK_TIMEOUT_MS = 3000;",
  "web consumer preference updates have ACK timeout",
);
assertIncludes(
  "webAdaptiveConsumerPreferences",
  'markDeferredForRetry("setConsumerPreferences ack timeout")',
  "web consumer preference ACK timeout retries stale layer updates",
);
assertIncludes(
  "webAdaptiveConsumerPreferences",
  'markDeferredForRetry(\n                    "setConsumerPreferences priority-only ack timeout",',
  "web consumer preference fallback ACK timeout retries stale layer updates",
);
assertRegex(
  "webAdaptiveConsumerPreferences",
  /scheduledPreferenceTimeoutsRef\.current\.add\(ackTimeoutId\);[\s\S]*scheduledPreferenceTimeoutsRef\.current\.delete\(ackTimeoutId\);[\s\S]*window\.clearTimeout\(ackTimeoutId\);/,
  "web consumer preference ACK timeout is cleared on response",
);
assertIncludes(
  "webConstants",
  "export const BACKGROUND_TRANSPORT_DISCONNECT_GRACE_MS = 18000;",
  "web background transport disconnect grace",
);
assertIncludes(
  "webMeetSocket",
  "const shouldDeferTransportRecoveryUntilVisible = (): boolean =>",
  "web hidden-tab transport recovery visibility gate",
);
assertRegex(
  "webMeetSocket",
  /transport\.connectionState === "disconnected"[\s\S]*shouldDeferTransportRecoveryUntilVisible\(\)[\s\S]*Producer transport recovery deferred until foreground[\s\S]*attemptIceRestart\("producer"\)/,
  "web hidden producer disconnect does not force background reconnect",
);
assertRegex(
  "webMeetSocket",
  /transport\.connectionState === "disconnected"[\s\S]*shouldDeferTransportRecoveryUntilVisible\(\)[\s\S]*Consumer transport recovery deferred until foreground[\s\S]*attemptIceRestart\("consumer"\)/,
  "web hidden consumer disconnect does not force background reconnect",
);
assertRegex(
  "webMeetSocket",
  /const disconnectedTransportKinds: Array<"producer" \| "consumer"> = \[\];[\s\S]*producerState === "disconnected"[\s\S]*consumerState === "disconnected"[\s\S]*attemptIceRestart\(kind\)[\s\S]*producer sync failed after ICE restart/,
  "web foreground recovery restarts ICE for disconnected transports",
);
assertRegex(
  "webMeetSocket",
  /RESTART_ICE_ACK_TIMEOUT_MS[\s\S]*const iceRestartPromiseRef = useRef[\s\S]*Promise<boolean> \| null[\s\S]*const existingRestart = iceRestartPromiseRef\.current\[transportKind\];[\s\S]*if \(existingRestart\) return existingRestart;[\s\S]*window\.setTimeout\([\s\S]*restartIce acknowledgement timeout[\s\S]*socket\.emit\([\s\S]*"restartIce"[\s\S]*window\.clearTimeout\(timeoutId\)[\s\S]*iceRestartPromiseRef\.current\[transportKind\] = restartPromise;[\s\S]*return restartPromise;/,
  "web ICE restart recovery waits for in-flight restart result",
);
assertNotIncludes(
  "webMeetSocket",
  "? Promise.resolve(true)\n              : attemptIceRestart(kind)",
  "web foreground recovery must not treat in-flight ICE restart as success",
);
assertRegex(
  "webMeetClient",
  /const hasPoorPublishRecoverySignal =[\s\S]*selfConnectionStats\.publishRttMs[\s\S]*selfConnectionStats\.publishPacketLoss[\s\S]*selfConnectionStats\.publishJitterMs[\s\S]*const browserPublishRecoveryQuality = \([\s\S]*selfConnectionStats\.browserNetwork\.quality === "unknown"[\s\S]*selfConnectionStats\.browserNetwork\.startupQuality[\s\S]*const browserAllowsPublishCapRecovery =[\s\S]*browserPublishRecoveryQuality === "good" \|\|[\s\S]*browserPublishRecoveryQuality === "unknown"[\s\S]*browserAllowsPublishCapRecovery && !hasPoorPublishRecoverySignal[\s\S]*\? "good"[\s\S]*: selfPublishQuality/,
  "web cap recovery restores good profile when browser hint is good or unknown",
);
assertRegex(
  "webConnectionQuality",
  /publishRttMs: number \| null;[\s\S]*publishPacketLoss: number \| null;[\s\S]*publishJitterMs: number \| null;[\s\S]*receiveRttMs: number \| null;[\s\S]*receivePacketLoss: number \| null;[\s\S]*receiveJitterMs: number \| null;/,
  "web connection quality exposes directional transport impairment signals",
);
assertNotIncludes(
  "webMeetClient",
  "selfConnectionStats.rttMs >= PUBLISH_RECOVERY_RTT_POOR_MS",
  "web publish cap recovery must not use combined RTT",
);
assertNotIncludes(
  "webMeetClient",
  "selfConnectionStats.packetLoss >= PUBLISH_RECOVERY_LOSS_POOR",
  "web publish cap recovery must not use combined packet loss",
);
assertNotIncludes(
  "webMeetClient",
  "selfConnectionStats.jitterMs >= PUBLISH_RECOVERY_JITTER_POOR_MS",
  "web publish cap recovery must not use combined jitter",
);
assertNotIncludes(
  "webMeetClient",
  "? (selfConnectionStats.browserNetwork.quality as ConnectionQuality)",
  "web raw browser quality must not hold live publish caps down",
);
assertRegex(
  "webMeetClient",
  /publishEmergencyMode: selfPublishEmergencyMode,[\s\S]*receiveEmergencyMode: selfReceiveEmergencyMode,[\s\S]*useAdaptiveConsumerPreferences\(\{[\s\S]*connectionQuality: selfReceiveQuality,[\s\S]*emergencyMode: selfReceiveEmergencyMode,[\s\S]*useAdaptivePublishQuality\(\{[\s\S]*connectionQuality: selfPublishQuality,[\s\S]*emergencyMode: selfPublishEmergencyMode,/,
  "web publish and receive adaptation use direction-specific emergency signals",
);
assertRegex(
  "webMeetSocket",
  /connectionQualityRef\?: React\.MutableRefObject<ConnectionQualityStats \| null>[\s\S]*const getPublishNetworkProfile = useCallback\([\s\S]*getConnectionStatsNetworkProfile\(connectionQualityRef\?\.current, "publish"\)[\s\S]*const getReceiveNetworkProfile = useCallback\([\s\S]*getConnectionStatsNetworkProfile\(connectionQualityRef\?\.current, "receive"\)/,
  "web socket publish and receive setup uses measured directional network profiles",
);
assertRegex(
  "webMeetSocket",
  /const screenNetworkProfile = getPublishNetworkProfile\(\);[\s\S]*buildMicrophoneOpusCodecOptions\(\s*getPublishNetworkProfile\(\),\s*\)[\s\S]*networkProfile: getPublishNetworkProfile\(\)[\s\S]*networkProfile: getPublishNetworkProfile\(\)/,
  "web socket publish paths use measured publish profile for recreated producers",
);
assertRegex(
  "webMeetSocket",
  /getInitialConsumerPreferences\(producerInfo, \{[\s\S]*preferHighWebcamLayer:[\s\S]*networkProfile: getReceiveNetworkProfile\(\)/,
  "web initial consumer preferences use measured receive profile",
);
assertRegex(
  "webMeetClient",
  /useMeetSocket\(\{[\s\S]*videoQualityRef: refs\.videoQualityRef,[\s\S]*connectionQualityRef: connectionQualityDebugRef,/,
  "web meet client passes measured connection stats to socket hook",
);
assertNotIncludes(
  "webMeetSocket",
  "getBrowserPublishNetworkProfile",
  "web socket must not use raw browser-only startup hints for producer caps",
);
assertNotIncludes(
  "webAdaptivePublishQuality",
  'if (connectionQuality === "poor") {\n          void applyLiveProducerProfile(emergencyMode ? "emergency" : "poor");\n        }',
  "web publish caps must wait for poor-link stability window",
);
assertRegex(
  "webAdaptivePublishQuality",
  /if \(previous\.quality !== connectionQuality\) \{[\s\S]*qualityWindowRef\.current = \{ quality: connectionQuality, since: now \};[\s\S]*writeDebugSnapshot\(now\);[\s\S]*return;/,
  "web publish quality changes reset stability window before capping",
);
assertRegex(
  "webMeetClient",
  /suppressedProcessedPublishTrackRef[\s\S]*handlePreferredVideoPublishTrackRejected[\s\S]*suppress_processed_publish_track_after_raw_repair[\s\S]*onPreferredVideoPublishTrackRejected:[\s\S]*handlePreferredVideoPublishTrackRejected[\s\S]*processedTrackSuppressed[\s\S]*skip_processed_track_suppressed_after_raw_repair/,
  "web processed publish track stays suppressed after raw repair until fresh output",
);
assertNotIncludes(
  "webMeetClient",
  "const selfEmergencyNetworkMode = selfConnectionStats.emergencyMode;",
  "web publish/receive adaptation must not share combined emergency mode",
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
  "Camera constraints update failed; keeping current capture",
  "web quality switch keeps live camera when constraints fail",
);
assertNotIncludes(
  "webMeetMedia",
  "Camera constraints update failed; refreshing capture once",
  "web quality switch must not reopen live cameras when constraints fail",
);
assertNotIncludes(
  "webMeetMedia",
  "shouldRefreshVideoTrackForQualitySwitch",
  "web quality switch must not reopen live cameras when settings undershoot",
);
assertNotIncludes(
  "webMeetMedia",
  "settings.width <= lowQualityWidth * 1.05",
  "web standard-quality camera refresh must not key off low-width captures",
);
assertNotIncludes(
  "webMeetMedia",
  "settings.height <= lowQualityHeight * 1.05",
  "web standard-quality camera refresh must not key off low-height captures",
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
assertIncludes(
  "webMeetMedia",
  "const produceCameraTrackWithRawFallback = useCallback(",
  "web fresh camera producer publish has raw-track fallback helper",
);
assertRegex(
  "webMeetMedia",
  /produceCameraTrackWithRawFallback[\s\S]*Processed \$\{context\} camera publish failed; retrying raw camera:[\s\S]*track: rawTrack/,
  "web processed camera publish failures retry raw camera",
);
for (const [context, label] of [
  ["quality-switch", "quality-switch"],
  ["camera-toggle", "camera-toggle"],
  ["camera-recovery", "camera-recovery"],
]) {
  assertIncludes(
    "webMeetMedia",
    `context: "${context}"`,
    `web ${label} fresh camera produce uses raw fallback`,
  );
}
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
    if (!section.includes("requestAudioProducerRecovery();")) {
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
    if (!section.includes("requestCameraProducerRecovery();")) {
      failures.push(
        "web unexpected camera track ends must trigger producer recovery",
      );
    }
  }
}
assertRegex(
  "webMeetMedia",
  /let createdTrack: MediaStreamTrack \| null = null;[\s\S]*const removeCreatedTrackFromLocalStream = \(\) => \{[\s\S]*stopLocalTrack\(createdTrack\);[\s\S]*createdTrack = null;[\s\S]*audioRecoveryInFlightRef\.current = true;[\s\S]*const recoverAudioProducer = async \(\) => \{[\s\S]*if \(cancelled\) \{[\s\S]*audioProducer\.close\(\);[\s\S]*removeCreatedTrackFromLocalStream\(\);[\s\S]*catch \(err\) \{[\s\S]*removeCreatedTrackFromLocalStream\(\);[\s\S]*return \(\) => \{[\s\S]*cancelled = true;[\s\S]*removeCreatedTrackFromLocalStream\(\);/,
  "web cancelled audio recovery stops recovery-created mic tracks",
);
assertRegex(
  "webMeetMedia",
  /const stopTracksExcept = useCallback\([\s\S]*keepTrackIds[\s\S]*for \(const track of tracks\)[\s\S]*stopLocalTrack\(track\);/,
  "web replaced local capture tracks are stopped as a complete set",
);
{
  const text = source.webMeetMedia;
  const start = text.indexOf("const handleLocalTrackEnded = useCallback(");
  const end = text.indexOf("const requestMediaPermissions = useCallback", start);
  if (start < 0 || end < 0) {
    failures.push("web local track-ended handler section missing");
  } else {
    const section = text.slice(start, end);
    if (
      !text.includes("const commitLocalStream = useCallback(") ||
      !section.includes("const currentStream = localStreamRef.current;") ||
      !section.includes("hasCurrentLocalTrack") ||
      !section.includes("hasCurrentProducerTrack") ||
      !section.includes("Ignoring ended stale local track") ||
      !section.includes("commitLocalStream(new MediaStream(remaining));") ||
      section.includes(".filter((t) => t.kind !== kind)")
    ) {
      failures.push(
        "web local track-ended handler must ignore stale ended tracks and sync stream refs",
      );
    }
  }
}
{
  const text = source.webMeetMedia;
  const start = text.indexOf("const handleAudioInputDeviceChange = useCallback(");
  const end = text.indexOf("const handleVideoInputDeviceChange = useCallback", start);
  if (start < 0 || end < 0) {
    failures.push("web audio input device-change section missing");
  } else {
    const section = text.slice(start, end);
    if (
      !section.includes("let acquiredAudioTracks: MediaStreamTrack[] = [];") ||
      !section.includes("let committedNewAudioTrack: MediaStreamTrack | null = null;") ||
      !section.includes("acquiredAudioTracks = newStream.getAudioTracks();") ||
      !section.includes("const previousStream = localStreamRef.current;") ||
      !section.includes("const previousAudioTracks =") ||
      !section.includes("const currentAudioProducer = audioProducerRef.current;") ||
      !section.includes("currentAudioProducer?.closed") ||
      !section.includes(
        "closeLocalAudioProducerForReplacement(currentAudioProducer);",
      ) ||
      !section.includes("requestAudioProducerRecovery();") ||
      !section.includes("commitLocalStream(nextStream);") ||
      !section.includes("committedNewAudioTrack = newAudioTrack;") ||
      !section.includes("stopTracksExcept(previousAudioTracks, [newAudioTrack]);") ||
      !section.includes("stopTracksExcept(acquiredAudioTracks, [committedNewAudioTrack]);") ||
      section.includes("prev.removeTrack(oldAudioTrack)") ||
      section.includes("prev.addTrack(newAudioTrack)")
    ) {
      failures.push(
        "web audio input device changes must sync refs, clear dead producers, recover missing producers, and clean up failed mic captures",
      );
    }
  }
}
{
  const text = source.webMeetMedia;
  const start = text.indexOf("const handleVideoInputDeviceChange = useCallback(");
  const end = text.indexOf("const updateVideoQuality = useCallback", start);
  if (start < 0 || end < 0) {
    failures.push("web video input device-change section missing");
  } else {
    const section = text.slice(start, end);
    const replaceIndex = section.indexOf("await videoProducer.replaceTrack");
    const commitIndex = section.indexOf("localStreamRef.current = nextStream;");
    if (
      !section.includes("let acquiredVideoTracks: MediaStreamTrack[] = [];") ||
      !section.includes("let committedNewVideoTrack: MediaStreamTrack | null = null;") ||
      !section.includes("acquiredVideoTracks = newStream.getVideoTracks();") ||
      !section.includes("const previousVideoTracks =") ||
      !section.includes("const currentVideoProducer = videoProducerRef.current;") ||
      !section.includes("currentVideoProducer?.closed") ||
      !section.includes("closeLocalVideoProducerForReplacement(currentVideoProducer);") ||
      replaceIndex < 0 ||
      commitIndex < 0 ||
      commitIndex < replaceIndex ||
      !section.includes("committedNewVideoTrack = newVideoTrack;") ||
      !section.includes("stopTracksExcept(previousVideoTracks, [") ||
      !section.includes("stopTracksExcept(acquiredVideoTracks, [committedNewVideoTrack]);") ||
      !section.includes("requestCameraProducerRecovery();") ||
      !section.includes("videoProducerRef.current?.track ?? null")
    ) {
      failures.push(
        "web video input device changes must clear dead producers, commit after publish replacement, and clean up failed camera captures",
      );
    }
  }
}
{
  const text = source.webMeetMedia;
  const start = text.indexOf("const toggleMute = useCallback(");
  const end = text.indexOf("useEffect(() => {\n    if (ghostEnabled || isObserverMode) return;", start);
  if (start < 0 || end < 0) {
    failures.push("web mute toggle section missing");
  } else {
    const section = text.slice(start, end);
    if (
      !section.includes("const currentAudioTracks =") ||
      !section.includes("const liveAudioTracks = currentAudioTracks.filter(") ||
      !section.includes("liveAudioTracks.forEach((track) => {") ||
      !section.includes("let audioTrack = getFirstLiveTrack(")
    ) {
      failures.push(
        "web mute toggle must apply intent to all live mic tracks and unmute a live track",
      );
    }
    if (
      !text.includes("const confirmAudioProducerUnmuted = useCallback(") ||
      !text.includes("TOGGLE_MUTE_FAST_ACK_TIMEOUT_MS") ||
      !text.includes("TOGGLE_MUTE_BACKGROUND_ACK_TIMEOUT_MS") ||
      !text.includes("isMutedRef.current") ||
      !section.includes("setMutedIntent(false);") ||
      !section.includes("confirmAudioProducerUnmuted(producer.id);") ||
      !section.includes("requestAudioProducerRecovery();") ||
      !section.includes("return;") ||
      section.includes("const retry = await emitToggleMute(producer.id, false)") ||
      section.includes("transport.produce({") ||
      section.includes('throw new Error("Audio transport unavailable")')
    ) {
      failures.push(
        "web unmute must return after local producer resume and never wait for cold producer creation",
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
    if (
      !section.includes("shouldUseWebcamSimulcast(preferredWebcamCodec)") ||
      !section.includes("const needsStandardSimulcastRecreate =")
    ) {
      failures.push(
        "web video-quality producer recreation must skip intentional mobile/H264 single-layer webcam producers",
      );
    }
    if (
      !section.includes("const currentStream = localStreamRef.current ?? localStream;") ||
      !section.includes("if (!currentStream) return;") ||
      !section.includes("const currentTrack = getFirstLiveTrack(") ||
      !section.includes("let nextVideoTrack = getFirstLiveTrack(") ||
      !section.includes("let oldVideoTracksToStop: MediaStreamTrack[] = [];") ||
      !section.includes("stopTracksExcept(oldVideoTracksToStop, [")
    ) {
      failures.push(
        "web video-quality recovery must prefer ref-backed live tracks and stop all replaced camera tracks",
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
    if (
      !section.includes("hadLiveAudioTrackBeforeRecovery") ||
      !section.includes("const shouldStartPaused = isMutedRef.current;") ||
      !section.includes("let audioTrack = getFirstLiveTrack(") ||
      !section.includes("if (shouldStartPaused)") ||
      !section.includes("audioTrack.enabled = !shouldStartPaused;") ||
      !section.includes("paused: shouldStartPaused") ||
      !section.includes("if (createdTrack)") ||
      !section.includes("localStreamRef.current = nextStream;") ||
      !section.includes("setLocalStream(nextStream);") ||
      !section.includes("!hadLiveAudioTrackBeforeRecovery &&") ||
      !section.includes(
        "shouldDisableMediaIntentAfterRecoveryFailure(err, meetErr)",
      ) ||
      section.includes("existingAudioTracks.forEach((track) =>")
    ) {
      failures.push(
        "web audio producer recovery failure must preserve existing live mic capture",
      );
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
    if (!section.includes("requestAudioProducerRecovery();")) {
      failures.push(
        "web audio producer transport close must trigger producer recovery",
      );
    }
  }
}
{
  const text = source.webMeetMedia;
  const start = text.indexOf("const getReusableAudioTrack =");
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
    if (
      !section.includes("getReusableAudioTrack") ||
      !section.includes("if (isMuted && !getReusableAudioTrack()) return;") ||
      !section.includes("if (isMutedRef.current && !liveAudioTrack) return;")
    ) {
      failures.push(
        "web audio producer watchdog must keep muted producers warm without opening cold mic capture",
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
  if (
    !mediaText.includes("mediaRecoveryBlockedRef?: React.MutableRefObject<boolean>") ||
    !mediaText.includes("const isMediaRecoveryBlocked = useCallback(") ||
    !source.webMeetClient.includes(
      "mediaRecoveryBlockedRef: refs.reconnectInFlightRef",
    )
  ) {
    failures.push(
      "web media recovery must be blocked by the internal reconnect-in-flight ref",
    );
  }
  if (
    !mediaText.includes("if (isMediaRecoveryBlocked()) return;") ||
    !/if \(isMediaRecoveryBlocked\(\)\) \{\s*removeCreatedTrackFromLocalStream\(\);\s*return;/.test(
      mediaText,
    )
  ) {
    failures.push(
      "web media recovery must stop rebuilding producers once reconnect cleanup starts",
    );
  }
  if (
    !/pendingAudioProducerRecoveryRef[\s\S]*pendingCameraProducerRecoveryRef[\s\S]*blockedProducerRecoveryFlushPulse[\s\S]*flushQueuedProducerRecoveries[\s\S]*window\.setInterval\(\(\) => \{[\s\S]*if \(isMediaRecoveryBlocked\(\)\) return;[\s\S]*flushQueuedProducerRecoveries\(\);/.test(
      mediaText,
    )
  ) {
    failures.push(
      "web blocked reconnect recovery pulses must be queued and replayed after reconnect unblocks",
    );
  }
  if (
    !/const requestAudioProducerRecovery = useCallback\(\(\) => \{[\s\S]*if \(isMediaRecoveryBlocked\(\)\) \{[\s\S]*queueBlockedProducerRecovery\("audio"\);[\s\S]*setAudioProducerRecoveryPulse/.test(
      mediaText,
    ) ||
    !/const requestCameraProducerRecovery = useCallback\(\(\) => \{[\s\S]*if \(isMediaRecoveryBlocked\(\)\) \{[\s\S]*queueBlockedProducerRecovery\("camera"\);[\s\S]*setCameraProducerRecoveryPulse/.test(
      mediaText,
    )
  ) {
    failures.push(
      "web explicit audio/camera recovery requests must queue while reconnect cleanup blocks recovery",
    );
  }
  if (
    /transportclose"[\s\S]{0,400}setAudioProducerRecoveryPulse/.test(mediaText) ||
    /transportclose"[\s\S]{0,400}setCameraProducerRecoveryPulse/.test(mediaText)
  ) {
    failures.push(
      "web producer transport-close handlers must use queued recovery requests, not raw pulses",
    );
  }
  if (
    !/let createdTrack: MediaStreamTrack \| null = null;[\s\S]*const removeCreatedTrackFromLocalStream = \(\) => \{[\s\S]*audioRecoveryInFlightRef\.current = true;[\s\S]*const recoverAudioProducer = async \(\) => \{[\s\S]*const audioProducer = await transport\.produce[\s\S]*if \(cancelled\) \{[\s\S]*removeCreatedTrackFromLocalStream\(\);[\s\S]*audioProducerRef\.current = audioProducer;[\s\S]*createdTrack = null;[\s\S]*return \(\) => \{[\s\S]*cancelled = true;[\s\S]*removeCreatedTrackFromLocalStream\(\);/.test(
      mediaText,
    )
  ) {
    failures.push(
      "web audio recovery must stop recovery-created mic tracks immediately on effect cancellation",
    );
  }
  if (
    !/let createdTrack: MediaStreamTrack \| null = null;[\s\S]*const removeCreatedTrackFromLocalStream = \(\) => \{[\s\S]*cameraRecoveryInFlightRef\.current = true;[\s\S]*const recoverCameraProducer = async \(\) => \{[\s\S]*const recoveredProducer = await produceCameraTrackWithRawFallback[\s\S]*if \(cancelled\) \{[\s\S]*removeCreatedTrackFromLocalStream\(\);[\s\S]*videoProducerRef\.current = recoveredProducer;[\s\S]*createdTrack = null;[\s\S]*return \(\) => \{[\s\S]*cancelled = true;[\s\S]*removeCreatedTrackFromLocalStream\(\);/.test(
      mediaText,
    )
  ) {
    failures.push(
      "web camera recovery must stop recovery-created video tracks immediately on effect cancellation",
    );
  }
  if (
    !/shouldDisableMediaIntentAfterRecoveryFailure[\s\S]*meetError\.code === "PERMISSION_DENIED"[\s\S]*NotFoundError[\s\S]*Audio producer recovery failed[\s\S]*const meetErr = createMeetError\(err, "MEDIA_ERROR"\);[\s\S]*!hadLiveAudioTrackBeforeRecovery &&[\s\S]*shouldDisableMediaIntentAfterRecoveryFailure\(err, meetErr\)[\s\S]*setIsMuted\(true\);[\s\S]*Camera producer recovery failed[\s\S]*const meetErr = createMeetError\(err, "MEDIA_ERROR"\);[\s\S]*!hadLiveCameraTrackBeforeRecovery &&[\s\S]*shouldDisableMediaIntentAfterRecoveryFailure\(err, meetErr\)[\s\S]*setIsCameraOff\(true\);/.test(
      mediaText,
    )
  ) {
    failures.push(
      "web media recovery must preserve mic/camera intent on transient producer failures",
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
      !section.includes("const shouldRecoverAudio = !isMutedRef.current;") ||
      !section.includes("if (liveAudioTrack) {") ||
      !section.includes("liveAudioTrack.enabled = true;")
    ) {
      failures.push(
        "web local audio producer-close recovery must preserve unmuted mic intent even before a live mic track is visible",
      );
    }
    if (
      !section.includes("const shouldRecoverCamera =") ||
      !section.includes("!isCameraOffRef.current;") ||
      !section.includes("if (liveVideoTrack) {") ||
      !section.includes("liveVideoTrack.enabled = true;")
    ) {
      failures.push(
        "web local camera producer-close recovery must preserve camera intent even before a live camera track is visible",
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

  const produceStart = socketText.indexOf("const produce = useCallback(");
  const produceEnd = socketText.indexOf(
    "const consumeProducer = useCallback",
    produceStart,
  );
  if (produceStart < 0 || produceEnd < 0) {
    failures.push("web local producer publish helper missing");
  } else {
    const section = socketText.slice(produceStart, produceEnd);
    if (
      !section.includes("microphone publish retry scheduled") ||
      !section.includes("audioTrack.enabled = true;") ||
      !section.includes("isMutedRef.current = false;") ||
      !section.includes("setIsMuted(false);") ||
      !section.includes("requestAudioProducerRecovery();")
    ) {
      failures.push(
        "web reconnect join audio publish failures must preserve unmuted intent and queue producer recovery",
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
    if (
      !section.includes("const previousStream = localStreamRef.current;") ||
      !section.includes("commitLocalStream(new MediaStream(remainingTracks));") ||
      !section.includes("if (currentStream?.getTracks().includes(createdTrack))") ||
      !section.includes("commitLocalStream(new MediaStream(remaining));")
    ) {
      failures.push(
        "web camera toggle cleanup must keep local stream ref synchronized",
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
    const retryIndex = section.indexOf(
      'publicationWarnings.push("camera publish retry scheduled")',
    );
    const failedIndex = section.indexOf(
      'publicationWarnings.push("camera publish failed")',
    );
    if (
      retryIndex < 0 ||
      !section.includes("const liveVideoTrack = getFirstLiveTrack(") ||
      !section.includes("setIsCameraOff(false);") ||
      !section.includes("requestCameraProducerRecovery();")
    ) {
      failures.push(
        "web initial camera publish failure with live track must preserve camera intent",
      );
    }
    if (failedIndex >= 0 && retryIndex >= 0 && failedIndex < retryIndex) {
      failures.push(
        "web initial camera publish failure must retry recovery before marking camera off",
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
  const start = text.indexOf("const recoverStalledProducer = async");
  const end = text.indexOf("const pollOutboundProgress = () => {", start);
  if (start < 0 || end < 0) {
    failures.push("web camera outbound stall watchdog section missing");
  } else {
    const section = text.slice(start, end);
    if (
      !section.includes("producer.replaceTrack({ track: publishTrack });") ||
      !section.includes("waitForPreferredVideoPublishTrack(") ||
      !section.includes("closeLocalVideoProducerForReplacement(producer);") ||
      !section.includes("requestCameraProducerRecovery();") ||
      !section.includes("cameraRecoveryForceSingleLayerRef.current = true") ||
      !section.includes("getFallbackWebcamCodec(device, currentCodec)")
    ) {
      failures.push(
        "web stalled camera sender recovery must repair with preferred camera track and then recreate with single-layer codec fallback",
      );
    }
    const rawRepairIndex = section.indexOf(
      "producer.replaceTrack({ track: publishTrack });",
    );
    const rawRepairConditionIndex = section.indexOf(
      "const shouldTryPreferredRepair = !state.rawRepairAttempted;",
    );
    const recreateIndex = section.indexOf(
      "closeLocalVideoProducerForReplacement(producer);",
    );
    const hiddenGuardIndex = section.indexOf("if (!allowProducerRecreate)");
    if (
      rawRepairIndex >= 0 &&
      recreateIndex >= 0 &&
      recreateIndex < rawRepairIndex
    ) {
      failures.push(
        "web stalled camera sender recovery must try raw-track repair before producer recreation",
      );
    }
    if (
      rawRepairConditionIndex < 0 ||
      !section.includes("publishTrack.id === rawCameraTrack.id") ||
      !section.includes(
        "Refreshed stalled camera sender with preferred camera track",
      )
    ) {
      failures.push(
        "web stalled camera sender recovery must soft-refresh preferred camera before any destructive producer recreation",
      );
    }
    if (
      rawRepairIndex >= 0 &&
      hiddenGuardIndex >= 0 &&
      hiddenGuardIndex < rawRepairIndex
    ) {
      failures.push(
        "web hidden-tab camera stalls must try preferred-track repair before the no-recreate guard",
      );
    }
    if (
      !/!allowProducerRecreate \|\|[\s\S]*isMediaRecoveryBlocked\(\)[\s\S]*Stalled camera sender recovery failed; keeping producer open/.test(
        section,
      )
    ) {
      failures.push(
        "web stalled camera sender recovery failure must honor hidden-tab and reconnect no-recreate guards",
      );
    }
  }
  assertIncludes(
    "webMeetMedia",
    "CAMERA_OUTBOUND_STALL_SAMPLES_BEFORE_RECOVERY",
    "web camera outbound stall threshold",
  );
  assertRegex(
    "webMeetMedia",
    /producer[\s\S]*\.getStats\(\)[\s\S]*readOutboundVideoProgressSample\(report\)[\s\S]*hasOutboundVideoProgress/,
    "web camera sender watchdog monitors outbound RTP frame progress",
  );
  assertRegex(
    "webMeetMedia",
    /framesPerSecond: number \| null[\s\S]*currentFramesPerSecond = getRtcStatsNumber\(stat, "framesPerSecond"\)[\s\S]*When frame counters exist, they are the strongest signal[\s\S]*sample\.frames > previous\.frames[\s\S]*sample\.framesPerSecond !== null[\s\S]*return true;[\s\S]*return false;[\s\S]*previous\.bytes !== null[\s\S]*sample\.bytes - previous\.bytes >= MIN_OUTBOUND_VIDEO_BYTE_DELTA_FOR_PROGRESS[\s\S]*return true;/,
    "web camera sender watchdog must treat flat frame counters as stalled video",
  );
  assertRegex(
    "webMeetMedia",
    /allowProducerRecreate: boolean[\s\S]*if \(!allowProducerRecreate\) \{[\s\S]*Camera sender stalled in background; keeping producer open/,
    "web hidden camera sender watchdog repairs preferred tracks without background producer recreation",
  );
  assertRegex(
    "webMeetMedia",
    /const allowProducerRecreate =[\s\S]*document\.visibilityState === "visible"[\s\S]*recoverStalledProducer\(\{[\s\S]*allowProducerRecreate/,
    "web camera sender watchdog passes foreground state to stalled recovery",
  );
  assertRegex(
    "webMeetMedia",
    /qualityLimitationReason[\s\S]*isEncoderLimitedOutboundSample[\s\S]*qualityLimitationReason === "bandwidth"[\s\S]*qualityLimitationReason === "cpu"[\s\S]*stalledSamples < CAMERA_OUTBOUND_STALL_SAMPLES_BEFORE_RECOVERY \|\|[\s\S]*isEncoderLimitedOutboundSample\(sample\)/,
    "web camera sender watchdog must not recreate producers for encoder-limited stalls",
  );
  assertRegex(
    "webMeetMedia",
    /producer\.replaceTrack\(\{ track: publishTrack \}\);[\s\S]*publishTrack\.id === rawCameraTrack\.id[\s\S]*onPreferredVideoPublishTrackRejected\?\.[\s\S]*camera-outbound-stall-raw-repair/,
    "web raw camera repair suppresses the rejected processed publish track",
  );
  assertRegex(
    "webMeetMedia",
    /let createdTrack: MediaStreamTrack \| null = null;[\s\S]*const removeCreatedTrackFromLocalStream = \(\) => \{[\s\S]*stopLocalTrack\(createdTrack\);[\s\S]*createdTrack = null;[\s\S]*cameraRecoveryInFlightRef\.current = true;[\s\S]*const recoverCameraProducer = async \(\) => \{[\s\S]*if \(cancelled\) \{[\s\S]*recoveredProducer\.close\(\);[\s\S]*removeCreatedTrackFromLocalStream\(\);[\s\S]*catch \(err\) \{[\s\S]*removeCreatedTrackFromLocalStream\(\);[\s\S]*return \(\) => \{[\s\S]*cancelled = true;[\s\S]*removeCreatedTrackFromLocalStream\(\);/,
    "web cancelled camera recovery stops recovery-created camera tracks",
  );
  assertRegex(
    "webMeetMedia",
    /Processed \$\{context\} camera publish failed; retrying raw camera:[\s\S]*onPreferredVideoPublishTrackRejected\?\.[\s\S]*\`\$\{context\}-raw-produce-fallback\`/,
    "web raw camera produce fallback suppresses the rejected processed publish track",
  );
  assertRegex(
    "webMeetMedia",
    /Processed device-switch track failed; retrying raw camera:[\s\S]*onPreferredVideoPublishTrackRejected\?\.[\s\S]*device-switch-raw-replace-fallback/,
    "web device-switch raw fallback suppresses the rejected processed publish track",
  );
  assertRegex(
    "webMeetMedia",
    /Processed quality-switch track failed; retrying raw camera:[\s\S]*onPreferredVideoPublishTrackRejected\?\.[\s\S]*quality-switch-raw-replace-fallback/,
    "web quality-switch raw fallback suppresses the rejected processed publish track",
  );
  assertRegex(
    "webMeetSocket",
    /onPreferredVideoPublishTrackRejected\?:[\s\S]*Processed camera publish failed; retrying raw camera:[\s\S]*onPreferredVideoPublishTrackRejected\?\.[\s\S]*join-raw-produce-fallback/,
    "web socket join raw fallback suppresses the rejected processed publish track",
  );
  assertRegex(
    "webMeetClient",
    /useMeetSocket\(\{[\s\S]*getVideoPublishTrack,[\s\S]*onPreferredVideoPublishTrackRejected:\s*handlePreferredVideoPublishTrackRejected/,
    "web meet client passes processed-track rejection callback to socket hook",
  );
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
    if (
      !section.includes(
        "const recoveryCodecOverride = cameraRecoveryCodecOverrideRef.current",
      ) ||
      !section.includes("let videoTrack = getFirstLiveTrack(") ||
      !section.includes("recoveryCodecOverride ??") ||
      !section.includes("forceSingleLayer,") ||
      !section.includes("consumedRecoveryPublishOverride") ||
      !section.includes("cameraRecoveryForceSingleLayerRef.current = false")
    ) {
      failures.push(
        "web camera producer recovery must consume and clear single-layer codec fallback after attempted publish",
      );
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
assertRegex(
  "webMeetSocket",
  /STALL_SAMPLES_BEFORE_PLI = 1[\s\S]*KEYFRAME_REQUEST_COOLDOWN_MS = 3500[\s\S]*bytesNow - prev\.bytes >= MIN_STALL_BYTE_DELTA[\s\S]*sampleNow - lastKeyFrameRequestAt >= KEYFRAME_REQUEST_COOLDOWN_MS[\s\S]*requestKeyFrame: true[\s\S]*lastKeyFrameRequestAt = sampleNow/,
  "web frozen remote video decoders request keyframes after one stalled decode sample with cooldown",
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
  } else {
    const section = text.slice(start, end);
    if (section.includes("handleReconnectRef.current")) {
      failures.push(
        "web stale consumer recovery must not trigger full meeting reconnect",
      );
    }
    if (
      section.includes("handleProducerClosed(producerInfo.producerId)") ||
      section.includes(
        "closeConsumerForSameProducerReconsume(producerInfo.producerId);",
      ) ||
      !section.includes(
        "await consumeProducer(producerInfo, { replaceExisting: true });",
      )
    ) {
      failures.push(
        "web stale consumer recovery must keep the old stream rendered until replacement consume succeeds",
      );
    }
  }
}
{
  const text = source.webAdaptivePublishQuality;
  const start = text.indexOf("const applyLiveProducerProfile = useCallback(");
  const end = text.indexOf("const restoreStandardCaptureIfNeeded", start);
  if (start < 0 || end < 0) {
    failures.push("web adaptive live-profile section missing");
  } else if (text.slice(start, end).includes("updateVideoQualityRef.current")) {
    failures.push(
      "web adaptive live-profile tick must not refresh camera capture constraints",
    );
  }
}
assertRegex(
  "webAdaptivePublishQuality",
  /needsStandardCaptureRestore[\s\S]*STANDARD_CAPTURE_MIN_WIDTH[\s\S]*STANDARD_CAPTURE_MIN_HEIGHT[\s\S]*STANDARD_CAPTURE_MIN_FRAMERATE/,
  "web adaptive good-link restore only refreshes undersized camera capture",
);
assertRegex(
  "webAdaptivePublishQuality",
  /getStandardCaptureRestoreSignature[\s\S]*settings\.width[\s\S]*settings\.height[\s\S]*settings\.frameRate[\s\S]*const signature = getStandardCaptureRestoreSignature\([\s\S]*webcamProducer\.id,[\s\S]*webcamTrack/,
  "web adaptive good-link restore signature tracks live capture settings",
);
assertRegex(
  "webAdaptivePublishQuality",
  /const restoreStandardCaptureIfNeeded = useCallback[\s\S]*videoQualityRef\.current !== "standard"[\s\S]*webcamTrack\?\.readyState !== "live"[\s\S]*if \(needsStandardCaptureRestore\(webcamTrack\)\) \{[\s\S]*await updateVideoQualityRef\.current\("standard", "good"\)[\s\S]*\} else \{[\s\S]*await applyWebcamProducerNetworkProfile\([\s\S]*webcamProducer,[\s\S]*"standard",[\s\S]*"good",[\s\S]*\);[\s\S]*lastStandardCaptureRestoreSignatureRef\.current = signature/,
  "web adaptive good-link restore avoids camera constraint churn when capture is already standard",
);
assertRegex(
  "webAdaptivePublishQuality",
  /STANDARD_CAPTURE_RESTORE_RETRY_MS[\s\S]*standardCaptureRestoreRetryTimeoutRef[\s\S]*scheduleRestoreRetry[\s\S]*updateInFlightRef\.current[\s\S]*scheduleRestoreRetry\(\)[\s\S]*Adaptive standard camera capture restore failed[\s\S]*scheduleRestoreRetry\(\)/,
  "web adaptive good-link standard capture restore retries after in-flight or failed restore",
);
assertRegex(
  "webAdaptivePublishQuality",
  /shouldRestoreStableStandardCapture[\s\S]*capRecoveryQuality === "good"[\s\S]*capRecoveryElapsedMs >= GOOD_LIVE_RESTORE_AFTER_MS[\s\S]*currentPublishQuality === "standard"[\s\S]*void restoreStandardCaptureIfNeeded\(\)\.finally\(\(\) => \{[\s\S]*applyLiveProducerProfile\("good"\)[\s\S]*\} else \{[\s\S]*applyStableLiveProfile\(\);/,
  "web adaptive good-link capture restore also restores good publish profiles",
);
{
  const text = source.webAdaptivePublishQuality;
  const start = text.indexOf(
    "autoDowngradedRef.current ||\n          networkManagedVideoQualityRef?.current === true",
  );
  const end = text.indexOf("if (shouldRestoreStableStandardCapture)", start);
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
assertRegex(
  "sfuConfig",
  /const BACKGROUND_SOCKET_RECOVERY_WINDOW_MS = 120000;[\s\S]*disconnectGraceMs: toNumber\([\s\S]*SFU_SOCKET_DISCONNECT_GRACE_MS[\s\S]*BACKGROUND_SOCKET_RECOVERY_WINDOW_MS[\s\S]*recoveryMaxDisconnectionMs: toNumber\([\s\S]*SFU_SOCKET_RECOVERY_MAX_MS[\s\S]*BACKGROUND_SOCKET_RECOVERY_WINDOW_MS/,
  "SFU default socket recovery and disconnect grace stay aligned for background clients",
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
assertRegex(
  "webMeetSocket",
  /status\.state === "reconnected"[\s\S]*!visibleParticipantReconnectingIdsRef\.current\.has\(targetUserId\)[\s\S]*clearParticipantConnectionStatusTimer\(targetUserId\)[\s\S]*UPDATE_CONNECTION_STATUS[\s\S]*status: null[\s\S]*return;[\s\S]*status\.state === "reconnecting"[\s\S]*visibleParticipantReconnectingIdsRef\.current\.add\(targetUserId\)/,
  "web unmatched reconnected events clear stale peer badges without showing a new one",
);
assertRegex(
  "webMeetSocket",
  /if \(!preserveMeetingState\) \{[\s\S]*participantConnectionStatusTimeoutsRef\.current\.values\(\)[\s\S]*participantConnectionStatusTimeoutsRef\.current\.clear\(\);[\s\S]*visibleParticipantReconnectingIdsRef\.current\.clear\(\);[\s\S]*\}[\s\S]*staleConsumerRecoveryTimeoutsRef/,
  "web state-preserving reconnect cleanup keeps peer reconnect status timers",
);
assertRegex(
  "webMeetSocket",
  /const shouldSurfaceReconnectState =[\s\S]*!shouldDeferTransportRecoveryUntilVisible\(\);[\s\S]*if \(shouldSurfaceReconnectState\) \{[\s\S]*setConnectionState\("reconnecting"\);[\s\S]*Background reconnect in progress; preserving joined UI state/,
  "web hidden-tab reconnect attempts must not surface reconnecting UI state",
);
assertRegex(
  "webMeetSocket",
  /const handleReconnect = useCallback\(async \(\) => \{[\s\S]*reconnectInFlightRef\.current = true;[\s\S]*const shouldSurfaceReconnectState =[\s\S]*cleanupRoomResources\(\{[\s\S]*preserveMeetingState: true[\s\S]*await joinRoomInternal[\s\S]*\} finally \{[\s\S]*reconnectInFlightRef\.current = false;/,
  "web hidden-tab reconnect keeps internal media recovery blocked across cleanup and rejoin",
);
assertRegex(
  "webMeetSocket",
  /meet_reconnect_success[\s\S]*attempt: reconnectAttemptsRef\.current[\s\S]*reconnectAttemptsRef\.current = 0;[\s\S]*return;/,
  "web successful reconnect resets retry attempts after reused-socket rejoins",
);
assertIncludes(
  "sfuConfig",
  "BACKGROUND_SOCKET_RECOVERY_WINDOW_MS = 120000",
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
assertRegex(
  "webMeetMedia",
  /const closeLocalAudioProducerForReplacement = useCallback\([\s\S]*intentionalLocalProducerCloseIdsRef\.current\.add\(producer\.id\)[\s\S]*socketRef\.current\?\.emit\([\s\S]*"closeProducer"[\s\S]*producerId: producer\.id[\s\S]*producer\.close\(\)[\s\S]*audioProducerRef\.current = null;/,
  "web audio producer replacement closes are intentional and notify the SFU",
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

// Bandwidth-heavy video effects assets must not auto-load on constrained links,
// but selected effects must stay active once the user asks for them.
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
assertNotIncludes(
  "webNetworkInformation",
  "shouldSuppressBandwidthHeavyVideoEffects",
  "web network hints must not expose an effects disable gate",
);
assertNotIncludes(
  "webMeetClient",
  "useBandwidthHeavyVideoEffectsSuppressed",
  "web meet-shell must not import an effects suppression hook",
);
assertNotIncludes(
  "webMeetClient",
  "shouldSuppressVideoEffectsForBandwidth",
  "web meet-shell must not disable selected video effects for bandwidth",
);
assertRegex(
  "webMeetClient",
  /const shouldRunVisualVideoEffects = activeVideoEffectsCount > 0;[\s\S]*const shouldRunVideoEffects = shouldRunVisualVideoEffects;[\s\S]*const shouldPublishProcessedVideo = shouldRunVisualVideoEffects;/,
  "web meet-shell effects stay active across visibility and bandwidth changes",
);
assertNotIncludes(
  "webMeetClient",
  "activeVideoEffectsCount > 0 &&\n    isDocumentVisible &&\n    !shouldSuppressVideoEffectsForBandwidth",
  "web hidden tabs must not suspend active video effects",
);
assertRegex(
  "webMeetClient",
  /document\.addEventListener\("visibilitychange", syncDocumentVisibility\);[\s\S]*window\.addEventListener\("pageshow", syncDocumentVisibility\);/,
  "web meet-shell tracks page visibility for foreground prewarm/debug state",
);
assertIncludes(
  "webMeetClient",
  "const shouldPublishProcessedVideo = shouldRunVisualVideoEffects;",
  "web active effects publish processed video regardless of tab visibility",
);
assertIncludes(
  "webVideoEffects",
  "const PROCESSED_OUTPUT_STALE_RELEASE_MS = 2500;",
  "web stale processed effects output release threshold",
);
assertIncludes(
  "webVideoEffects",
  "const DUPLICATE_OUTPUT_HEARTBEAT_MS = 900;",
  "web processed effects duplicate-frame heartbeat cadence",
);
assertIncludes(
  "webVideoEffects",
  "const PROCESSED_OUTPUT_STALE_CHECK_MS = 1000;",
  "web stale processed effects output heartbeat interval",
);
assertIncludes(
  "webVideoEffects",
  "const HIDDEN_STALE_OUTPUT_REPUBLISH_RETRY_MS = 5000;",
  "web hidden processed effects republish retry cadence",
);
assertIncludes(
  "webVideoEffects",
  "const HIDDEN_VIDEO_REARM_INTERVAL_MS = 5000;",
  "web hidden effects source video rearm cadence",
);
assertRegex(
  "webVideoEffects",
  /const duplicateOutputHeartbeatDue =[\s\S]*DUPLICATE_OUTPUT_HEARTBEAT_MS[\s\S]*!duplicateOutputHeartbeatDue/,
  "web duplicate processed effects frames still heartbeat before stale release",
);
assertRegex(
  "webVideoEffects",
  /const getLatestOutputFrameAgeMs =[\s\S]*latestOutputFrameAt[\s\S]*const isHiddenStaleProcessedOutput =[\s\S]*document\.visibilityState !== "visible"[\s\S]*PROCESSED_OUTPUT_STALE_RELEASE_MS[\s\S]*const releaseStaleProcessedOutputIfNeeded =[\s\S]*preserve_processed_track_hidden_stale[\s\S]*return false;[\s\S]*releaseOutputTrackToRaw\(reason\);/,
  "web hidden-tab stale processed effects output preserves effects instead of raw fallback",
);
assertRegex(
  "webVideoEffects",
  /const keepHiddenStaleProcessedOutputAlive = async[\s\S]*isHiddenStaleProcessedOutput\(sampleNow\)[\s\S]*restoreLastVisibleOutputFrame\(\s*"hidden-stale-output-keepalive"[\s\S]*await deliverOutputFrame\(sampleNow\)[\s\S]*HIDDEN_STALE_OUTPUT_REPUBLISH_RETRY_MS[\s\S]*setProcessedTrackReady\(true\);[\s\S]*bumpProcessedTrackVersionForFreshOutput\([\s\S]*"hidden-stale-output-keepalive"[\s\S]*"hidden_stale_output_keepalive"/,
  "web hidden stale processed effects output sends keepalive frames instead of going inert",
);
assertRegex(
  "webVideoEffects",
  /const handleDocumentVisibilityChange = \(\) => \{[\s\S]*rearmHiddenVideoPlayback\(reason\)[\s\S]*keepHiddenStaleProcessedOutputAlive\(reason\)[\s\S]*video\.addEventListener\("pause", handleHiddenVideoPlaybackStall\)[\s\S]*video\.addEventListener\("stalled", handleHiddenVideoPlaybackStall\)[\s\S]*document\.addEventListener\("visibilitychange", handleDocumentVisibilityChange\)[\s\S]*hiddenVideoRearmIntervalId = window\.setInterval/,
  "web hidden effects pipeline actively rearms background video playback",
);
assertRegex(
  "webVideoEffects",
  /const publishOutputTrack = \(\) => \{[\s\S]*setProcessedTrack\(track\);[\s\S]*bumpProcessedTrackVersionForFreshOutput\("publish-processed-track"\);/,
  "web processed effects publish bumps version so raw fallback suppression can retry",
);
assertRegex(
  "webVideoEffects",
  /processedOutputStaleCheckIntervalId = window\.setInterval\(\(\) => \{[\s\S]*releaseStaleProcessedOutputIfNeeded\(\s*"processed output stale heartbeat",\s*sampleNow,\s*\);[\s\S]*keepHiddenStaleProcessedOutputAlive\([\s\S]*PROCESSED_OUTPUT_STALE_CHECK_MS[\s\S]*window\.clearInterval\(processedOutputStaleCheckIntervalId\);/,
  "web stale processed effects output heartbeat survives stalled effects loops",
);
assertRegex(
  "webVideoEffects",
  /if \(!outputDelivered\) \{[\s\S]*"Effects output writer is unavailable; showing raw camera\."[\s\S]*releaseStaleProcessedOutputIfNeeded\(\s*"effects output writer unavailable",?\s*\);/,
  "web unavailable effects writer does not leave frozen processed output published",
);
assertRegex(
  "webVideoEffects",
  /const staleProcessedOutputReleased =[\s\S]*releaseStaleProcessedOutputIfNeeded\("processed output frame stale"\);[\s\S]*!staleProcessedOutputReleased &&[\s\S]*visibleOutputFrameCount >= OUTPUT_READY_FRAMES[\s\S]*publishOutputTrack\(\);/,
  "web effects output republishes processed video only after fresh frames resume",
);
assertRegex(
  "webMeetClient",
  /const publishTrackSwitchRef = useRef[\s\S]*sequence: 0,[\s\S]*promise: Promise\.resolve\(\),[\s\S]*const previousSwitch = publishTrackSwitchRef\.current\.promise;[\s\S]*await previousSwitch\.catch\(\(\) => \{\}\);[\s\S]*publishTrackSwitchRef\.current\.sequence !== sequence[\s\S]*const publishStream = refs\.localStreamRef\.current \?\? localStream;[\s\S]*await producer\.replaceTrack\(\{ track: nextTrack \}\);[\s\S]*const rawFallbackTrack = getRawVideoPublishTrack\(publishStream\);[\s\S]*await producer\.replaceTrack\(\{ track: rawFallbackTrack \}\);/,
  "web processed/raw publish track switches are serialized",
);
assertRegex(
  "webMeetClient",
  /if \(activeVideoEffectsCount <= 0\) return;[\s\S]*if \(!isDocumentVisible\) return;[\s\S]*if \(shouldDeferVideoEffectsPreload\) return;[\s\S]*prewarmVideoEffectsRuntimeDeferred/,
  "web meet-shell runtime prewarm constrained-link guard",
);
assertRegex(
  "webMeetClient",
  /if \(restoredVideoEffectsPrewarmDoneRef\.current\) return;[\s\S]*if \(!isDocumentVisible\) return;[\s\S]*if \(shouldDeferVideoEffectsPreload\) return;[\s\S]*reason: "restored-effects-state"/,
  "web restored-effects asset prewarm constrained-link guard",
);
assertRegex(
  "webMeetClient",
  /if \(activeVideoEffectsCount <= 0\) return;[\s\S]*if \(isCameraOff \|\| !hasLiveVideoTrack\(localStream\)\) return;[\s\S]*if \(!isDocumentVisible\) return;[\s\S]*if \(shouldDeferVideoEffectsPreload\) return;[\s\S]*reason: "camera-live"/,
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
    /const shouldRunPreviewVideoEffects = activeVideoEffectsCount > 0;/,
    `${label} effects run whenever selected`,
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

assertRegex(
  "meetingParticipantReducer",
  /if \(!action\.stream\) \{[\s\S]*currentProducerId[\s\S]*currentProducerId !== action\.producerId[\s\S]*return state;/,
  "shared participant reducer ignores stale producer close events",
);
assertRegex(
  "meetingParticipantReducer",
  /case "UPDATE_CONNECTION_STATUS":[\s\S]*const participant = state\.get\(action\.userId\);[\s\S]*if \(!participant && !action\.status\) return state;/,
  "shared participant reducer ignores stale connection-status clears for missing participants",
);
assertRegex(
  "webMeetSocket",
  /getMatchingReplacementState[\s\S]*producerMapRef\.current\.entries\(\)[\s\S]*announcedRemoteProducersRef\.current\.entries\(\)[\s\S]*hasReplacementProducer:[\s\S]*hasConsumedReplacement \|\| hasPendingReplacement[\s\S]*pendingReplacementProducerId[\s\S]*clearClosedProducerState[\s\S]*UPDATE_STREAM[\s\S]*stream: null[\s\S]*if \(!hasPendingReplacement\)[\s\S]*UPDATE_CAMERA_OFF[\s\S]*announcedRemoteProducersRef\.current\.set\(data\.producerId, data\)/,
  "web producer replacement announcements suppress transient stream and camera-off clears",
);
assertRegex(
  "webMeetSocket",
  /PRODUCER_CLOSE_REPLACEMENT_GRACE_MS[\s\S]*if \(!replacementState\.hasReplacementProducer\)[\s\S]*window\.setTimeout[\s\S]*latestReplacementState = getMatchingReplacementState\(\)[\s\S]*latestReplacementState\.hasConsumedReplacement[\s\S]*clearClosedProducerState\(\{[\s\S]*latestReplacementState\.hasPendingReplacement[\s\S]*preservePendingScreenShare: true/,
  "web unannounced producer closes wait briefly for reconnect replacement before clearing streams",
);
assertRegex(
  "webMeetSocket",
  /SCREEN_SHARE_STALE_REPLACEMENT_CLEANUP_DELAY_MS[\s\S]*const scheduleStaleReplacementCleanup = \(\) => \{[\s\S]*const cleanupDelayMs =[\s\S]*info\.kind === "video" && info\.type === "screen"[\s\S]*SCREEN_SHARE_STALE_REPLACEMENT_CLEANUP_DELAY_MS[\s\S]*STALE_REPLACEMENT_CLEANUP_DELAY_MS[\s\S]*clearClosedProducerState\(\{[\s\S]*latestReplacementState\.hasPendingReplacement[\s\S]*preservePendingScreenShare: false[\s\S]*cleanupDelayMs[\s\S]*else if \(!replacementState\.hasConsumedReplacement\)[\s\S]*setActiveScreenShareId\(replacementState\.pendingReplacementProducerId\)[\s\S]*scheduleStaleReplacementCleanup\(\);/,
  "web stale producer replacement cleanup quickly clears failed screen shares while preserving pending replacements",
);
{
  const text = source.webMeetSocket;
  const start = text.indexOf("const handleProducerClosed = useCallback(");
  const end = text.indexOf("const queueProducerConsumeRetry = useCallback", start);
  if (start < 0 || end < 0) {
    failures.push("web producer-close replacement cleanup section missing");
  } else {
    const section = text.slice(start, end);
    const infoIndex = section.indexOf(
      "const info = producerMapRef.current.get(producerId);",
    );
    const clearIndex = section.indexOf(
      "clearStaleReplacementCleanupTimeout(producerId);",
    );
    if (infoIndex < 0 || clearIndex < 0 || clearIndex < infoIndex) {
      failures.push(
        "web duplicate producerClosed events must not cancel pending replacement cleanup after producer info is gone",
      );
    }
    if (
      !/pendingReplacementProducerId[\s\S]*setActiveScreenShareId\([\s\S]*preservePendingScreenShare && pendingReplacementProducerId[\s\S]*scheduleStaleReplacementCleanup[\s\S]*preservePendingScreenShare: false[\s\S]*replacementState\.pendingReplacementProducerId[\s\S]*setActiveScreenShareId\(replacementState\.pendingReplacementProducerId\)/.test(
        section,
      )
    ) {
      failures.push(
        "web screen-share replacements must move active state to pending replacements and clear never-consumed replacements",
      );
    }
  }
}
{
  const text = source.webMeetSocket;
  const start = text.indexOf(
    "const closeConsumerForSameProducerReconsume = useCallback(",
  );
  const end = text.indexOf("const handleProducerClosed = useCallback", start);
  if (start < 0 || end < 0) {
    failures.push("web same-producer consumer reconsume cleanup helper missing");
  } else {
    const section = text.slice(start, end);
    if (
      !section.includes("consumerToClose?: Consumer | null") ||
      !section.includes("clearStaleReplacementCleanupTimeout(producerId);") ||
      !section.includes("consumer.track.onmute = null;") ||
      !section.includes("consumer.track.onunmute = null;") ||
      !section.includes("consumer.track.stop();") ||
      !section.includes("consumersRef.current.get(producerId)?.id === consumer.id") ||
      !section.includes("consumersRef.current.delete(producerId);") ||
      section.includes('type: "UPDATE_STREAM"') ||
      section.includes("producerMapRef.current.delete(producerId)")
    ) {
      failures.push(
        "web same-producer consumer reconsume must close only stale consumer resources without clearing participant streams",
      );
    }
  }
}
{
  const text = source.webMeetSocket;
  const start = text.indexOf("const consumeProducer = useCallback(");
  const end = text.indexOf("consumeProducerRef.current = consumeProducer", start);
  if (start < 0 || end < 0) {
    failures.push("web consume producer section missing");
  } else {
    const section = text.slice(start, end);
    const dispatchIndex = section.indexOf('type: "UPDATE_STREAM"');
    const closeIndex = section.indexOf(
      "closeConsumerForSameProducerReconsume(\n                  producerInfo.producerId,\n                  existingConsumer,",
    );
    if (
      !section.includes("options: ConsumeProducerOptions = {}") ||
      !section.includes("existingConsumer && !options.replaceExisting") ||
      dispatchIndex < 0 ||
      closeIndex < 0 ||
      closeIndex < dispatchIndex
    ) {
      failures.push(
        "web replacement consumer handoff must dispatch the new stream before closing the old consumer",
      );
    }
  }
}
assertRegex(
  "sfuClient",
  /addProducer\(producer: Producer\): Producer \| null[\s\S]*const displacedProducer =[\s\S]*return displacedProducer;/,
  "SFU client returns displaced producer instead of closing it inline",
);
assertRegex(
  "sfuClient",
  /addConsumer\([\s\S]*\): Consumer \| null[\s\S]*const displacedConsumer =[\s\S]*this\.consumerProducerIdsById\.delete\(displacedConsumer\.id\)[\s\S]*return displacedConsumer;/,
  "SFU client returns displaced consumer instead of closing it inline",
);
{
  const text = source.sfuMediaHandlers;
  const newProducerIndex = text.indexOf('client.socket.emit("newProducer"');
  const closeIndex = text.indexOf("displacedProducer.close()", newProducerIndex);
  if (newProducerIndex < 0 || closeIndex < 0 || closeIndex < newProducerIndex) {
    failures.push(
      "SFU producer replacement must advertise the new producer before closing the displaced producer",
    );
  }
}
assertRegex(
  "sfuMediaHandlers",
  /const displacedConsumer = currentClient\.addConsumer[\s\S]*respond\(callback, \{[\s\S]*priority: consumer\.priority,[\s\S]*if \(displacedConsumer && !displacedConsumer\.closed\) \{[\s\S]*DISPLACED_CONSUMER_CLOSE_DELAY_MS/,
  "SFU same-producer consumer replacement must respond before closing the displaced consumer",
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
