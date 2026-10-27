#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// SYS-6 (OUT/PLAN-screens.md section 5; S70 6, SX11 `LifecycleRefreshPolicy`, SY9, SY22, O10; S20 SC16, 10 f):
/// the pure halves of the lifecycle, recovery and system pressure rules, plus source scans of both
/// `NetworkReachabilityMonitor` sides (S70 O14: no iOS-hosted test bundle) and of the core wiring the HD requests add.
/// The `RejoinHarness` host cells (S70 6 l1, l2, l5 on the view model) are requested into
/// T/LocalToggleGuardRecoveryTests.swift (core owned; HD/requests/B6-T6.md R10), where the harness is private.
/// Tests marked "after R..." pass only once that request is applied. Not run in the heads-down push.
struct SYS6LifecycleRecoveryTests {
    // MARK: S70 6 c, 6 d: light refresh versus full recovery (SX11 kind(previous:next:))

    @Test func refreshKindFollowsTheDeepestPhaseSinceActive() {
        #expect(LifecycleRefreshPolicy.kind(previous: .inactive, next: .active) == .light)
        #expect(LifecycleRefreshPolicy.kind(previous: .background, next: .active) == .full)
        #expect(LifecycleRefreshPolicy.kind(previous: .launching, next: .active) == .full)
        #expect(LifecycleRefreshPolicy.kind(previous: .active, next: .active) == LifecycleRefreshKind.none)
        // Only a transition to active runs anything.
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
        // The first activation of the process is full (it also runs the persisted resume check).
        var tracker = LifecycleRefreshTracker()
        #expect(tracker.deepestSinceActive == .launching)
        #expect(tracker.record(.active) == .full)

        // iOS Control Center, Notification Center, a permission alert, the CallKit UI, the broadcast picker.
        #expect(tracker.record(.inactive) == LifecycleRefreshKind.none)
        #expect(!tracker.isInBackground)
        #expect(tracker.record(.active) == .light)

        // iOS Home: active, inactive, background, then inactive on the way back, then active.
        #expect(tracker.record(.inactive) == LifecycleRefreshKind.none)
        #expect(tracker.record(.background) == LifecycleRefreshKind.none)
        #expect(tracker.isInBackground)
        #expect(tracker.record(.inactive) == LifecycleRefreshKind.none)
        #expect(tracker.isInBackground)
        #expect(tracker.record(.active) == .full)
        #expect(!tracker.isInBackground)

        // Android onPause then onStop, then onStart and onResume (no inactive hop on the way back).
        #expect(tracker.record(.inactive) == LifecycleRefreshKind.none)
        #expect(tracker.record(.background) == LifecycleRefreshKind.none)
        #expect(tracker.record(.active) == .full)

        // Android onPause alone (a dialog, the shade, entering PiP), then onResume.
        #expect(tracker.record(.inactive) == LifecycleRefreshKind.none)
        #expect(tracker.record(.active) == .light)

        // A process launched straight into the background still runs full on its first return.
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

    // MARK: S70 6 c: speaker poll in the background, keyframes on return

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
        // Audio-only mode receives no remote video, so nothing is asked.
        #expect(LifecycleRefreshPolicy.keyframeProducerIds(candidates, visibleUserIds: visible, receivesVideo: false).isEmpty)
        #expect(LifecycleRefreshPolicy.keyframeProducerIds(candidates, visibleUserIds: [], receivesVideo: true).isEmpty)
        #expect(LifecycleRefreshPolicy.keyframeProducerIds([], visibleUserIds: visible, receivesVideo: true).isEmpty)
    }

    // MARK: S20 SC16, 10 f: Retry Now

    @Test func retryNowStartsOneRejoinBetweenAttempts() {
        #expect(RecoveryRetryPolicy.acceptsRetryNow(isRecovering: true, isRejoinInFlight: false, isRetryPending: false))
        #expect(!RecoveryRetryPolicy.acceptsRetryNow(isRecovering: false, isRejoinInFlight: false, isRetryPending: false))
        #expect(!RecoveryRetryPolicy.acceptsRetryNow(isRecovering: true, isRejoinInFlight: true, isRetryPending: false))
        #expect(!RecoveryRetryPolicy.acceptsRetryNow(isRecovering: true, isRejoinInFlight: false, isRetryPending: true))

        // A double tap before the rejoin task runs: the first marks the retry pending, the second is refused, and
        // the banner already reads the attempt as in flight (Retry Now disabled).
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
        // The STG-5 banner rows read the SC16 inputs the core publishes (S20 10 l reconnecting fixture).
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

    // MARK: S70 SY22, 6 d: captive portal

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

    // MARK: S70 6 c, 6 d, O10, SY22: thermal levels and publish tiers

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

        // No ceiling: the person's setting as is.
        #expect(policy.effectiveCamera(hd, dataSaverOn: false, systemSendCeiling: .unconstrained) == hd)
        #expect(policy.resolvedPublishCamera(auto, dataSaverOn: false, systemSendCeiling: .unconstrained)
            == policy.resolvedCamera(auto))
        #expect(!NativeSystemSendCeiling.unconstrained.isActive)

        // Serious: one tier below. HD sends Auto's limits, keeps its own content hint and degradation preference.
        let hdSerious = policy.effectiveCamera(hd, dataSaverOn: false, systemSendCeiling: serious)
        #expect(hdSerious.resolution == .p720)
        #expect(hdSerious.frameRate == 30)
        #expect(hdSerious.maxBitrateKbps == 1_650)
        #expect(hdSerious.contentHint == hd.contentHint)
        #expect(hdSerious.degradationPreference == hd.degradationPreference)
        #expect(hdSerious.preset == .highDefinition)
        // Critical: two tiers below.
        let hdCritical = policy.effectiveCamera(hd, dataSaverOn: false, systemSendCeiling: critical)
        #expect(hdCritical.resolution == .p360)
        #expect(hdCritical.frameRate == 20)
        #expect(hdCritical.maxBitrateKbps == 260)
        // Auto at serious goes to Data Saver; critical cannot go lower.
        let autoSerious = policy.resolvedPublishCamera(auto, dataSaverOn: false, systemSendCeiling: serious)
        #expect(autoSerious.height == 360)
        #expect(autoSerious.frameRate == 20)
        #expect(autoSerious.maxBitrateBps == 260_000)
        #expect(policy.resolvedPublishCamera(auto, dataSaverOn: false, systemSendCeiling: critical) == autoSerious)

        // Data Saver (the S60 toggle or the system signal) and Low Power Mode apply the same 360p at 20 fps ceiling;
        // the thermal steps below it change nothing more.
        let dataSaver = policy.effectiveCamera(hd, dataSaverOn: true, systemSendCeiling: .unconstrained)
        #expect(dataSaver.resolution == .p360)
        #expect(dataSaver.frameRate == 20)
        #expect(policy.effectiveCamera(hd, dataSaverOn: false, systemSendCeiling: lowPower) == dataSaver)
        #expect(policy.effectiveCamera(hd, dataSaverOn: true, systemSendCeiling: critical) == dataSaver)
        #expect(lowPower.isActive)

        // A ceiling only lowers: a custom 360p at 15 fps keeps its own frame rate and resolution.
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

    // MARK: S70 6 l5 (pure half): two escalations, one toast, two steps; clearing removes the ceiling

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

        // Fair or nominal clears the ceiling, silently.
        let cleared = pressure.applyThermalLevel(.fair, callSession: 4, isInCall: true)
        #expect(cleared == SystemPressureChange(ceilingChanged: true, postsQualityLoweredToast: false))
        #expect(pressure.ceiling == .unconstrained)
        // A repeated level changes nothing.
        #expect(pressure.applyThermalLevel(.fair, callSession: 4, isInCall: true)
            == SystemPressureChange(ceilingChanged: false, postsQualityLoweredToast: false))

        // Once per call: a later escalation in the same call (a recovery rejoin keeps the call session) is silent.
        #expect(!pressure.applyThermalLevel(.serious, callSession: 4, isInCall: true).postsQualityLoweredToast)
        #expect(pressure.qualityLoweredToastsPosted == 1)

        // A new call may post once more; outside a call nothing posts but the ceiling still applies.
        _ = pressure.applyThermalLevel(.nominal, callSession: 4, isInCall: true)
        #expect(pressure.applyThermalLevel(.critical, callSession: 5, isInCall: true).postsQualityLoweredToast)
        #expect(pressure.qualityLoweredToastsPosted == 2)
        var home = SystemPressureState()
        let homeChange = home.applyThermalLevel(.serious, callSession: 0, isInCall: false)
        #expect(homeChange == SystemPressureChange(ceilingChanged: true, postsQualityLoweredToast: false))
        #expect(home.ceiling.thermalSteps == 1)
        // De-escalation never posts.
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
        // The resolver takes the saved settings by value and returns limits; the saved value is identical afterwards.
        let saved = NativeMediaQualityPolicy.defaultSettings
        let before = NativeMediaQualityPreferences.encode(saved)
        var pressure = SystemPressureState()
        _ = pressure.applyThermalLevel(.critical, callSession: 1, isInCall: true)
        _ = pressure.applyLowPowerMode(true)
        _ = NativeMediaQualityPolicy.resolvedPublishCamera(saved.camera, dataSaverOn: true, systemSendCeiling: pressure.ceiling)
        #expect(NativeMediaQualityPreferences.encode(saved) == before)
        #expect(saved == NativeMediaQualityPolicy.defaultSettings)

        // Source rule: the ceiling code never writes `videoQuality`, persisted settings or UserDefaults.
        let source = try sys6Source("Sources/Conclave/Core/WebRTC/MediaQualitySettings.swift")
        let ceilingFunctions = try #require(sys6Section(source, from: "// MARK: Publish ceilings",
                                                        to: "static func baseVideoQuality"))
        let pressureTypes = try #require(sys6Section(source, from: "// MARK: - System pressure", to: nil))
        for section in [ceilingFunctions, pressureTypes] {
            #expect(!section.contains("videoQuality ="))
            #expect(!section.contains("updateVideoQuality"))
            #expect(!section.contains("setVideoQuality"))
            #expect(!section.contains("UserDefaults"))
            #expect(!section.contains("NativeMediaQualityPreferences"))
            #expect(!section.contains(".save("))
        }
    }

    // MARK: Monitor sources (both platforms)

    @Test func bothMonitorSidesDeclareTheSameMembersAndNoOtherType() throws {
        let swift = try sys6Source("Sources/Conclave/Core/Networking/NetworkReachabilityMonitor.swift")
        let kotlin = try sys6Source("Sources/Conclave/Skip/NetworkReachabilityMonitor.kt")
        let callbacks = ["onStatusChanged", "onQualityHintChanged", "onCaptivePortalChanged", "onThermalLevelChanged",
                         "onLowPowerModeChanged"]
        for name in callbacks {
            #expect(swift.contains("    var \(name): (("))
            #expect(kotlin.contains("    internal var \(name): (("))
        }
        #expect(swift.contains("var onThermalLevelChanged: ((SystemThermalLevel) -> Void)?"))
        #expect(kotlin.contains("internal var onThermalLevelChanged: ((SystemThermalLevel) -> Unit)? = null"))
        #expect(swift.contains("    func start() {") && swift.contains("    func stop() {"))
        #expect(kotlin.contains("    internal fun start() {") && kotlin.contains("    internal fun stop() {"))
        // The Kotlin file hides every type the Swift file declares, so the Swift file declares only the monitor.
        let declarations = ["\nenum ", "\nstruct ", "\nclass ", "\nprotocol ", "\nextension ", "\nfinal class "]
        var count = 0
        for keyword in declarations {
            count += swift.components(separatedBy: keyword).count - 1
        }
        #expect(count == 1)
        #expect(swift.contains("\nfinal class NetworkReachabilityMonitor {"))
    }

    @Test func iosMonitorObservesThermalStateAndLowPowerModeOnIOSOnly() throws {
        let swift = try sys6Source("Sources/Conclave/Core/Networking/NetworkReachabilityMonitor.swift")
        let observers = try #require(sys6Section(swift, from: "private func startSystemPressureObservers()",
                                                 to: "private func stopSystemPressureObservers()"))
        #expect(observers.contains("#if os(iOS) && !SKIP"))
        // NSProcessInfo.h: the thermal notification arrives only after the property was read once.
        let read = try #require(observers.range(of: "_ = ProcessInfo.processInfo.thermalState"))
        let observe = try #require(observers.range(of: "ProcessInfo.thermalStateDidChangeNotification"))
        #expect(read.lowerBound < observe.lowerBound)
        #expect(observers.contains(".NSProcessInfoPowerStateDidChange"))
        #expect(swift.contains("ProcessInfo.processInfo.isLowPowerModeEnabled"))
        #expect(swift.contains("center.removeObserver(thermalObserver)"))
        // iOS has no captive-portal signal: the iOS side never reports one.
        #expect(!swift.contains("onCaptivePortalChanged?("))
    }

    @Test func androidMonitorRegistersThermalOnApi29PlusAndReadsTheCaptivePortalCapability() throws {
        let kotlin = try sys6Source("Sources/Conclave/Skip/NetworkReachabilityMonitor.kt")
        // S70 6 d, O10: API 28 registers no thermal listener (no adaptation, no toast).
        #expect(kotlin.contains("if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && thermalListener == null) {\n            registerThermalListener(power)"))
        let register = try #require(sys6Section(kotlin, from: "@RequiresApi(Build.VERSION_CODES.Q)\n    private fun registerThermalListener",
                                                to: "private fun stopSystemPressureListeners()"))
        #expect(register.contains("power.addThermalStatusListener("))
        #expect(register.contains("SystemThermalLevel.fromAndroidThermalStatus(power.currentThermalStatus)"))
        #expect(kotlin.components(separatedBy: "addThermalStatusListener(").count - 1 == 1)
        #expect(kotlin.contains("power.removeThermalStatusListener(listener)"))
        #expect(kotlin.contains("private var thermalListener: Any? = null"))
        // Battery saver on every level.
        #expect(kotlin.contains("IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)"))
        #expect(kotlin.contains("ContextCompat.RECEIVER_NOT_EXPORTED"))
        #expect(kotlin.contains("publishLowPowerMode(power.isPowerSaveMode)"))
        #expect(kotlin.contains("appContext.unregisterReceiver(receiver)"))
        // SY22: the captive-portal flag through the shared rule, published only on change.
        #expect(kotlin.contains("NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL"))
        #expect(kotlin.contains("NetworkCaptivePortalPolicy.isCaptivePortal("))
        #expect(kotlin.contains("if (lastCaptivePortal == isCaptivePortal) return"))
        #expect(kotlin.components(separatedBy: "publishCaptivePortal(isCaptivePortal)").count - 1 == 2)
        // Unchanged reachability rules (ConclaveTests pins the bandwidth policy too).
        #expect(kotlin.contains("AndroidNetworkReachabilityQualityPolicy.bandwidthQuality"))
    }

    @Test func ownedSourcesStayDashFreeAndFlat() throws {
        let paths = [
            "Sources/Conclave/Core/Call/LifecycleRefreshPolicy.swift",
            "Sources/Conclave/Core/WebRTC/MediaQualitySettings.swift",
            "Sources/Conclave/Core/Networking/NetworkReachabilityMonitor.swift",
            "Sources/Conclave/Skip/NetworkReachabilityMonitor.kt",
            "Tests/ConclaveTests/SYS6LifecycleRecoveryTests.swift",
        ]
        // Built from parts so this file does not match itself.
        let banned = "gra" + "dient"
        for path in paths {
            let text = try sys6Source(path)
            #expect(!text.contains("\u{2014}"), "\(path) has an em dash")
            #expect(!text.contains("\u{2013}"), "\(path) has an en dash")
            #expect(!text.lowercased().contains(banned), "\(path) breaks the flat design rule")
        }
        // The shared policy file stays transpile-safe: no platform import, no tuple return, no function-reference map.
        let policy = try sys6Source("Sources/Conclave/Core/Call/LifecycleRefreshPolicy.swift")
        #expect(!policy.contains("import UIKit") && !policy.contains("import SwiftUI") && !policy.contains("#if"))
        #expect(!policy.contains(".map(") && !policy.contains("compactMap"))
    }

    // MARK: Core wiring (after R1 to R7 in HD/requests/B6-T6.md)

    @Test func coreWiresTheLifecycleRecoveryAndPressureInputs() throws {
        let vm = try sys6Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        // R2: light versus full.
        #expect(vm.contains("func handleAppResignedActive()"))
        #expect(vm.contains("let refresh = lifecycleRefreshTracker.record(.active)"))
        #expect(vm.contains("lifecycleRefreshTracker.record(.background)"))
        #expect(vm.contains("lifecycleRefreshTracker.record(.inactive)"))
        let active = try #require(sys6Section(vm, from: "    func handleAppBecameActive() {", to: "    func handleAppEnteredBackground() {"))
        let light = try #require(active.range(of: "guard refresh == .full else"))
        let presence = try #require(active.range(of: "activateCallPresence()"))
        #expect(light.lowerBound < presence.lowerBound)
        #expect(active.contains("lifecycleRefreshCounters.recordKeyframeRequests("))
        #expect(vm.contains("requestKeyFrame: true"))
        // R3: the speaker poll.
        #expect(vm.contains("LifecycleRefreshPolicy.samplesActiveSpeaker("))
        // R4: Retry Now and the watchdog on a forced rejoin.
        #expect(vm.contains("RecoveryRetryPolicy.acceptsRetryNow("))
        #expect(vm.contains("isRecoveryAttemptInFlight: RecoveryRetryPolicy.isAttemptInFlight("))
        let force = try #require(sys6Section(vm, from: "    func forceRejoinWithFreshToken() async {",
                                             to: "    func recoverActiveMeetingFromForeground() async {"))
        #expect(force.contains("startRecoveryWatchdogIfNeeded()"))
        #expect(!force.contains("reconnectAttempts"))
        // R5: captive portal and pressure.
        #expect(vm.contains("networkMonitor.onCaptivePortalChanged"))
        #expect(vm.contains("isCaptivePortal: state.isCaptivePortal"))
        #expect(vm.contains("networkMonitor.onThermalLevelChanged"))
        #expect(vm.contains("networkMonitor.onLowPowerModeChanged"))
        #expect(vm.contains("StageEvent.make(kind: StageEventKind.qualityLowered)"))
        let apply = try #require(sys6Section(vm, from: "    private func applyMediaPublishConfiguration() {",
                                             to: "    func handleSystemThermalLevel("))
        #expect(apply.contains("NativeMediaQualityPolicy.resolvedPublishCamera("))
        #expect(apply.contains("webRTCClient.updateMediaPublishConfiguration("))
        #expect(!apply.contains("videoQuality"))
        #expect(!apply.contains(".save("))
        // R7: the delegate reports the inactive hop.
        let app = try sys6Source("Sources/Conclave/ConclaveApp.swift")
        #expect(app.contains("MeetingViewModel.shared.handleAppResignedActive()"))
        // R1: the captive flag is a stage input.
        let state = try sys6Source("Sources/Conclave/Core/State/MeetingState.swift")
        #expect(state.contains("var isCaptivePortal: Bool = false"))
    }
}

private func sys6PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func sys6Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: sys6PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

/// The text from the first `from` marker up to the next `to` marker after it (or the end when `to` is nil).
private func sys6Section(_ text: String, from: String, to: String?) -> String? {
    guard let start = text.range(of: from) else { return nil }
    guard let to else { return String(text[start.lowerBound...]) }
    guard let end = text.range(of: to, range: start.upperBound..<text.endIndex) else { return nil }
    return String(text[start.lowerBound..<end.lowerBound])
}
#endif
