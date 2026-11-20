#if !SKIP
import Testing
@testable import Conclave

@MainActor
struct STGOrderPriorityTests {
    private func roster(count: Int = 12, cameras: [String] = [], hands: [String] = [], localCameraOn: Bool = false) -> [StageParticipantInput] {
        var rows = [StageParticipantInput.make(userId: "you", isLocal: true, isCameraOff: !localCameraOn)]
        for serial in 1..<count {
            let id = "r" + String(serial)
            rows.append(StageParticipantInput.make(userId: id, isCameraOff: !cameras.contains(id),
                isHandRaised: hands.contains(id), joinSerial: serial))
        }
        return rows
    }

    private func inputs(_ rows: [StageParticipantInput], mode: String = "tiled", pin: String = "", presenter: String = "",
                        selfMode: String = "tile") -> StageInputs {
        StageInputs.make(callSession: 1, isInCall: true, localUserId: "you", participants: rows,
            viewMode: mode, selfViewMode: selfMode, pinnedUserId: pin, screenShareUserId: presenter)
    }

    private func stage() -> StagePresenter {
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        stage.setViewport(StagePoliciesTests.iphoneSE)
        return stage
    }

    private func visible(_ stage: StagePresenter) -> [String] {
        StageOrderPolicy.visibleRemoteIds(stage.layout.slots, localUserId: "you")
    }

    @Test func tiersKeepPreviousOrderAndRecentSpeakersExpire() {
        let rows = roster(cameras: ["r2", "r5"], hands: ["r3", "r7"])
        let order = ["r11", "r10", "r9", "r8", "r7", "r6", "r5", "r4", "r3", "r2", "r1"]
        #expect(StageOrderPolicy.priorityOrder(order, participants: rows, lastSpokeAt: ["r6": 9_000, "r8": 8_000],
            protected: ["r1", "r4"], speakerUserId: "r9", nowMillis: 10_000)
            == ["r4", "r1", "r9", "r8", "r6", "r7", "r3", "r5", "r2", "r11", "r10"])
        #expect(StageOrderPolicy.priorityTier("r6", participants: rows, lastSpokeAt: ["r6": 9_000],
            protected: [], speakerUserId: "", nowMillis: 39_000) == 5)
    }

    @Test func joiningAnOverflowingCallStartsWithCamerasBeforeSilentViewers() {
        let stage = stage()
        defer { stage.reset() }
        stage.apply(inputs(roster(cameras: ["r5", "r6", "r7", "r8", "r9", "r10", "r11"])))
        #expect(visible(stage) == ["r5", "r6", "r7", "r8", "r9"])
        #expect(stage.layout.overflowCount == 6)
        #expect(!stage.layout.slots.contains { $0.userId == "you" })
        #expect(stage.pendingPromotionCandidate.isEmpty)
    }

    @Test func initialHandsPrecedeCamerasAndThePresenterLeadsTheStrip() {
        let stage = stage()
        defer { stage.reset() }
        stage.apply(inputs(roster(cameras: ["r4", "r5", "r6"], hands: ["r9"]), presenter: "r11"))
        #expect(stage.layout.kind == .presentation)
        #expect(visible(stage) == ["r11", "r9", "r4"])
        #expect(stage.layout.overflowCount == 8)
    }

    @Test func raisedHandsBypassTheHoldAndWaitForTheNextSwapInterval() {
        var clock = 10_000.0
        let stage = stage()
        defer { stage.reset() }
        stage.now = { clock }
        stage.apply(inputs(roster()))
        stage.apply(inputs(roster(hands: ["r8"])))
        #expect(stage.pendingPromotionCandidate == "r8")
        #expect(stage.pendingPromotionDelayMillis == 0)
        stage.firePendingPromotion()
        #expect(visible(stage).contains("r8"))
        let before = visible(stage)
        clock += 100
        stage.apply(inputs(roster(hands: ["r8", "r9"])))
        #expect(stage.pendingPromotionCandidate == "r9")
        #expect(stage.pendingPromotionDelayMillis == 7_900)
        stage.firePendingPromotion()
        #expect(visible(stage) == before)
        clock += 7_900
        stage.firePendingPromotion()
        #expect(visible(stage).contains("r9"))
        #expect(visible(stage).contains("r8"))
    }

    @Test func raisingAHandDuringACameraHoldReschedulesTheSameCandidatePromptly() {
        var clock = 10_000.0
        let stage = stage()
        defer { stage.reset() }
        stage.now = { clock }
        stage.apply(inputs(roster()))
        stage.apply(inputs(roster(cameras: ["r8"])))
        #expect(stage.pendingPromotionDelayMillis == 1_200)
        clock += 100
        stage.apply(inputs(roster(cameras: ["r8"], hands: ["r8"])))
        #expect(stage.pendingPromotionCandidate == "r8")
        #expect(stage.pendingPromotionDelayMillis == 0)
        stage.firePendingPromotion()
        #expect(visible(stage).contains("r8"))
    }

    @Test func cameraOnWaitsForTheHoldAndCameraOffDoesNotImmediatelyRemoveATile() {
        var clock = 10_000.0
        let stage = stage()
        defer { stage.reset() }
        stage.now = { clock }
        stage.apply(inputs(roster()))
        let before = visible(stage)
        stage.apply(inputs(roster(cameras: ["r8"])))
        #expect(visible(stage) == before)
        #expect(stage.pendingPromotionCandidate == "r8")
        #expect(stage.pendingPromotionDelayMillis == 1_200)
        clock += 1_199
        stage.firePendingPromotion()
        #expect(visible(stage) == before)
        clock += 1
        stage.firePendingPromotion()
        #expect(visible(stage).contains("r8"))
        let after = visible(stage)
        stage.apply(inputs(roster()))
        #expect(visible(stage) == after)
        #expect(stage.pendingPromotionCandidate.isEmpty)
    }

    @Test func aVisibleCameraTurningOffStartsAHoldForAnAlreadyHiddenCamera() {
        var clock = 10_000.0
        let stage = stage()
        defer { stage.reset() }
        stage.now = { clock }
        let cameras = ["r1", "r2", "r3", "r4", "r5", "r8"]
        stage.apply(inputs(roster(cameras: cameras)))
        #expect(!visible(stage).contains("r8"))
        clock += 60_000
        let before = visible(stage)
        stage.apply(inputs(roster(cameras: cameras.filter { $0 != "r1" })))
        #expect(visible(stage) == before)
        #expect(stage.pendingPromotionCandidate == "r8")
        #expect(stage.pendingPromotionDelayMillis == 1_200)
        clock += 1_199
        stage.firePendingPromotion()
        #expect(visible(stage) == before)
        clock += 1
        stage.firePendingPromotion()
        #expect(!visible(stage).contains("r1"))
        #expect(visible(stage).contains("r8"))
    }

    @Test func presentationAndPinnedRailsPromoteHandsAndCameras() {
        for mode in ["presentation", "spotlight", "sidebar"] {
            var clock = 10_000.0
            let stage = stage()
            defer { stage.reset() }
            stage.now = { clock }
            let pin = mode == "presentation" ? "" : "r1"
            let presenter = mode == "presentation" ? "r1" : ""
            stage.apply(inputs(roster(), mode: mode, pin: pin, presenter: presenter))
            #expect(!visible(stage).contains("r8"))
            stage.apply(inputs(roster(cameras: ["r8"]), mode: mode, pin: pin, presenter: presenter))
            clock += 1_200
            stage.firePendingPromotion()
            #expect(visible(stage).contains("r8"), "\(mode)")
            stage.apply(inputs(roster(cameras: ["r8"], hands: ["r9"]), mode: mode, pin: pin, presenter: presenter))
            clock += 8_000
            stage.firePendingPromotion()
            #expect(visible(stage).contains("r9"), "\(mode)")
            #expect(visible(stage).contains("r1"), "\(mode)")
        }
    }

    @Test func activeSpeakerIsNeverDemotedByAHandOrCamera() {
        let stage = stage()
        defer { stage.reset() }
        stage.now = { 10_000 }
        stage.apply(inputs(roster()))
        stage.speakerChanged("r5", atMillis: 10_000)
        stage.apply(inputs(roster(hands: ["r8"])))
        stage.firePendingPromotion()
        #expect(visible(stage).contains("r5"))
        #expect(visible(stage).contains("r8"))
        #expect(StageOrderPolicy.swapTarget(visibleRemoteIds: ["r5", "r8", "r1"], lastSpokeAt: [:],
            participants: roster(hands: ["r8"]), protected: ["r1"], speakerUserId: "r5", nowMillis: 10_000) == "r8")
    }

    @Test func demotionUsesTheLowestTierThenTheLongestSilence() {
        let rows = roster(cameras: ["r1"], hands: ["r2"])
        #expect(StageOrderPolicy.swapTarget(visibleRemoteIds: ["r1", "r2", "r3", "r4"],
            lastSpokeAt: ["r3": 1_000, "r4": 2_000], participants: rows, protected: [],
            speakerUserId: "", nowMillis: 40_000) == "r3")
        #expect(StageOrderPolicy.promotionCandidate(order: ["r1", "r2", "r3", "r4"], visibleRemoteIds: ["r3"],
            participants: roster(), lastSpokeAt: [:], protected: [], speakerUserId: "", nowMillis: 10_000).isEmpty)
    }

    @Test func selfCameraOffIsOmittedOnlyForOverflowAndCameraOnStaysLast() {
        for mode in ["tiled", "spotlight", "sidebar", "presentation"] {
            let stage = stage()
            defer { stage.reset() }
            let presenter = mode == "presentation" ? "r1" : ""
            stage.apply(inputs(roster(count: 4), mode: mode, presenter: presenter))
            #expect(stage.layout.slots.contains { $0.userId == "you" })
            stage.apply(inputs(roster(), mode: mode, presenter: presenter))
            #expect(stage.layout.overflowCount > 0)
            #expect(!stage.layout.slots.contains { $0.id == "p:you" })
            stage.apply(inputs(roster(localCameraOn: true), mode: mode, presenter: presenter))
            let people = stage.layout.slots.filter { $0.id.hasPrefix("p:") }
            #expect(people.last?.userId == "you")
        }
        let floating = stage()
        defer { floating.reset() }
        floating.apply(inputs(roster(), selfMode: "floating"))
        #expect(floating.layout.slots.contains { $0.userId == "you" && $0.role == .selfFloating })
    }

    @Test func spotlightCameraChangesWaitWithoutReplacingTheMainImmediately() {
        var clock = 10_000.0
        let stage = stage()
        defer { stage.reset() }
        stage.now = { clock }
        stage.apply(inputs(roster(), mode: "spotlight"))
        let before = stage.layout.slots
        stage.apply(inputs(roster(cameras: ["r8"]), mode: "spotlight"))
        #expect(stage.layout.slots == before)
        #expect(stage.pendingPromotionCandidate == "r8")
        clock += 1_200
        stage.firePendingPromotion()
        #expect(visible(stage).contains("r8"))
        #expect(stage.layout.slots.first?.userId == "r1")
    }

    @Test func anUnpinnedSilentMainCanBeDemotedAfterTheHoldWhenTheRailHasHigherTiers() {
        var clock = 10_000.0
        let stage = stage()
        defer { stage.reset() }
        stage.now = { clock }
        stage.apply(inputs(roster(), mode: "spotlight"))
        stage.apply(inputs(roster(cameras: ["r2", "r3", "r4"]), mode: "spotlight"))
        #expect(stage.layout.slots.first?.userId == "r1")
        stage.apply(inputs(roster(cameras: ["r2", "r3", "r4", "r8"]), mode: "spotlight"))
        #expect(stage.layout.slots.first?.userId == "r1")
        clock += 1_200
        stage.firePendingPromotion()
        #expect(!visible(stage).contains("r1"))
        #expect(visible(stage) == ["r8", "r2", "r3", "r4"])
    }

    @Test func hiddenCameraOffSpeakerIsPromotedIntoThePresentationStripAfterTheHold() {
        var clock = 10_000.0
        let stage = stage()
        defer { stage.reset() }
        stage.now = { clock }
        stage.apply(inputs(roster(cameras: ["r2", "r3"]), presenter: "r1"))
        stage.speakerChanged("r8", atMillis: clock)
        #expect(stage.pendingPromotionCandidate == "r8")
        #expect(!visible(stage).contains("r8"))
        clock += 1_200
        stage.firePendingPromotion()
        #expect(visible(stage).contains("r8"))
        #expect(visible(stage).contains("r1"))
    }

    @Test func raisedHandsRemainEligibleWhenQuietCameraOffTilesAreFiltered() {
        let rows = roster(cameras: ["r1", "r2", "r3", "r4", "r5", "r6"], hands: ["r8"])
        let stage = stage()
        defer { stage.reset() }
        stage.now = { 10_000 }
        let next = StageInputs.make(callSession: 1, isInCall: true, localUserId: "you", participants: rows,
            viewMode: "tiled", hideTilesWithoutVideo: true, selfViewMode: "tile")
        stage.apply(next)
        #expect(visible(stage).contains("r8"))
        #expect(!visible(stage).contains("r7"))
    }

    @Test func aLoweredHiddenHandAndADepartedCandidateCannotBePromoted() {
        let stage = stage()
        defer { stage.reset() }
        stage.now = { 10_000 }
        stage.apply(inputs(roster()))
        stage.apply(inputs(roster(hands: ["r8"])))
        stage.apply(inputs(roster()))
        stage.firePendingPromotion()
        #expect(!visible(stage).contains("r8"))
        stage.apply(inputs(roster(cameras: ["r8"])))
        stage.apply(inputs(roster().filter { $0.userId != "r8" }))
        stage.firePendingPromotion()
        #expect(!visible(stage).contains("r8"))
        #expect(stage.pendingPromotionCandidate.isEmpty)
    }
}
#endif
