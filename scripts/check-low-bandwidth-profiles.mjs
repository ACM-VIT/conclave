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
  /fair:\s*32000,[\s\S]*poor:\s*24000,[\s\S]*emergency:\s*18000,/,
  "web microphone Opus constrained ladder",
);
assertRegex(
  "webConstants",
  /fair:\s*MICROPHONE_OPUS_MAX_AVERAGE_BITRATE_BY_PROFILE\.fair,[\s\S]*poor:\s*MICROPHONE_OPUS_MAX_AVERAGE_BITRATE_BY_PROFILE\.poor,[\s\S]*emergency:\s*18000,/,
  "web screen-audio Opus constrained ladder",
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
  "isVisible ? bounds.maxTemporalLayer : 0",
  "web visible good-link tiles keep max temporal layer",
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
  "shouldUpdateCaptureConstraintsForQualitySwitch",
  "web capture constraint updates are gated to upgrades",
);
assertIncludes(
  "webMeetMedia",
  'quality === "standard" && profile === "good"',
  "web downgrades avoid camera capture restarts",
);
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
assertIncludes(
  "sfuRoom",
  "schedulePendingDisconnectNotification",
  "SFU delayed reconnect notification helper",
);
assertIncludes(
  "sfuDisconnectHandlers",
  "room.schedulePendingDisconnectNotification",
  "SFU reconnect badge delayed inside disconnect grace window",
);
assertIncludes(
  "sfuDisconnectHandlers",
  "const reconnectNoticeDelayMs = Math.max(0, graceMs - 1000);",
  "SFU reconnect badge appears only at the end of disconnect grace",
);
assertIncludes(
  "sfuConfig",
  "30000",
  "SFU socket disconnect grace tolerates backgrounded tabs",
);
assertIncludes(
  "sfuDisconnectHandlers",
  'reason !== "ping timeout"',
  "SFU suppresses ambiguous ping-timeout reconnect badges",
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
  /const shouldRunVideoEffects =\s*activeVideoEffectsCount > 0 &&\s*!shouldSuppressVideoEffectsForBandwidth;/,
  "web meet-shell effects only run when active and not constrained",
);
assertRegex(
  "webMeetClient",
  /if \(activeVideoEffectsCount <= 0\) return;[\s\S]*if \(shouldSuppressVideoEffectsForBandwidth\) return;[\s\S]*prewarmVideoEffectsRuntimeDeferred/,
  "web meet-shell runtime prewarm constrained-link guard",
);
assertRegex(
  "webMeetClient",
  /if \(restoredVideoEffectsPrewarmDoneRef\.current\) return;[\s\S]*if \(shouldSuppressVideoEffectsForBandwidth\) return;[\s\S]*reason: "restored-effects-state"/,
  "web restored-effects asset prewarm constrained-link guard",
);
assertRegex(
  "webMeetClient",
  /if \(activeVideoEffectsCount <= 0\) return;[\s\S]*if \(isCameraOff \|\| !hasLiveVideoTrack\(localStream\)\) return;[\s\S]*if \(shouldSuppressVideoEffectsForBandwidth\) return;[\s\S]*reason: "camera-live"/,
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
