#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct NativeNetworkStabilityTests {
    @Test func pathChangesRecoverOnceWithoutTreatingInitialSnapshotAsHandover() {
        var tracker = NetworkPathChangeTracker()
        let sequence: [(String?, Bool)] = [
            ("wifi:1", false), ("wifi:1", false), ("cellular:2", true), ("cellular:2", false),
            (nil, false), (nil, false), ("cellular:2", true), ("cellular:2", false),
        ]
        for (path, expectedRecovery) in sequence {
            let shouldRecover = tracker.record(usablePathId: path)
            #expect(shouldRecover == expectedRecovery)
        }
        var offlineStart = NetworkPathChangeTracker()
        let initialOffline = offlineStart.record(usablePathId: nil)
        #expect(!initialOffline)
        let becameUsable = offlineStart.record(usablePathId: "wifi:3")
        #expect(becameUsable)
    }

    @Test func stoppedSenderFallsBackWithoutIncomingBytesAndRecoversOnProgress() {
        var tracker = RemoteVideoHealthTracker()
        let initial = tracker.sample(framesDecoded: 80, nowMs: 100, isPaused: false)
        #expect(!initial.isStalled)
        let firstRetry = tracker.sample(framesDecoded: 80, nowMs: 2_100, isPaused: false)
        #expect(firstRetry.requestKeyFrame)
        let stalled = tracker.sample(framesDecoded: 80, nowMs: 4_100, isPaused: false)
        #expect(stalled.isStalled)
        #expect(!stalled.requestKeyFrame)
        let laterRetry = tracker.sample(framesDecoded: 80, nowMs: 8_100, isPaused: false)
        #expect(laterRetry.requestKeyFrame)
        let recovered = tracker.sample(framesDecoded: 81, nowMs: 8_200, isPaused: false)
        #expect(!recovered.isStalled)
        #expect(!recovered.requestKeyFrame)
        let progressing = tracker.sample(framesDecoded: 82, nowMs: 10_200, isPaused: false)
        #expect(!progressing.isStalled)
    }

    @Test func missingAndZeroDecodeStatsCannotKeepABlackTileForever() {
        for initial in [Double?.none, Double?.some(0)] {
            var tracker = RemoteVideoHealthTracker()
            let grace = tracker.sample(framesDecoded: initial, nowMs: 0, isPaused: false)
            #expect(!grace.isStalled)
            let missingFrames = tracker.sample(framesDecoded: initial, nowMs: 4_000, isPaused: false)
            #expect(missingFrames.isStalled)
            let invalidFrames = tracker.sample(framesDecoded: .nan, nowMs: 5_000, isPaused: false)
            #expect(invalidFrames.isStalled)
            let negativeFrames = tracker.sample(framesDecoded: -1, nowMs: 6_000, isPaused: false)
            #expect(negativeFrames.isStalled)
            let decoded = tracker.sample(framesDecoded: 1, nowMs: 6_100, isPaused: false)
            #expect(!decoded.isStalled)
        }
    }

    @Test func pausedConsumersNeverRequestKeyframesAndResumeWithFreshGrace() {
        var tracker = RemoteVideoHealthTracker()
        _ = tracker.sample(framesDecoded: 10, nowMs: 0, isPaused: false)
        let paused = tracker.sample(framesDecoded: 10, nowMs: 20_000, isPaused: true)
        #expect(paused.isStalled)
        #expect(!paused.requestKeyFrame)
        let resumed = tracker.sample(framesDecoded: 10, nowMs: 30_000, isPaused: false)
        #expect(!resumed.isStalled)
        #expect(!resumed.requestKeyFrame)
        let stalledAgain = tracker.sample(framesDecoded: 10, nowMs: 34_000, isPaused: false)
        #expect(stalledAgain.isStalled)
        let counterReset = tracker.sample(framesDecoded: 1, nowMs: 34_100, isPaused: false)
        #expect(!counterReset.isStalled)
    }

    @Test func actualStageMainGetsFocusEvenWithoutActiveSpeakerOrPin() {
        let slots = [
            StageSlot(id: "p:quiet-main", role: .spotlightMain, userId: "quiet-main", fit: .fill),
            StageSlot(id: "p:rail", role: .rail, userId: "rail", fit: .fill),
            StageSlot(id: "p:local", role: .spotlightMain, userId: "local", fit: .fill),
            StageSlot(id: "feed", role: .programFeed, userId: "host", fit: .fit),
            StageSlot(id: "duplicate", role: .spotlightMain, userId: "quiet-main", fit: .fill),
        ]
        #expect(StageReceiveFocusPolicy.focusedUserIds(slots: slots, localUserId: "local") == ["quiet-main", "host"])
        #expect(StageReceiveFocusPolicy.focusedUserIds(slots: [], localUserId: "local").isEmpty)
    }

    @Test func staticScreenShareKeepsItsLastFrameButBrokenDecodingStillRequestsAKeyframe() {
        var tracker = RemoteVideoHealthTracker()
        for now in [0.0, 2_000, 4_000, 10_000] {
            let idle = tracker.sample(framesDecoded: 5, nowMs: now, isPaused: false,
                                      isScreenShare: true, bytesReceived: 100_000)
            #expect(!idle.isStalled)
            #expect(!idle.requestKeyFrame)
        }
        let broken = tracker.sample(framesDecoded: 5, nowMs: 12_000, isPaused: false,
                                    isScreenShare: true, bytesReceived: 120_000)
        #expect(broken.requestKeyFrame)
        #expect(!broken.isStalled)
    }

    @MainActor @Test func quietOneOnOneStagePromotesItsMainInsteadOfUsingThumbnailQuality() {
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.setViewport(StagePoliciesTests.iphone17e)
        let inputs = StageFixtureScript.base(count: 2)
        stage.apply(inputs)
        #expect(inputs.pinnedUserId.isEmpty)
        let focused = StageReceiveFocusPolicy.focusedUserIds(slots: stage.layout.slots, localUserId: inputs.localUserId)
        #expect(focused == [StageFixtureScript.remoteId(0)])
        let grid = StageFixtureScript.copy(StageFixtureScript.base(count: 4), viewMode: "tiled")
        stage.apply(grid)
        #expect(StageReceiveFocusPolicy.focusedUserIds(slots: stage.layout.slots, localUserId: grid.localUserId).isEmpty)
    }

    @MainActor @Test func focusFollowsTheDisplayedMainThroughSpeakerHysteresisAndSilence() {
        var clock = 50_000.0
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.now = { clock }
        stage.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        stage.setViewport(StagePoliciesTests.iphone17e)
        let inputs = StageFixtureScript.inputs(for: .spotlight)
        stage.apply(inputs)
        stage.speakerChanged("r3", atMillis: clock)
        #expect(StageReceiveFocusPolicy.focusedUserIds(slots: stage.layout.slots, localUserId: inputs.localUserId) == ["r1"])
        clock += 1_200
        stage.firePendingPromotion()
        #expect(StageReceiveFocusPolicy.focusedUserIds(slots: stage.layout.slots, localUserId: inputs.localUserId) == ["r3"])
        stage.speakerChanged(nil, atMillis: clock)
        #expect(StageReceiveFocusPolicy.focusedUserIds(slots: stage.layout.slots, localUserId: inputs.localUserId) == ["r3"])
        stage.reset()
    }
}
#endif
