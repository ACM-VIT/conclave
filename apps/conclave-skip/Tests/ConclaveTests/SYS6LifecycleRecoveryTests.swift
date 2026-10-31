#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct SYS6LifecycleRecoveryTests {

    @Test func refreshKindFollowsTheDeepestPhaseSinceActive() {
        #expect(LifecycleRefreshPolicy.kind(previous: .inactive, next: .active) == .light)
        #expect(LifecycleRefreshPolicy.kind(previous: .background, next: .active) == .full)
        #expect(LifecycleRefreshPolicy.kind(previous: .launching, next: .active) == .full)
        #expect(LifecycleRefreshPolicy.kind(previous: .active, next: .active) == LifecycleRefreshKind.none)

        let phases: [ConclaveAppLifecyclePhase] = [.launching, .active, .inactive, .background]
        for previous in phases {
            #expect(LifecycleRefreshPolicy.kind(previous: previous, next: .inactive) == LifecycleRefreshKind.none)
            #expect(LifecycleRefreshPolicy.kind(previous: previous, next: .background) == LifecycleRefreshKind.none)
            #expect(LifecycleRefreshPolicy.kind(previous: previous, next: .launching) == LifecycleRefreshKind.none)
        }
        #expect(LifecycleRefreshPolicy.deepest(.active, .inactive) == .inactive)
        #expect(LifecycleRefreshPolicy.deepest(.inactive, .background) == .background)
        #expect(LifecycleRefreshPolicy.deepest(.background, .inactive) == .background)
        #expect(LifecycleRefreshPolicy.deepest(.launching, .background) == .launching)
        #expect(LifecycleRefreshKind.allCases.map { $0.rawValue } == ["none", "light", "full"])
    }

    @Test func trackerRunsLightAfterAnInactiveHopAndFullAfterTheBackgroundOnBothPlatforms() {

        var tracker = LifecycleRefreshTracker()
        #expect(tracker.deepestSinceActive == .launching)
        #expect(tracker.record(.active) == .full)

        #expect(tracker.record(.inactive) == LifecycleRefreshKind.none)
        #expect(!tracker.isInBackground)
        #expect(tracker.record(.active) == .light)

        #expect(tracker.record(.inactive) == LifecycleRefreshKind.none)
        #expect(tracker.record(.background) == LifecycleRefreshKind.none)
        #expect(tracker.isInBackground)
        #expect(tracker.record(.inactive) == LifecycleRefreshKind.none)
        #expect(tracker.isInBackground)
        #expect(tracker.record(.active) == .full)
        #expect(!tracker.isInBackground)

        #expect(tracker.record(.inactive) == LifecycleRefreshKind.none)
        #expect(tracker.record(.background) == LifecycleRefreshKind.none)
        #expect(tracker.record(.active) == .full)

        #expect(tracker.record(.inactive) == LifecycleRefreshKind.none)
        #expect(tracker.record(.active) == .light)

        var background = LifecycleRefreshTracker()
        #expect(background.record(.background) == LifecycleRefreshKind.none)
        #expect(!background.isInBackground)
        #expect(background.record(.inactive) == LifecycleRefreshKind.none)
        #expect(background.record(.active) == .full)
    }

    @Test func countersCountEachDecisionOnce() {
        var counters = LifecycleRefreshCounters()
        counters.record(.light)
        counters.record(.none)
        counters.record(.full)
        counters.record(.light)
        counters.recordKeyframeRequests(3)
        counters.recordKeyframeRequests(0)
        counters.recordKeyframeRequests(-2)
        #expect(counters.lightRefresh == 2)
        #expect(counters.fullRecovery == 1)
        #expect(counters.keyframeRequests == 3)
        #expect(LifecycleRefreshCounters() == LifecycleRefreshCounters())
    }

    @Test func speakerSamplingStopsInTheBackgroundWithoutPip() {
        #expect(LifecycleRefreshPolicy.samplesActiveSpeaker(isInBackground: false, isInPip: false))
        #expect(LifecycleRefreshPolicy.samplesActiveSpeaker(isInBackground: false, isInPip: true))
        #expect(LifecycleRefreshPolicy.samplesActiveSpeaker(isInBackground: true, isInPip: true))
        #expect(!LifecycleRefreshPolicy.samplesActiveSpeaker(isInBackground: true, isInPip: false))
    }

    @Test func keyframesGoToVisibleUnpausedRemoteVideoOnly() {
        let candidates = [
            LifecycleKeyframeCandidate(producerId: "p-cam-b", userId: "b", kind: "video", isPaused: false),
            LifecycleKeyframeCandidate(producerId: "p-cam-a", userId: "a", kind: "video", isPaused: false),
            LifecycleKeyframeCandidate(producerId: "p-screen-a", userId: "a", kind: "video", isPaused: false),
            LifecycleKeyframeCandidate(producerId: "p-mic-a", userId: "a", kind: "audio", isPaused: false),
            LifecycleKeyframeCandidate(producerId: "p-cam-c", userId: "c", kind: "video", isPaused: true),
            LifecycleKeyframeCandidate(producerId: "p-cam-hidden", userId: "d", kind: "video", isPaused: false),
            LifecycleKeyframeCandidate(producerId: "p-cam-gone", userId: "", kind: "video", isPaused: false),
            LifecycleKeyframeCandidate(producerId: "p-cam-a", userId: "a", kind: "video", isPaused: false),
        ]
        let visible = ["a", "b", "c", ""]
        #expect(LifecycleRefreshPolicy.keyframeProducerIds(candidates, visibleUserIds: visible, receivesVideo: true)
            == ["p-cam-a", "p-cam-b", "p-screen-a"])

        #expect(LifecycleRefreshPolicy.keyframeProducerIds(candidates, visibleUserIds: visible, receivesVideo: false).isEmpty)
        #expect(LifecycleRefreshPolicy.keyframeProducerIds(candidates, visibleUserIds: [], receivesVideo: true).isEmpty)
        #expect(LifecycleRefreshPolicy.keyframeProducerIds([], visibleUserIds: visible, receivesVideo: true).isEmpty)
    }

    @Test func retryNowStartsOneRejoinBetweenAttempts() {
        #expect(RecoveryRetryPolicy.acceptsRetryNow(isRecovering: true, isRejoinInFlight: false, isRetryPending: false))
        #expect(!RecoveryRetryPolicy.acceptsRetryNow(isRecovering: false, isRejoinInFlight: false, isRetryPending: false))
        #expect(!RecoveryRetryPolicy.acceptsRetryNow(isRecovering: true, isRejoinInFlight: true, isRetryPending: false))
        #expect(!RecoveryRetryPolicy.acceptsRetryNow(isRecovering: true, isRejoinInFlight: false, isRetryPending: true))

        var pending = false
        var accepted = 0
        for _ in 0..<2 {
            if RecoveryRetryPolicy.acceptsRetryNow(isRecovering: true, isRejoinInFlight: false, isRetryPending: pending) {
                accepted += 1
                pending = true
            }
        }
        #expect(accepted == 1)
        #expect(RecoveryRetryPolicy.isAttemptInFlight(isRejoinInFlight: false, isRetryPending: pending))
        #expect(RecoveryRetryPolicy.isAttemptInFlight(isRejoinInFlight: true, isRetryPending: false))
        #expect(!RecoveryRetryPolicy.isAttemptInFlight(isRejoinInFlight: false, isRetryPending: false))
    }

    @Test func reconnectingBannerAtAttemptTwoOffersRetryNowUntilAnAttemptIsInFlight() {

        func reconnecting(inFlight: Bool) -> MeetingNotice? {
            let inputs = StageNoticeInputs.make(isRecovering: true, reconnectAttempt: 2, reconnectAttemptLimit: 5,
                                                isRecoveryAttemptInFlight: inFlight)
            let banners = MeetingNoticePolicy.bannerCandidates(inputs, hostNotice: nil, liveNotesEpisode: 0,
                                                               currentPanel: "", platform: NoticePlatform.ios)
            return banners.first { $0.kind == NoticeKind.reconnecting }
        }
        let between = reconnecting(inFlight: false)
        #expect(between?.count == 2)
        #expect(between?.total == 5)
        #expect(between?.actions == [NoticeAction.make(NoticeAction.retryRecovery, isEnabled: true)])
        let pending = reconnecting(inFlight: RecoveryRetryPolicy.isAttemptInFlight(isRejoinInFlight: false, isRetryPending: true))
        #expect(pending?.actions == [NoticeAction.make(NoticeAction.retryRecovery, isEnabled: false)])
    }

    @Test func captivePortalNeedsTheCapabilityWithoutValidation() {
        #expect(NetworkCaptivePortalPolicy.isCaptivePortal(hasCaptivePortalCapability: true, isValidated: false))
        #expect(!NetworkCaptivePortalPolicy.isCaptivePortal(hasCaptivePortalCapability: true, isValidated: true))
        #expect(!NetworkCaptivePortalPolicy.isCaptivePortal(hasCaptivePortalCapability: false, isValidated: false))
        #expect(!NetworkCaptivePortalPolicy.isCaptivePortal(hasCaptivePortalCapability: false, isValidated: true))
    }

    @Test func captivePortalBannerReplacesOfflineOnAndroidOnly() {
        let inputs = StageNoticeInputs.make(isOffline: true, isCaptivePortal: true)
        let android = MeetingNoticePolicy.bannerCandidates(inputs, hostNotice: nil, liveNotesEpisode: 0, currentPanel: "",
                                                           platform: NoticePlatform.android)
        let ios = MeetingNoticePolicy.bannerCandidates(inputs, hostNotice: nil, liveNotesEpisode: 0, currentPanel: "",
                                                       platform: NoticePlatform.ios)
        #expect(android.first?.kind == NoticeKind.captivePortal)
        #expect(android.first?.actions.map { $0.id } == [NoticeAction.openSettings])
        #expect(!android.map { $0.kind }.contains(NoticeKind.offline))
        #expect(ios.first?.kind == NoticeKind.offline)
    }

    @Test func thermalLevelsMapFromBothPlatforms() {
        #expect(SystemThermalLevel.fromAndroidThermalStatus(0) == .nominal)
        #expect(SystemThermalLevel.fromAndroidThermalStatus(1) == .fair)
        #expect(SystemThermalLevel.fromAndroidThermalStatus(2) == .fair)
        #expect(SystemThermalLevel.fromAndroidThermalStatus(3) == .serious)
        #expect(SystemThermalLevel.fromAndroidThermalStatus(4) == .critical)
        #expect(SystemThermalLevel.fromAndroidThermalStatus(5) == .critical)
        #expect(SystemThermalLevel.fromAndroidThermalStatus(6) == .critical)
        #expect(SystemThermalLevel.fromAndroidThermalStatus(-1) == .nominal)
        #expect(NetworkReachabilityMonitor.thermalLevel(for: .nominal) == .nominal)
        #expect(NetworkReachabilityMonitor.thermalLevel(for: .fair) == .fair)
        #expect(NetworkReachabilityMonitor.thermalLevel(for: .serious) == .serious)
        #expect(NetworkReachabilityMonitor.thermalLevel(for: .critical) == .critical)
        #expect(SystemThermalLevel.allCases.map { $0.ceilingSteps } == [0, 0, 1, 2])
    }

    @Test func publishTiersFollowThePresetsAndStopAtDataSaver() {
        let policy = NativeMediaQualityPolicy.self
        let auto = policy.defaultSettings.camera
        #expect(policy.publishTier(of: auto) == .auto)
        #expect(policy.publishTier(of: policy.cameraPreset(.highDefinition, current: auto)) == .highDefinition)
        #expect(policy.publishTier(of: policy.cameraPreset(.studio, current: auto)) == .studio)
        #expect(policy.publishTier(of: policy.cameraPreset(.dataSaver, current: auto)) == .dataSaver)
        var custom = auto
        custom.preset = .custom
        custom.resolution = .p1440
        custom.frameRate = 24
        #expect(policy.publishTier(of: custom) == .highDefinition)
        custom.frameRate = 60
        #expect(policy.publishTier(of: custom) == .studio)
        #expect(NativePublishTier.studio.lowered(by: 1) == .highDefinition)
        #expect(NativePublishTier.studio.lowered(by: 2) == .auto)
        #expect(NativePublishTier.auto.lowered(by: 1) == .dataSaver)
        #expect(NativePublishTier.auto.lowered(by: 2) == .dataSaver)
        #expect(NativePublishTier.dataSaver.lowered(by: 1) == .dataSaver)
        #expect(NativePublishTier.highDefinition.lowered(by: 0) == .highDefinition)
        for tier in NativePublishTier.allCases {
            #expect(policy.publishTier(of: tier.camera) == tier)
        }
    }

    @Test func ceilingComposesWithDataSaverAndNeverRaisesALimit() {
        let policy = NativeMediaQualityPolicy.self
        let auto = policy.defaultSettings.camera
        let hd = policy.cameraPreset(.highDefinition, current: auto)
        let serious = NativeSystemSendCeiling.make(thermalLevel: .serious, isLowPowerMode: false)
        let critical = NativeSystemSendCeiling.make(thermalLevel: .critical, isLowPowerMode: false)
        let lowPower = NativeSystemSendCeiling.make(thermalLevel: .nominal, isLowPowerMode: true)

        #expect(policy.effectiveCamera(hd, dataSaverOn: false, systemSendCeiling: .unconstrained) == hd)
        #expect(policy.resolvedPublishCamera(auto, dataSaverOn: false, systemSendCeiling: .unconstrained)
            == policy.resolvedCamera(auto))
        #expect(!NativeSystemSendCeiling.unconstrained.isActive)

        let hdSerious = policy.effectiveCamera(hd, dataSaverOn: false, systemSendCeiling: serious)
        #expect(hdSerious.resolution == .p720)
        #expect(hdSerious.frameRate == 30)
        #expect(hdSerious.maxBitrateKbps == 1_650)
        #expect(hdSerious.contentHint == hd.contentHint)
        #expect(hdSerious.degradationPreference == hd.degradationPreference)
        #expect(hdSerious.preset == .highDefinition)

        let hdCritical = policy.effectiveCamera(hd, dataSaverOn: false, systemSendCeiling: critical)
        #expect(hdCritical.resolution == .p360)
        #expect(hdCritical.frameRate == 20)
        #expect(hdCritical.maxBitrateKbps == 260)

        let autoSerious = policy.resolvedPublishCamera(auto, dataSaverOn: false, systemSendCeiling: serious)
        #expect(autoSerious.height == 360)
        #expect(autoSerious.frameRate == 20)
        #expect(autoSerious.maxBitrateBps == 260_000)
        #expect(policy.resolvedPublishCamera(auto, dataSaverOn: false, systemSendCeiling: critical) == autoSerious)

        let dataSaver = policy.effectiveCamera(hd, dataSaverOn: true, systemSendCeiling: .unconstrained)
        #expect(dataSaver.resolution == .p360)
        #expect(dataSaver.frameRate == 20)
        #expect(policy.effectiveCamera(hd, dataSaverOn: false, systemSendCeiling: lowPower) == dataSaver)
        #expect(policy.effectiveCamera(hd, dataSaverOn: true, systemSendCeiling: critical) == dataSaver)
        #expect(lowPower.isActive)

        var small = auto
        small.preset = .custom
        small.resolution = .p360
        small.frameRate = 15
        small.maxBitrateKbps = 200
        let smallSerious = policy.effectiveCamera(small, dataSaverOn: false, systemSendCeiling: critical)
        #expect(smallSerious.resolution == .p360)
        #expect(smallSerious.frameRate == 15)
        #expect(smallSerious.maxBitrateKbps == 200)
    }

    @Test func twoEscalationsPostOneToastAndTwoCeilingSteps() {
        var pressure = SystemPressureState()
        #expect(pressure.ceiling == .unconstrained)

        let toSerious = pressure.applyThermalLevel(.serious, callSession: 4, isInCall: true)
        #expect(toSerious == SystemPressureChange(ceilingChanged: true, postsQualityLoweredToast: true))
        #expect(pressure.ceiling.thermalSteps == 1)

        let toCritical = pressure.applyThermalLevel(.critical, callSession: 4, isInCall: true)
        #expect(toCritical == SystemPressureChange(ceilingChanged: true, postsQualityLoweredToast: false))
        #expect(pressure.ceiling.thermalSteps == 2)
        #expect(pressure.qualityLoweredToastsPosted == 1)

        let cleared = pressure.applyThermalLevel(.fair, callSession: 4, isInCall: true)
        #expect(cleared == SystemPressureChange(ceilingChanged: true, postsQualityLoweredToast: false))
        #expect(pressure.ceiling == .unconstrained)

        #expect(pressure.applyThermalLevel(.fair, callSession: 4, isInCall: true)
            == SystemPressureChange(ceilingChanged: false, postsQualityLoweredToast: false))

        #expect(!pressure.applyThermalLevel(.serious, callSession: 4, isInCall: true).postsQualityLoweredToast)
        #expect(pressure.qualityLoweredToastsPosted == 1)

        _ = pressure.applyThermalLevel(.nominal, callSession: 4, isInCall: true)
        #expect(pressure.applyThermalLevel(.critical, callSession: 5, isInCall: true).postsQualityLoweredToast)
        #expect(pressure.qualityLoweredToastsPosted == 2)
        var home = SystemPressureState()
        let homeChange = home.applyThermalLevel(.serious, callSession: 0, isInCall: false)
        #expect(homeChange == SystemPressureChange(ceilingChanged: true, postsQualityLoweredToast: false))
        #expect(home.ceiling.thermalSteps == 1)

        #expect(!SystemPressurePolicy.postsQualityLoweredToast(previousSteps: 2, nextSteps: 1, isInCall: true,
                                                               alreadyPostedThisCall: false))
    }

    @Test func lowPowerModeAppliesTheDataSaverCeilingSilently() {
        var pressure = SystemPressureState()
        let on = pressure.applyLowPowerMode(true)
        #expect(on == SystemPressureChange(ceilingChanged: true, postsQualityLoweredToast: false))
        #expect(pressure.ceiling == NativeSystemSendCeiling(thermalSteps: 0, appliesDataSaver: true))
        #expect(pressure.applyLowPowerMode(true) == SystemPressureChange(ceilingChanged: false, postsQualityLoweredToast: false))
        #expect(pressure.applyLowPowerMode(false).ceilingChanged)
        #expect(pressure.ceiling == .unconstrained)
        #expect(pressure.qualityLoweredToastsPosted == 0)
    }

    @Test func theCeilingNeverTouchesTheSavedSettings() throws {

        let saved = NativeMediaQualityPolicy.defaultSettings
        let before = NativeMediaQualityPreferences.encode(saved)
        var pressure = SystemPressureState()
        _ = pressure.applyThermalLevel(.critical, callSession: 1, isInCall: true)
        _ = pressure.applyLowPowerMode(true)
        _ = NativeMediaQualityPolicy.resolvedPublishCamera(saved.camera, dataSaverOn: true, systemSendCeiling: pressure.ceiling)
        #expect(NativeMediaQualityPreferences.encode(saved) == before)
        #expect(saved == NativeMediaQualityPolicy.defaultSettings)
    }

}

private func sys6PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func sys6Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: sys6PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func sys6Section(_ text: String, from: String, to: String?) -> String? {
    guard let start = text.range(of: from) else { return nil }
    guard let to else { return String(text[start.lowerBound...]) }
    guard let end = text.range(of: to, range: start.upperBound..<text.endIndex) else { return nil }
    return String(text[start.lowerBound..<end.lowerBound])
}
#endif
