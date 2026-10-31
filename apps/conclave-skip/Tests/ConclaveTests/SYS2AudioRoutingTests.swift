#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct SYS2AudioRoutingTests {

    private final class Clock {
        var now: Double = 1_000_000
    }

    @MainActor
    private final class FakeBackend {
        var applied: [String] = []
        var adopted: [String] = []
        var inputs: [String] = []
        var bluetoothRequests = 0
        var refreshes = 0
        var accepts = true
        var refreshState: AudioRoutePlatformState? = nil
        weak var owner: AudioRouteOwner?

        func make(for owner: AudioRouteOwner) -> AudioRouteBackend {
            self.owner = owner
            return AudioRouteBackend(
                applyOutput: { id in
                    self.applied.append(id)
                    return self.accepts
                },
                adoptOutput: { id in
                    self.adopted.append(id)
                },
                applyInput: { id in
                    self.inputs.append(id)
                    return true
                },
                requestBluetoothAccess: {
                    self.bluetoothRequests += 1
                },
                refresh: {
                    self.refreshes += 1
                    if let state = self.refreshState {
                        self.owner?.publish(state)
                    }
                }
            )
        }
    }

    private let receiver = AudioRouteOption(id: "receiver", kind: .receiver, name: "iPhone", isConnecting: false)
    private let speaker = AudioRouteOption(id: "speaker", kind: .speaker, name: "Speaker", isConnecting: false)
    private let airPods = AudioRouteOption(id: "bt-1", kind: .bluetooth, name: "AirPods Pro", isConnecting: false)

    private func state(_ options: [AudioRouteOption], current: String, defaultId: String = "") -> AudioRoutePlatformState {
        AudioRoutePlatformState.make(options: options, currentId: current, defaultId: defaultId, canToggleSpeaker: true)
    }

    private func makeOwner(_ clock: Clock, _ backend: FakeBackend) -> AudioRouteOwner {
        let owner = AudioRouteOwner()
        owner.nowMillis = { clock.now }
        owner.backend = backend.make(for: owner)
        return owner
    }

    private func intent(_ id: String, present: String, was: Bool) -> AudioRouteIntentState {
        AudioRouteIntentState(routeId: id, presentId: present, wasPresent: was)
    }

    private func route(_ previous: String, _ current: String, _ defaultId: String) -> AudioRouteState {
        AudioRouteState(previousId: previous, currentId: current, defaultId: defaultId)
    }

    @Test func mayActivateOnlyWhileNoCallKitCallOwnsTheSession() {
        for status in CallSurfaceStatus.allCases {
            let expected = !(status == .active || status == .starting)
            #expect(AudioActivationPolicy.mayActivate(surface: .callKit, status: status) == expected, "\(status)")
            for surface in [CallSystemSurfaceKind.none, .androidNotification, .androidTelecom] {
                #expect(AudioActivationPolicy.mayActivate(surface: surface, status: status), "\(surface) \(status)")
            }
        }
    }

    @Test func scriptedCallUnderCallKitMakesZeroSelfActivations() {

        let recorder = AudioActivationRecorder()
        recorder.setSurface(.callKit, status: .starting)
        recorder.request(.webRTCConfigure)
        recorder.setSurface(.callKit, status: .active)
        recorder.callKitDidActivate()
        for site in [AudioActivationSite.callBegin, .webRTCConfigure, .foreground, .background, .routeChange, .interruptionEnded, .webRTCConfigure] {
            recorder.request(site)
        }
        #expect(recorder.selfActivations == 0)
        #expect(!recorder.steps.contains(.setActive))
        #expect(AudioActivationPolicy.steps(site: .background, surface: .callKit, status: .active).isEmpty)
        #expect(AudioActivationPolicy.steps(site: .foreground, surface: .callKit, status: .active) == [.setCategory, .applyRoute])
    }

    @Test func refusedFallbackActivatesEachSiteAndEnablesWebRTCAudioRightAfter() {
        let sites = [AudioActivationSite.surfaceRefused, .callBegin, .webRTCConfigure, .foreground, .background, .routeChange]
        let recorder = AudioActivationRecorder()
        recorder.setSurface(.callKit, status: .refused)
        for site in sites {
            recorder.request(site)
        }
        #expect(recorder.selfActivations == sites.count)
        #expect(AudioActivationPolicy.everyActivationEnablesWebRTCAudio(recorder.steps))

        #expect(AudioActivationPolicy.steps(site: .callBegin, surface: .none, status: .inactive)
            == [.setCategory, .setActive, .enableWebRTCAudio, .applyRoute])
    }

    @Test func callKitActivationTellsWebRTCBeforeEnablingAudio() {
        let steps = AudioActivationPolicy.callKitDidActivateSteps()
        let notify = steps.firstIndex(of: .notifyWebRTCActivated)
        let enable = steps.firstIndex(of: .enableWebRTCAudio)
        #expect(notify != nil && enable != nil)
        #expect((notify ?? 99) < (enable ?? -1))
        #expect(!steps.contains(.setActive))
        #expect(AudioActivationPolicy.callKitDidDeactivateSteps() == [.disableWebRTCAudio, .notifyWebRTCDeactivated])
        #expect(AudioActivationPolicy.endSteps() == [.disableWebRTCAudio, .setInactive])
    }

    @Test func activationOnlyPlanCarriesNoCategoryOrRoute() {
        #expect(AudioActivationPolicy.activationSteps(site: .webRTCConfigure, surface: .callKit, status: .active).isEmpty)
        #expect(AudioActivationPolicy.activationSteps(site: .webRTCConfigure, surface: .callKit, status: .refused)
            == [.setActive, .enableWebRTCAudio])

        let reset = AudioActivationPolicy.steps(site: .mediaServicesReset, surface: .callKit, status: .active)
        #expect(reset.first == .disableWebRTCAudio)
        #expect(AudioActivationPolicy.everyActivationEnablesWebRTCAudio(reset))
    }

    @Test func iosReasonRawValuesMapOntoOneVocabulary() {
        let expected: [Int: AudioRouteChangeReason] = [
            0: .unknown, 1: .newDeviceAvailable, 2: .oldDeviceUnavailable, 3: .categoryChange, 4: .routeOverride,
            5: .unknown, 6: .wakeFromSleep, 7: .noSuitableRouteForCategory, 8: .routeConfigurationChange,
        ]
        for (raw, reason) in expected {
            #expect(AudioRouteChangeReason.fromIOSRawValue(raw) == reason, "\(raw)")
        }
        #expect(AudioRouteChangeReason.routeOverride.rawValue == "override")
    }

    @Test func newDeviceRestoresTheReturningIntentOtherwiseFollowsTheDefault() {
        let restore = AudioRouteChangePolicy.action(
            reason: .newDeviceAvailable, intent: intent("bt-1", present: "bt-1", was: false),
            current: route("speaker", "speaker", "speaker"), pendingOwnRequest: false
        )
        #expect(restore.kind == .restoreIntent)
        #expect(restore.targetId == "bt-1")
        #expect(restore.postsRouteChanged && restore.restartsCapture)

        let adopt = AudioRouteChangePolicy.action(
            reason: .newDeviceAvailable, intent: intent("speaker", present: "speaker", was: true),
            current: route("speaker", "wired-1", "wired-1"), pendingOwnRequest: false
        )
        #expect(adopt.kind == .adoptNewDevice)
        #expect(adopt.targetId.isEmpty)
        #expect(adopt.intentId.isEmpty)
        #expect(adopt.postsRouteChanged)

        let keepClaim = AudioRouteChangePolicy.action(
            reason: .newDeviceAvailable, intent: intent("bt-1", present: "", was: false),
            current: route("speaker", "wired-1", "wired-1"), pendingOwnRequest: false
        )
        #expect(keepClaim.kind == .adoptNewDevice)
        #expect(keepClaim.intentId == "bt-1")

        let android = AudioRouteChangePolicy.action(
            reason: .newDeviceAvailable, intent: intent("out:2", present: "out:2", was: true),
            current: route("out:2", "out:2", "out:30"), pendingOwnRequest: false
        )
        #expect(android.targetId == "out:30")
        #expect(android.finalId == "out:30")
    }

    @Test func deviceLossKeepsTheIntentAndFallsBackWithOneEvent() {
        let lost = AudioRouteChangePolicy.action(
            reason: .oldDeviceUnavailable, intent: intent("bt-1", present: "", was: true),
            current: route("bt-1", "receiver", "speaker"), pendingOwnRequest: false
        )
        #expect(lost.kind == .fallBack)
        #expect(lost.intentId == "bt-1")
        #expect(lost.targetId == "speaker")
        #expect(lost.postsRouteChanged)

        let toIntent = AudioRouteChangePolicy.action(
            reason: .oldDeviceUnavailable, intent: intent("receiver", present: "receiver", was: true),
            current: route("wired-1", "speaker", "speaker"), pendingOwnRequest: false
        )
        #expect(toIntent.targetId == "receiver")
    }

    @Test func overrideIsAdoptedUnlessItIsTheOwnersOwnRequest() {
        let system = AudioRouteChangePolicy.action(
            reason: .routeOverride, intent: intent("speaker", present: "speaker", was: true),
            current: route("speaker", "receiver", "speaker"), pendingOwnRequest: false
        )
        #expect(system.kind == .adoptAsIntent)
        #expect(system.intentId == "receiver")
        #expect(!system.postsRouteChanged)
        let own = AudioRouteChangePolicy.action(
            reason: .routeOverride, intent: intent("speaker", present: "speaker", was: true),
            current: route("receiver", "speaker", "speaker"), pendingOwnRequest: true
        )
        #expect(own.kind == .confirmOwnRequest)
        #expect(own.intentId == "speaker")
        #expect(!own.postsRouteChanged)
    }

    @Test func categoryChangeIsIgnoredAndReReadsReapplyOnlyAPresentDifferentIntent() {
        let category = AudioRouteChangePolicy.action(
            reason: .categoryChange, intent: intent("bt-1", present: "bt-1", was: true),
            current: route("speaker", "receiver", "speaker"), pendingOwnRequest: false
        )
        #expect(category.kind == .ignore && !category.postsRouteChanged && !category.restartsCapture)
        for reason in [AudioRouteChangeReason.routeConfigurationChange, .wakeFromSleep, .noSuitableRouteForCategory, .unknown] {
            let reapply = AudioRouteChangePolicy.action(
                reason: reason, intent: intent("bt-1", present: "bt-1", was: true),
                current: route("bt-1", "speaker", "speaker"), pendingOwnRequest: false
            )
            #expect(reapply.kind == .reapplyIntent, "\(reason)")
            #expect(reapply.targetId == "bt-1")

            #expect(!reapply.postsRouteChanged)
            let keep = AudioRouteChangePolicy.action(
                reason: reason, intent: intent("bt-1", present: "", was: false),
                current: route("speaker", "speaker", "speaker"), pendingOwnRequest: false
            )
            #expect(keep.kind == .keep && keep.targetId.isEmpty && !keep.postsRouteChanged)
        }
    }

    @Test func systemPickerWindowTurnsChangesIntoChoicesExceptLossAndCategory() {
        #expect(AudioRouteChangePolicy.effectiveReason(.newDeviceAvailable, isWithinSystemPickerWindow: true) == .routeOverride)
        #expect(AudioRouteChangePolicy.effectiveReason(.routeConfigurationChange, isWithinSystemPickerWindow: true) == .routeOverride)
        #expect(AudioRouteChangePolicy.effectiveReason(.oldDeviceUnavailable, isWithinSystemPickerWindow: true) == .oldDeviceUnavailable)
        #expect(AudioRouteChangePolicy.effectiveReason(.categoryChange, isWithinSystemPickerWindow: true) == .categoryChange)
        #expect(AudioRouteChangePolicy.effectiveReason(.newDeviceAvailable, isWithinSystemPickerWindow: false) == .newDeviceAvailable)
    }

    @Test func communicationDeviceChangesAreClassifiedByPresence() {
        let ids = ["out:2", "out:3", "out:12"]
        #expect(AudioRouteChangePolicy.classifyCommunicationDeviceChange(
            previousId: "out:12", newId: "out:2", previousAvailableIds: ids, currentAvailableIds: ["out:2", "out:3"]
        ) == .oldDeviceUnavailable)
        #expect(AudioRouteChangePolicy.classifyCommunicationDeviceChange(
            previousId: "out:2", newId: "out:19", previousAvailableIds: ids, currentAvailableIds: ids + ["out:19"]
        ) == .newDeviceAvailable)
        #expect(AudioRouteChangePolicy.classifyCommunicationDeviceChange(
            previousId: "out:2", newId: "out:12", previousAvailableIds: ids, currentAvailableIds: ids
        ) == .routeOverride)
        #expect(AudioRouteChangePolicy.classifyCommunicationDeviceChange(
            previousId: "out:2", newId: "out:2", previousAvailableIds: ids, currentAvailableIds: ids
        ) == .routeConfigurationChange)
    }

    @Test func ownRequestWindowAndTarget() {
        #expect(AudioRouteChangePolicy.isOwnRequest(requestMillis: 1_000, targetId: "speaker", currentId: "speaker", nowMillis: 1_500))
        #expect(!AudioRouteChangePolicy.isOwnRequest(requestMillis: 1_000, targetId: "speaker", currentId: "receiver", nowMillis: 1_500))
        #expect(!AudioRouteChangePolicy.isOwnRequest(requestMillis: 1_000, targetId: "speaker", currentId: "speaker", nowMillis: 2_600))
        #expect(AudioRouteChangePolicy.isOwnRequest(requestMillis: 1_000, targetId: "", currentId: "bt-1", nowMillis: 1_200))
        #expect(!AudioRouteChangePolicy.isOwnRequest(requestMillis: -1, targetId: "", currentId: "bt-1", nowMillis: 1_200))
    }

    @Test func interruptionsToggleOtherAudioAndAHoldIsSticky() {
        #expect(AudioInterruptionPolicy.next(current: .none, event: .began) == .otherAudio)
        #expect(AudioInterruptionPolicy.next(current: .otherAudio, event: .ended) == .none)
        #expect(AudioInterruptionPolicy.next(current: .none, event: .beganBuiltInMicMuted) == .deviceMicMuted)
        #expect(AudioInterruptionPolicy.next(current: .none, event: .focusLost) == .otherAudio)
        #expect(AudioInterruptionPolicy.next(current: .otherAudio, event: .focusGained) == .none)
        #expect(AudioInterruptionPolicy.next(current: .none, event: .servicesReset) == .servicesReset)
        #expect(AudioInterruptionPolicy.next(current: .servicesReset, event: .servicesRecovered) == .none)
        for event in AudioInterruptionEvent.allCases {
            #expect(AudioInterruptionPolicy.next(current: .held, event: event) == .held, "\(event)")
        }
        #expect(AudioInterruptionPolicy.beganEvent(reasonRawValue: 2) == .beganBuiltInMicMuted)
        #expect(AudioInterruptionPolicy.beganEvent(reasonRawValue: 0) == .began)
        #expect(AudioInterruptionPolicy.beganEvent(reasonRawValue: 4) == .began)
    }

    @Test func headsetLossFallsBackWithoutErasingIntentAndTheReturnRestoresIt() {
        let clock = Clock()
        let backend = FakeBackend()
        let owner = makeOwner(clock, backend)
        var events: [AudioRouteEvent] = []
        owner.onRouteEvent = { events.append($0) }
        owner.callAudioDidStart()
        owner.publish(state([receiver, speaker, airPods], current: "speaker", defaultId: "bt-1"))

        owner.requestRoute(id: "bt-1")
        #expect(owner.route.phase == .switching)
        #expect(owner.route.pendingId == "bt-1")
        #expect(backend.applied == ["bt-1"])
        clock.now += 300
        owner.handleRouteChange(.routeOverride, previousId: "speaker", state: state([receiver, speaker, airPods], current: "bt-1", defaultId: "bt-1"))
        #expect(owner.route.phase == .idle)
        #expect(owner.route.pendingId.isEmpty)
        #expect(owner.preferredRouteIntent == "bt-1")
        #expect(events.isEmpty)

        clock.now += 10_000
        let lost = owner.handleRouteChange(.oldDeviceUnavailable, previousId: "bt-1", state: state([receiver, speaker], current: "receiver", defaultId: "speaker"))
        #expect(lost.kind == .fallBack)
        #expect(backend.applied.last == "speaker")
        #expect(owner.preferredRouteIntent == "bt-1")
        #expect(events.count == 1)
        #expect(events.first?.name == "Speaker")
        #expect(events.first?.kind == AudioRouteEvent.routeChangedKind)

        clock.now += 200
        let landed = owner.handleRouteChange(.routeOverride, previousId: "receiver", state: state([receiver, speaker], current: "speaker", defaultId: "speaker"))
        #expect(landed.kind == .confirmOwnRequest)
        #expect(owner.preferredRouteIntent == "bt-1")
        #expect(events.count == 1)

        clock.now += 10_000
        let back = owner.handleRouteChange(.newDeviceAvailable, previousId: "speaker", state: state([receiver, speaker, airPods], current: "speaker", defaultId: "bt-1"))
        #expect(back.kind == .restoreIntent)
        #expect(backend.applied.last == "bt-1")
        #expect(events.count == 2)
        #expect(events.last?.name == "AirPods Pro")
        #expect(owner.automaticRouteEventCount == 2)
    }

    @Test func aReconnectedAndroidDeviceWithANewIdIsStillTheIntent() {
        let clock = Clock()
        let backend = FakeBackend()
        let owner = makeOwner(clock, backend)
        let phone = AudioRouteOption(id: "out:1", kind: .receiver, name: "Phone", isConnecting: false)
        let loud = AudioRouteOption(id: "out:2", kind: .speaker, name: "Speaker", isConnecting: false)
        let buds = AudioRouteOption(id: "out:12", kind: .bluetooth, name: "Pixel Buds Pro", isConnecting: false)
        let budsAgain = AudioRouteOption(id: "out:19", kind: .bluetooth, name: "Pixel Buds Pro", isConnecting: false)
        owner.callAudioDidStart()
        owner.publish(state([buds, loud, phone], current: "out:2", defaultId: "out:12"))
        owner.requestRoute(id: "out:12")
        owner.publish(state([buds, loud, phone], current: "out:12", defaultId: "out:12"))
        #expect(owner.route.phase == .idle)
        clock.now += 10_000
        owner.handleRouteChange(.oldDeviceUnavailable, previousId: "out:12", state: state([loud, phone], current: "out:2", defaultId: "out:2"))
        #expect(owner.preferredRouteIntent == "out:12")
        clock.now += 10_000
        let back = owner.handleRouteChange(.newDeviceAvailable, previousId: "out:2", state: state([budsAgain, loud, phone], current: "out:2", defaultId: "out:19"))
        #expect(back.kind == .restoreIntent)
        #expect(backend.applied.last == "out:19")
        #expect(owner.preferredRouteIntent == "out:19")
    }

    @Test func aChoiceInSystemUIBecomesTheIntentWithNoEventAndIsRecordedAsTheTarget() {
        let clock = Clock()
        let backend = FakeBackend()
        let owner = makeOwner(clock, backend)
        var events: [AudioRouteEvent] = []
        owner.onRouteEvent = { events.append($0) }
        owner.callAudioDidStart()
        owner.publish(state([receiver, speaker], current: "speaker", defaultId: "speaker"))
        clock.now += 10_000
        let action = owner.handleRouteChange(.routeOverride, previousId: "speaker", state: state([receiver, speaker], current: "receiver", defaultId: "speaker"))
        #expect(action.kind == .adoptAsIntent)
        #expect(owner.preferredRouteIntent == "receiver")
        #expect(backend.adopted == ["receiver"])
        #expect(backend.applied.isEmpty)
        #expect(events.isEmpty)

        owner.noteSystemRoutePickerDismissed()
        clock.now += 500
        owner.noteOwnRouteRequest(targetId: "")
        let picked = owner.handleRouteChange(.newDeviceAvailable, previousId: "receiver", state: state([receiver, speaker, airPods], current: "bt-1", defaultId: "bt-1"))
        #expect(picked.kind == .adoptAsIntent)
        #expect(owner.preferredRouteIntent == "bt-1")
        #expect(events.isEmpty)
    }

    @Test func aRequestThatNeverLandsFailsAfterThreeSecondsAndRevertsTheIntent() {
        let clock = Clock()
        let backend = FakeBackend()
        let owner = makeOwner(clock, backend)
        var failures: [String] = []
        owner.onRouteFailed = { failures.append($0) }
        owner.callAudioDidStart()
        owner.publish(state([receiver, speaker, airPods], current: "speaker", defaultId: "bt-1"))
        owner.requestRoute(id: "bt-1")
        #expect(owner.route.phase == .switching)
        clock.now += 2_000
        owner.checkPendingTimeout()
        #expect(owner.route.phase == .switching)
        clock.now += 1_100
        owner.checkPendingTimeout()
        #expect(owner.route.phase == .failed)
        #expect(owner.route.pendingId == "bt-1")
        #expect(failures == ["bt-1"])
        #expect(owner.preferredRouteIntent.isEmpty)

        backend.accepts = false
        owner.requestRoute(id: "receiver")
        #expect(owner.route.phase == .failed)
        #expect(failures == ["bt-1", "receiver"])
        backend.accepts = true
        owner.requestRoute(id: "speaker")
        #expect(owner.route.phase == .idle)
        #expect(owner.preferredRouteIntent == "speaker")
    }

    @Test func publishIsEqualityGuardedAndTheSnapshotCarriesTheS30Fields() {
        let clock = Clock()
        let backend = FakeBackend()
        let owner = makeOwner(clock, backend)
        let mic = AudioRouteOption(id: "mic-1", kind: .receiver, name: "iPhone Microphone", isConnecting: false)
        let platform = AudioRoutePlatformState.make(
            options: [receiver, speaker], currentId: "speaker", defaultId: "speaker",
            inputs: [mic], currentInputId: "mic-1", canToggleSpeaker: true, canChooseInput: false, canShowMicModes: true
        )
        owner.publish(platform)
        let count = owner.publishCount
        let revision = owner.route.revision
        owner.publish(platform)
        #expect(owner.publishCount == count)
        #expect(owner.route.revision == revision)
        #expect(owner.route.isSpeakerOn)
        #expect(owner.route.canToggleSpeaker)
        #expect(owner.route.inputs == [mic])
        #expect(owner.route.currentInputId == "mic-1")
        #expect(owner.route.routeKind == .speaker)
        #expect(owner.route.routeName == "Speaker")
        #expect(owner.route.bluetoothAccess == .notNeeded)
    }

    @Test func prejoinIntentIsAppliedExactlyOnceAndAnEmptyListKeepsIt() {
        let clock = Clock()
        let backend = FakeBackend()
        let owner = makeOwner(clock, backend)
        owner.setPrejoinIntent(outputKind: AudioRouteKind.bluetooth.rawValue, inputId: "")

        #expect(backend.applied.isEmpty)
        backend.refreshState = state([receiver, speaker], current: "speaker", defaultId: "speaker")
        owner.callAudioDidStart()
        #expect(backend.refreshes == 1)
        #expect(backend.applied.isEmpty)
        owner.publish(state([receiver, speaker, airPods], current: "speaker", defaultId: "bt-1"))
        #expect(backend.applied == ["bt-1"])
        #expect(owner.preferredRouteIntent == "bt-1")
        owner.publish(state([receiver, speaker, airPods], current: "bt-1", defaultId: "bt-1"))
        owner.publish(state([receiver, speaker], current: "speaker", defaultId: "speaker"))
        owner.publish(state([receiver, speaker, airPods], current: "speaker", defaultId: "bt-1"))
        #expect(backend.applied == ["bt-1"])
    }

    @Test func speakerToggleAndTheBluetoothAccessRow() {
        let clock = Clock()
        let backend = FakeBackend()
        let owner = makeOwner(clock, backend)
        owner.callAudioDidStart()
        owner.publish(state([receiver, speaker], current: "receiver", defaultId: "speaker"))
        owner.setSpeaker(true)
        #expect(backend.applied == ["speaker"])
        owner.publish(state([receiver, speaker, airPods], current: "speaker", defaultId: "bt-1"))
        owner.setSpeaker(false)
        #expect(backend.applied.last == "bt-1")

        let access = AudioRouteOption(id: AudioRouteOwner.bluetoothAccessOptionId, kind: .bluetooth, name: "Bluetooth headset", isConnecting: false)
        owner.publish(AudioRoutePlatformState.make(options: [receiver, speaker, access], currentId: "speaker", defaultId: "speaker", bluetoothAccess: .needsGrant))
        let intentBefore = owner.preferredRouteIntent
        owner.requestRoute(id: AudioRouteOwner.bluetoothAccessOptionId)
        #expect(backend.bluetoothRequests == 1)
        #expect(owner.preferredRouteIntent == intentBefore)
        #expect(owner.route.bluetoothAccess == .needsGrant)
    }

    @Test func interruptionsReachCallPresenceAndNeverChangeMute() {
        let clock = Clock()
        let backend = FakeBackend()
        let owner = makeOwner(clock, backend)
        let presence = CallPresence()
        presence.apply(CallPresenceInputs.make(callSession: 1, sessionPhase: .entering, isMuted: false))
        presence.apply(CallPresenceInputs.make(callSession: 1, sessionPhase: .inCall, roomLabel: "lily-zoro-iris", isMuted: false))
        owner.presence = presence
        owner.callAudioDidStart()

        owner.reportInterruptionEvent(.began)
        #expect(presence.snapshot.interruption == .otherAudio)
        #expect(!presence.snapshot.isMuted)
        owner.reportInterruptionEvent(.ended)
        #expect(presence.snapshot.interruption == .none)
        #expect(!presence.snapshot.isMuted)

        let session = presence.snapshot.presenceSession
        #expect(presence.handle(.hold, source: .callKit, presenceSession: session) == .dispatched)
        #expect(presence.snapshot.phase == .onHold)
        owner.reportInterruptionEvent(.began)
        owner.reportInterruptionEvent(.ended)
        #expect(presence.snapshot.interruption == .held)
        #expect(presence.handle(.resume, source: .callKit, presenceSession: session) == .dispatched)
        #expect(presence.snapshot.interruption == .none)
        #expect(presence.snapshot.phase == .live)
    }

    @Test func callAudioEndKeepsTheIntentAndClearsPendingWork() {
        let clock = Clock()
        let backend = FakeBackend()
        let owner = makeOwner(clock, backend)
        owner.callAudioDidStart()
        owner.publish(state([receiver, speaker, airPods], current: "speaker", defaultId: "bt-1"))
        owner.requestRoute(id: "bt-1")
        #expect(owner.route.phase == .switching)
        owner.callAudioDidEnd()
        #expect(owner.route.phase == .idle)
        #expect(owner.route.options.isEmpty)
        #expect(owner.preferredRouteIntent == "bt-1")
        owner.reset()
        #expect(owner.preferredRouteIntent.isEmpty)
    }

    @Test func routeStringsAreInTheCatalogs() throws {

        let xml = try sys2Source("Android/app/src/main/res/values/strings.xml")
        for name in ["ctl_route_phone", "ctl_route_speaker", "ctl_route_bluetooth", "ctl_route_wired", "ctl_route_usb", "ctl_route_hearing_aid"] {
            #expect(xml.contains("<string name=\"\(name)\""), "missing \(name)")
        }
        let catalog = try sys2Source("Sources/Conclave/Resources/Localizable.xcstrings")
        #expect(catalog.contains("\"iPhone\""))
        #expect(catalog.contains("\"Speaker\""))
    }
}

private func sys2Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func sys2Code(_ text: String) -> String {
    text.components(separatedBy: "\n").filter { line in
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return !(trimmed.hasPrefix("//") || trimmed.hasPrefix("/*") || trimmed.hasPrefix("*"))
    }.joined(separator: "\n")
}

private func sys2Count(_ needle: String, in text: String) -> Int {
    text.components(separatedBy: needle).count - 1
}

private struct SYS2ScanError: Error {
    let marker: String
}

private func sys2Body(_ text: String, from start: String, to end: String) throws -> String {
    guard let lower = text.range(of: start) else { throw SYS2ScanError(marker: start) }
    guard let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else { throw SYS2ScanError(marker: end) }
    return String(text[lower.lowerBound..<upper.lowerBound])
}
#endif
