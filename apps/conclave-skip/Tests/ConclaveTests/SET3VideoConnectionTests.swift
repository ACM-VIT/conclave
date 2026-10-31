#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct SET3VideoConnectionTests {

    @Test func videoRowsFollowTheScopeAndTheScreenShareCapability() {
        let (call, _) = Self.make(.video)
        #expect(call.sections.first { $0.section == .video }?.rows == [.cameraFacing, .mirror, .cameraQuality, .screenShareQuality, .dataSaver])
        let (guest, _) = Self.make(.guest)
        #expect(guest.sections.first { $0.section == .video }?.rows == [.cameraFacing, .mirror, .cameraQuality, .dataSaver])
        let app = SettingsPresenter(scope: .app, platform: .ios, defaults: Self.freshDefaults())
        #expect(app.sections.first { $0.section == .video }?.rows == [.mirror, .cameraQuality, .dataSaver])
        let (attendee, _) = Self.make(.attendee)

        #expect(attendee.sections.first { $0.section == .video }?.rows == [.dataSaver])
        #expect(!SettingsRowPolicy.rows(call.sections).contains(.effects))
    }

    @Test func set3RoutesAreAvailableAndAdvancedPagesPairWithTheirQualityPages() {
        for route in [SettingsRoute.cameraQuality, .cameraAdvanced, .screenShareQuality, .screenShareAdvanced, .connection] {
            #expect(SettingsRoutePolicy.isAvailable(route, canUsePersonalVoice: false), "\(route)")
        }
        #expect(SettingsRoutePolicy.advancedRoute(for: .cameraQuality) == .cameraAdvanced)
        #expect(SettingsRoutePolicy.advancedRoute(for: .screenShareQuality) == .screenShareAdvanced)
        #expect(SettingsRoutePolicy.advancedRoute(for: .connection) == nil)
    }

    @Test func videoStoresUseTheirKeysAndDefaults() {
        #expect(NativeVideoPreferences.mirrorSelfViewKey == "conclave.pref.mirrorSelfView")
        #expect(NativeVideoPreferences.dataSaverKey == "conclave.pref.dataSaver")
        #expect(NativeVideoPreferences.shareDeviceAudioKey == "conclave.pref.shareDeviceAudio")
        #expect(NativeMediaQualityPreferences.storageKey == "conclave:media-quality-settings:v1")
        let defaults = Self.freshDefaults()
        #expect(NativeVideoPreferences.mirrorsSelfView(defaults: defaults))
        #expect(!NativeVideoPreferences.dataSaver(defaults: defaults))
        #expect(!NativeVideoPreferences.shareDeviceAudio(defaults: defaults))
        #expect(NativeMediaQualityPreferences.load(defaults: defaults) == NativeMediaQualityPolicy.defaultSettings)
    }

    @Test func anAppScopeVideoChangeReadsTheSameInTheNextCall() {
        let defaults = Self.freshDefaults()
        let app = SettingsPresenter(scope: .app, platform: .ios, defaults: defaults)
        app.setDataSaver(true)
        app.setMirrorsSelfView(false)
        let (call, _) = Self.make(.video, defaults: defaults)
        #expect(call.video.dataSaverOn && !call.video.mirrorsSelfView)
        app.setDataSaver(false)
        app.setMirrorsSelfView(true)
    }

    @Test func aPresetIsPersistedAndRecordsOneCeilingWithItsValue() {
        let defaults = Self.freshDefaults()
        let (presenter, core) = Self.make(.video, defaults: defaults)
        #expect(presenter.video.presets == ["auto", "high-definition", "studio", "custom"])
        #expect(presenter.video.cameraPreset == "auto")
        #expect(presenter.setCameraPreset("high-definition") == .dispatched)
        #expect(presenter.setCameraPreset("high-definition") == .ignored)
        #expect(core.count("setPublishCeiling") == 1)
        let ceiling = core.lastPublishCeiling
        #expect(ceiling?.width == 1920 && ceiling?.height == 1080 && ceiling?.frameRate == 30 && ceiling?.maxBitrateBps == 3_000_000)
        #expect(NativeMediaQualityPreferences.load(defaults: defaults).camera.preset == .highDefinition)
        #expect(presenter.video.cameraPreset == "high-definition" && presenter.video.effectiveCameraPreset == "high-definition")

        #expect(presenter.setCameraPreset("data-saver") == .ignored)
    }

    @Test func dataSaverDisablesThePickerAndAppliesThe360pCeiling() {
        let (presenter, core) = Self.make(.video)
        presenter.setDataSaver(true)
        #expect(presenter.video.dataSaverOn && presenter.video.effectiveCameraPreset == "data-saver")
        #expect(core.count("setPublishCeiling") == 1)
        #expect(core.lastPublishCeiling?.height == 360 && core.lastPublishCeiling?.frameRate == 20)
        #expect(presenter.setCameraPreset("studio") == .ignored)
        presenter.setDataSaver(false)
        #expect(!presenter.video.dataSaverOn && presenter.publishCeiling().height == 720)
    }

    @Test func theHostLimitMapsToTheDataSaverCeilingWithItsReason() {
        let (presenter, _) = Self.make(.hostQualityCap)
        #expect(presenter.video.qualityCappedByHost && presenter.video.effectiveCameraPreset == "data-saver")
        #expect(presenter.publishCeiling().height == 360)
        #expect(!presenter.video.dataSaverOn)
    }

    @Test func advancedChangesMakeThePresetCustomAndListOnlyWhatTheCameraSupports() {
        let defaults = Self.freshDefaults()
        let presenter = SettingsPresenter(scope: .call, platform: .ios, defaults: defaults)
        let core = SettingsRecordingCore()
        core.install(on: presenter)
        presenter.apply(SettingsInputs.make(callSession: 1, roomId: "fixture-room", isJoined: true, isMuted: false, hasCore: true,
                                            cameraMaxHeight: 720, cameraMaxFrameRate: 30))
        #expect(presenter.video.presets == ["auto", "custom"])
        #expect(presenter.video.custom.resolutions == ["360p", "720p"])
        #expect(presenter.video.custom.frameRates == [15, 20, 24, 30])
        presenter.setCameraResolution("2160p")
        #expect(presenter.video.custom.resolution == "720p")
        presenter.setCameraResolution("360p")
        #expect(presenter.video.cameraPreset == "custom" && presenter.video.custom.resolution == "360p")
        presenter.setCameraBitrate(1_234)
        #expect(presenter.video.custom.bitrateKbps == 1_250)
        presenter.restoreRecommendedQuality()
        #expect(presenter.video.cameraPreset == "auto")
        #expect(NativeMediaQualityPreferences.load(defaults: defaults).camera == NativeMediaQualityPolicy.defaultSettings.camera)
    }

    @Test func screenSharePresetsPersistAndShareDeviceAudioNeedsTheCapability() {
        let defaults = Self.freshDefaults()
        let (presenter, core) = Self.make(.video, defaults: defaults)
        #expect(presenter.video.showsScreenShareQuality)
        #expect(presenter.setScreenSharePreset("presentation") == .dispatched)
        #expect(NativeMediaQualityPreferences.load(defaults: defaults).screenShare.preset == .presentation)
        #expect(core.count("setPublishCeiling") == 0)
        presenter.setScreenShareFrameRate(30)
        #expect(presenter.video.screenSharePreset == "custom")

        #expect(!presenter.video.canShareDeviceAudio)
        presenter.setShareDeviceAudio(true)
        #expect(!NativeVideoPreferences.shareDeviceAudio(defaults: defaults))
        presenter.apply(SettingsInputs.make(callSession: 1, roomId: "fixture-room", isJoined: true, isMuted: false, hasCore: true,
                                            isScreenShareSupported: true, canShareDeviceAudio: true))
        presenter.setShareDeviceAudio(true)
        #expect(presenter.video.shareDeviceAudioOn && NativeVideoPreferences.shareDeviceAudio(defaults: defaults))
    }

    @Test func qualityOptionsMatchTheSpec() {
        #expect(NativeQualityOptions.cameraPresets(capability: .unknown) == [.auto, .highDefinition, .studio, .custom])
        #expect(NativeQualityOptions.cameraPresets(capability: CameraCaptureCapability(maxHeight: 1080, maxFrameRate: 30))
                == [.auto, .highDefinition, .custom])
        #expect(NativeQualityOptions.cameraSelection(.dataSaver) == .auto)
        #expect(NativeQualityOptions.screenSharePresets == [.auto, .presentation, .motion, .custom])
        #expect(NativeQualityOptions.snappedBitrate(10, minimum: 150, maximum: 6_000, step: 50) == 150)
        #expect(NativeQualityOptions.snappedBitrate(99_999, minimum: 150, maximum: 6_000, step: 50) == 6_000)
        #expect(NativeQualityOptions.snappedBitrate(1_274, minimum: 150, maximum: 6_000, step: 50) == 1_250)
    }

    @Test func theSystemSignalHoldsDataSaverOnAndDisabled() {
        let defaults = Self.freshDefaults()
        let (presenter, core) = Self.make(.systemDataSaver, defaults: defaults)
        #expect(presenter.video.dataSaverOn && presenter.video.systemDataSaverOn)
        presenter.setDataSaver(false)
        #expect(presenter.video.dataSaverOn)
        #expect(core.count("preferenceChanged") == 0)
        #expect(!NativeVideoPreferences.dataSaver(defaults: defaults))
        #expect(DataSaverPolicy.isOn(preference: false, systemDataSaver: true))
        #expect(!DataSaverPolicy.isOn(preference: false, systemDataSaver: false))
    }

    @Test func dataSaverComposesWithTheTransientSystemCeilingAndLowersReceive() {
        let studio = NativeMediaQualityPolicy.cameraPreset(.studio, current: NativeMediaQualityPolicy.defaultSettings.camera)
        let hot = NativeSystemSendCeiling(thermalSteps: 1, appliesDataSaver: false)
        let thermalOnly = NativeMediaQualityPolicy.resolvedPublishCamera(studio, dataSaverOn: false, systemSendCeiling: hot)
        #expect(thermalOnly.height == 1080 && thermalOnly.frameRate == 30)
        let both = NativeMediaQualityPolicy.resolvedPublishCamera(studio, dataSaverOn: true, systemSendCeiling: hot)
        #expect(both.height == 360 && both.frameRate == 20)
        #expect(DataSaverPolicy.appliesPublishCeiling(dataSaverOn: false, qualityCappedByHost: true))
        #expect(DataSaverPolicy.reducesReceive(isLowQuality: false, dataSaverOn: true))
        #expect(!DataSaverPolicy.reducesReceive(isLowQuality: false, dataSaverOn: false))
    }

    @Test func onlyTheFrontCameraMirrorsAndTheSentStreamNever() {
        #expect(LocalVideoMirrorPolicy.mirrors(isFront: true, preference: true))
        #expect(!LocalVideoMirrorPolicy.mirrors(isFront: true, preference: false))
        #expect(!LocalVideoMirrorPolicy.mirrors(isFront: false, preference: true))
        #expect(!LocalVideoMirrorPolicy.mirrorsSentStream)
    }

    @Test func theMirrorSwitchReachesTheStoreTheRenderersAndThePreviewOwner() {
        let defaults = Self.freshDefaults()
        let (presenter, core) = Self.make(.video, defaults: defaults)
        presenter.panelDidOpen()
        #expect(core.count("mirrorOn") == 1)
        presenter.setMirrorsSelfView(false)
        presenter.setMirrorsSelfView(false)
        #expect(!NativeVideoPreferences.mirrorsSelfView(defaults: defaults))
        #expect(!LocalVideoMirrorPreference.shared.isOn)
        #expect(core.count("mirrorOff") == 1)
        #expect(presenter.dispatchedKinds.filter { $0 == SettingsCommandKind.preferenceChanged.rawValue }.count == 1)
        presenter.setMirrorsSelfView(true)
        #expect(LocalVideoMirrorPreference.shared.isOn)
        presenter.panelDidClose()
    }

    @Test func thePreviewIsLocalOnlyAndStopsOnceWhenThePanelCloses() {
        let (presenter, core) = Self.make(.video)
        presenter.panelDidOpen()
        #expect(presenter.video.preview == .off && presenter.video.canStartPreview)
        presenter.startPreview()
        #expect(core.count("previewStart") == 1)
        #expect(presenter.video.preview == .live && !presenter.video.canStartPreview)

        #expect(core.count("producerCreate") == 0)
        presenter.panelDidClose()
        #expect(core.count("previewStop") == 1)
        #expect(presenter.video.preview == .off)
        presenter.panelDidClose()
        #expect(core.count("previewStop") == 1)
    }

    @Test func theMeetingCameraTakesOverAndTheCardShowsTheSentTrack() {
        let (presenter, core) = Self.make(.video)
        presenter.panelDidOpen()
        presenter.startPreview()
        core.scriptCallCameraTookOver()
        presenter.apply(SettingsFixtureState.cameraOn.inputs())
        #expect(presenter.video.preview == .published)
        #expect(!presenter.video.canStartPreview)
        let (cameraOn, onCore) = Self.make(.cameraOn)
        cameraOn.panelDidOpen()
        cameraOn.startPreview()
        #expect(onCore.count("previewStart") == 0)
        #expect(SettingsCopyContract.previewStatusIsPublished(cameraOn.video.preview))
    }

    @Test func theInterruptionFixtureShowsCameraPausedAndBlocksStartUntilItEnds() {
        let (presenter, core) = Self.make(.video)
        presenter.panelDidOpen()
        presenter.startPreview()
        core.scriptPreview(state: .interrupted, interruption: .multipleForegroundApps)
        #expect(presenter.video.preview == .interrupted && presenter.video.previewReason == .cameraMultitasking)
        #expect(!presenter.video.canStartPreview)
        core.scriptPreview(state: .live)
        #expect(presenter.video.preview == .live && presenter.video.previewReason == SettingsReason.none)
        presenter.panelDidClose()
    }

    @Test func thirtySecondsOffScreenStopsThePreviewOnce() async {
        let (presenter, core) = Self.make(.video)
        presenter.panelDidOpen()
        presenter.previewCardVisible(true)
        presenter.startPreview()
        presenter.previewCardVisible(false)
        for _ in 0..<20 { await Task.yield() }
        #expect(core.count("previewStop") == 1)

        presenter.startPreview()
        presenter.previewCardVisible(false)
        presenter.previewCardVisible(true)
        for _ in 0..<20 { await Task.yield() }
        #expect(core.count("previewStop") == 1)
        presenter.previewSceneBackgrounded()
        #expect(core.count("previewStop") == 2)
    }

    @Test func aDeniedCameraShowsBlockedWithOpenSettingsAndStartsNothing() {
        let (presenter, core) = Self.make(.video)
        core.scriptedCameraPermission = .denied
        presenter.panelDidOpen()
        presenter.startPreview()
        #expect(presenter.video.preview == .blocked && presenter.video.previewReason == .permissionDenied)
        #expect(core.count("previewStart") == 0)
        presenter.openCameraSettings()
        #expect(core.count("openSystemSettings") == 1)
    }

    @Test func audioOnlyKeepsTheCardOffWithItsReason() {
        let (presenter, _) = Self.make(.audioOnly)
        #expect(presenter.video.preview == .off && presenter.video.previewReason == .audioOnly)
        #expect(!presenter.video.canStartPreview)
    }

    @Test func previewPolicyStatesAndReasons() {
        let live = SettingsPreviewReading(state: .live, sessionId: 2, interruption: .none, isScoped: true)
        #expect(SettingsPreviewPolicy.state(isParticipantInCall: true, isAudioOnly: false, isCameraOn: true, reading: live,
                                            permissionBlocked: false) == .published)
        #expect(SettingsPreviewPolicy.state(isParticipantInCall: false, isAudioOnly: false, isCameraOn: false, reading: live,
                                            permissionBlocked: false) == .off)
        #expect(SettingsPreviewPolicy.state(isParticipantInCall: true, isAudioOnly: false, isCameraOn: false, reading: .off,
                                            permissionBlocked: true) == .blocked)
        #expect(SettingsPreviewPolicy.reason(state: .interrupted, interruption: .background, isAudioOnly: false) == .cameraInBackground)
        #expect(SettingsPreviewPolicy.reason(state: .interrupted, interruption: .inUseByAnotherClient, isAudioOnly: false) == .cameraInUse)
        #expect(SettingsPreviewPolicy.canStart(state: .unavailable, isParticipantInCall: true, isAudioOnly: false))
        #expect(!SettingsPreviewPolicy.canStart(state: .interrupted, isParticipantInCall: true, isAudioOnly: false))
        #expect(SettingsPreviewPolicy.canStop(state: .interrupted) && !SettingsPreviewPolicy.canStop(state: .published))
        #expect(SettingsPreviewPolicy.offScreenStopMillis == 30_000)
    }

    @Test func statsPollAt1HzOnlyWhileSubscribed() async {
        let model = ConnectionStatsModel()
        model.sleep = { _ in await Task.yield() }
        var timestamp = 0.0
        model.source = {
            timestamp += 1000
            return Self.counters(timestamp: timestamp, bytesSent: timestamp * 10)
        }
        for _ in 0..<5 { await Task.yield() }
        #expect(model.pollCount == 0)
        model.subscribe()
        for _ in 0..<10 { await Task.yield() }
        #expect(model.pollCount > 1)
        #expect(model.values.uploadKbps == 80)
        model.unsubscribe()
        let stopped = model.pollCount
        for _ in 0..<10 { await Task.yield() }
        #expect(model.pollCount == stopped)
        #expect(!model.isSubscribed)
    }

    @Test func statsFreezeWhileRecovering() async {
        let (presenter, core) = Self.make(.video)
        presenter.stats.sleep = { _ in await Task.yield() }
        core.scriptedStats = Self.counters(timestamp: 1000, bytesSent: 0)
        presenter.apply(SettingsFixtureState.recovering.inputs())
        #expect(presenter.stats.isFrozen)
        presenter.stats.subscribe()
        for _ in 0..<10 { await Task.yield() }
        #expect(presenter.stats.pollCount == 0)
        presenter.stats.unsubscribe()
    }

    @Test func statsPolicyWindowsRatesLossAndCodec() {
        let first = Self.counters(timestamp: 1000, bytesSent: 10_000)
        let second = ConnectionStatsCounters(timestampMillis: 2000, rttMillis: 84.6, jitterMillis: 12.4, packetsLost: 5,
                                             packetsReceived: 195, remoteLossFraction: 0.01, videoBytesSent: 125_000,
                                             audioBytesSent: 4_000, bytesSent: 135_000, bytesReceived: 250_000, videoCodec: "VP8")
        let values = ConnectionStatsPolicy.values(current: second, previous: first)
        #expect(values.latencyMillis == 85 && values.jitterMillis == 12)
        #expect(values.uploadKbps == 1_000)
        #expect(values.videoCodec == "VP8")
        #expect(values.packetLossPercent != nil)
        let firstOnly = ConnectionStatsPolicy.values(current: first, previous: nil)
        #expect(firstOnly.uploadKbps == nil && firstOnly.downloadKbps == nil)
        #expect(ConnectionStatsPolicy.rateKbps(current: 1000, previous: 2000, elapsedMillis: 1000) == nil)
        #expect(ConnectionStatsPolicy.windowedLossPercent(lost: 10, received: 90, previousLost: 0, previousReceived: 0) == 10)
        #expect(ConnectionStatsPolicy.codecName(mimeType: "video/H264") == "H264")
        #expect(ConnectionStatsPolicy.intervalMillis == 1000)
    }

    @Test func everySET3IOSKeyIsInTheCatalogAndEveryAndroidNameResolves() throws {
        let catalog = try SettingsTranscriptPoliciesTests.catalogKeys()
        let names = try SettingsTranscriptPoliciesTests.androidStringNames()
        for file in Self.iosFiles {
            for key in SettingsTranscriptPoliciesTests.catalogKeysUsed(in: try Self.source(file)) {
                #expect(catalog.contains(key), "\(file): missing catalog key \(key)")
            }
        }
        for file in Self.kotlinFiles {
            let text = try Self.source(file)
            for name in SettingsTranscriptPoliciesTests.matches(#""((?:set|sys|stg|ds)_[a-z0-9_]+)""#, in: text) {
                #expect(names.contains(name), "\(file): missing resource \(name)")
            }
        }
    }

    @Test func set3SourcesFollowThePlatformRules() throws {
        for file in Self.sharedFiles {
            let text = try Self.source(file)
            #expect(SettingsTranscriptPoliciesTests.matches(#"\.(?:compactMap|map)\([A-Za-z.]+\)"#, in: text).isEmpty, "\(file)")
        }
    }

    @Test func theCeilingSectionsStayFreeOfStoresSoTheSystemPressureRulesHold() throws {
    }

    static let sharedFiles = [
        "Sources/Conclave/Features/Meeting/Settings/SettingsPresenter.swift",
        "Sources/Conclave/Features/Meeting/Settings/SettingsRoute.swift",
        "Sources/Conclave/Core/WebRTC/ConnectionStatsModel.swift",
        "Sources/Conclave/Core/WebRTC/MediaQualitySettings.swift",
    ]
    static let iosFiles = [
        "Sources/Conclave/Features/Meeting/Settings/SettingsPanel+iOS.swift",
        "Sources/Conclave/Features/Meeting/Settings/SettingsCopy+iOS.swift",
        "Sources/Conclave/Features/Meeting/Settings/LivePreviewCard+iOS.swift",
        "Sources/Conclave/Features/Meeting/Settings/VideoPages+iOS.swift",
    ]
    static let kotlinFiles = [
        "Sources/Conclave/Skip/ui/settings/SettingsRows.kt",
        "Sources/Conclave/Skip/ui/settings/SettingsNavHost.kt",
        "Sources/Conclave/Skip/ui/settings/SettingsPanel.kt",
        "Sources/Conclave/Skip/ui/settings/LivePreviewCard.kt",
        "Sources/Conclave/Skip/ui/settings/VideoPages.kt",
        "Sources/Conclave/Skip/ui/copy/SettingsCopy.kt",
    ]

    static func make(_ state: SettingsFixtureState, defaults: UserDefaults = SET3VideoConnectionTests.freshDefaults())
        -> (SettingsPresenter, SettingsRecordingCore) {
        let presenter = SettingsPresenter(scope: .call, platform: .ios, defaults: defaults)
        presenter.sleep = { _ in }
        let core = SettingsRecordingCore()
        core.install(on: presenter)
        presenter.apply(state.inputs())
        return (presenter, core)
    }

    static func counters(timestamp: Double, bytesSent: Double) -> ConnectionStatsCounters {
        ConnectionStatsCounters(timestampMillis: timestamp, rttMillis: 40, jitterMillis: 5, packetsLost: 0, packetsReceived: 100,
                                remoteLossFraction: nil, videoBytesSent: nil, audioBytesSent: nil, bytesSent: bytesSent,
                                bytesReceived: nil, videoCodec: "")
    }

    nonisolated static func freshDefaults() -> UserDefaults {
        let suite = "set3-video-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite) ?? UserDefaults.standard
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    static func source(_ path: String) throws -> String {
        try SettingsTranscriptPoliciesTests.source(path)
    }

    static func section(_ text: String, from start: String, to end: String?) -> String? {
        guard let lower = text.range(of: start) else { return nil }
        guard let end else { return String(text[lower.lowerBound...]) }
        guard let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else { return nil }
        return String(text[lower.lowerBound..<upper.lowerBound])
    }
}

enum SettingsCopyContract {
    static func previewStatusIsPublished(_ state: PreviewState) -> Bool {
        state == .published
    }
}
#endif
