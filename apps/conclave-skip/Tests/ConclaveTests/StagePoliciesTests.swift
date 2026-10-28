#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct StagePoliciesTests {

    static let iphoneSE = StageViewport(width: 375, height: 667, insetTop: 76, insetBottom: 64, insetLeading: 0, insetTrailing: 0,
                                        widthClass: StageSizeClass.compact, heightClass: StageSizeClass.regular, placement: .bottomBar)

    static let iphone17e = StageViewport(width: 390, height: 844, insetTop: 103, insetBottom: 98, insetLeading: 0, insetTrailing: 0,
                                         widthClass: StageSizeClass.compact, heightClass: StageSizeClass.regular, placement: .bottomBar)

    static let android360 = StageViewport(width: 360, height: 800, insetTop: 84, insetBottom: 124, insetLeading: 0, insetTrailing: 0,
                                          widthClass: StageSizeClass.compact, heightClass: StageSizeClass.medium, placement: .bottomBar)
    static let androidLandscape = StageViewport(width: 800, height: 360, insetTop: 84, insetBottom: 76, insetLeading: 0, insetTrailing: 48,
                                                widthClass: StageSizeClass.medium, heightClass: StageSizeClass.compact, placement: .bottomBar)
    static let ipadPortrait = StageViewport(width: 820, height: 1180, insetTop: 80, insetBottom: 84, insetLeading: 0, insetTrailing: 0,
                                            widthClass: StageSizeClass.regular, heightClass: StageSizeClass.regular, placement: .bottomBar)
    static let ipadLandscape = StageViewport(width: 1180, height: 820, insetTop: 80, insetBottom: 84, insetLeading: 0, insetTrailing: 0,
                                             widthClass: StageSizeClass.regular, heightClass: StageSizeClass.regular, placement: .bottomBar)
    static let foldUnfolded = StageViewport(width: 673, height: 841, insetTop: 84, insetBottom: 124, insetLeading: 0, insetTrailing: 0,
                                            widthClass: StageSizeClass.medium, heightClass: StageSizeClass.medium, placement: .bottomBar)
    static let allViewports = [iphoneSE, iphone17e, android360, androidLandscape, ipadPortrait, ipadLandscape, foldUnfolded]

    private func presenter(_ inputs: StageInputs, viewport: StageViewport = StagePoliciesTests.iphoneSE) -> StagePresenter {
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.setViewport(viewport)
        stage.apply(inputs)
        return stage
    }

    private func tiled(_ count: Int) -> StageInputs {
        StageFixtureScript.copy(StageFixtureScript.base(count: count), viewMode: "tiled")
    }

    private func personSlots(_ stage: StagePresenter) -> [StageSlot] {
        stage.layout.slots.filter { $0.id.hasPrefix("p:") }
    }

    @Test func capsMatchTheWorkedSizes() {
        #expect(StageLayoutPolicy.gridCap(viewport: Self.iphoneSE, viewMaxTiles: 16) == 6)
        #expect(StageLayoutPolicy.gridCap(viewport: Self.iphone17e, viewMaxTiles: 16) == 8)
        #expect(StageLayoutPolicy.gridCap(viewport: Self.android360, viewMaxTiles: 16) == 8)

        #expect(StageLayoutPolicy.gridCap(viewport: Self.iphone17e, viewMaxTiles: 4) == 4)
        #expect(StageLayoutPolicy.gridCap(viewport: Self.iphone17e, viewMaxTiles: 5) == 4)
        #expect(StageLayoutPolicy.gridCap(viewport: Self.iphoneSE, viewMaxTiles: 2) == 2)

        for viewport in Self.allViewports where StageSizeClass.isCompact(viewport.widthClass) {
            #expect(StageLayoutPolicy.gridCap(viewport: viewport, viewMaxTiles: 49) <= 8)
        }
        #expect(StageLayoutPolicy.gridCap(viewport: Self.ipadPortrait, viewMaxTiles: 49) > 8)
        #expect(StageLayoutPolicy.gridCap(viewport: Self.androidLandscape, viewMaxTiles: 49) <= 8)

        let se = StageLayoutPolicy.contentFrame(Self.iphoneSE)
        #expect(abs(se.height - 511) < 0.001 && abs((se.width - 8) / 2 - 175.5) < 0.001)
        let e17 = StageLayoutPolicy.contentFrame(Self.iphone17e)
        #expect(abs(e17.height - 627) < 0.001 && abs((e17.width - 8) / 2 - 183) < 0.001)
        let android = StageLayoutPolicy.contentFrame(Self.android360)
        #expect(abs(android.height - 576) < 0.001 && abs((android.width - 8) / 2 - 168) < 0.001)
    }

    @Test func capacityAndFramesAgreeAtEverySize() {
        for viewport in Self.allViewports {
            let cap = StageLayoutPolicy.gridCap(viewport: viewport, viewMaxTiles: 16)
            let content = StageLayoutPolicy.contentFrame(viewport)
            let gap = StageLayoutPolicy.gap(viewport)
            for count in 2...16 {
                let stage = presenter(tiled(count), viewport: viewport)
                #expect(stage.layout.kind == .grid)
                let frames = stage.currentFrames()

                #expect(frames.count == stage.layout.slots.count, "\(viewport.width)x\(viewport.height) n=\(count)")
                if count > cap {
                    #expect(stage.layout.slots.count == cap)
                    #expect(stage.layout.overflowCount == count - (cap - 1))
                    #expect(stage.layout.capacity.gridSlots == cap)
                } else {
                    #expect(stage.layout.overflowCount == 0)
                }
                for frame in frames {
                    #expect(frame.x >= content.x - 0.01 && frame.maxX <= content.maxX + 0.01, "\(frame) outside \(content)")
                    #expect(frame.y >= content.y - 0.01 && frame.maxY <= content.maxY + 0.01, "\(frame) outside \(content)")
                    if StageLayoutPolicy.isCompactPortrait(viewport) && count > 2 {
                        let floor = max(100, ((content.width - gap) / 2) * 0.75)
                        #expect(frame.height >= floor - 0.01)
                    }
                }
                for (index, a) in frames.enumerated() {
                    for b in frames[(index + 1)...] {
                        #expect(!StageLayoutPolicy.overlaps(a, b), "\(a.slotId) overlaps \(b.slotId)")
                        if abs(a.y - b.y) < 0.01 && b.x > a.x {

                            #expect(abs(b.x - a.maxX - gap) < 0.01 || b.x - a.maxX > gap)
                        }
                    }
                }
            }
        }
    }

    @Test func grid12ShowsFivePlusSevenOnTheSEAndSevenPlusFiveOn390And360() throws {
        let se = presenter(StageFixtureScript.base(count: 12), viewport: Self.iphoneSE)
        #expect(se.layout.kind == .grid)
        #expect(personSlots(se).count == 5 && se.layout.overflowCount == 7)
        #expect(se.layout.slots.last?.id == StageSlot.overflowId)

        try #require(se.layout.slots.count >= 2)
        #expect(se.layout.slots[se.layout.slots.count - 2].userId == StageFixtureScript.localUserId)
        #expect(se.layout.overflowSeeds.count == 3)
        for viewport in [Self.iphone17e, Self.android360] {
            let stage = presenter(StageFixtureScript.base(count: 12), viewport: viewport)
            #expect(personSlots(stage).count == 7 && stage.layout.overflowCount == 5)
        }
    }

    @Test func oddCompactGridsWidenTheFirstRemote() throws {
        let three = presenter(StageFixtureScript.base(count: 3))
        #expect(three.layout.slots.first?.role == .gridWide)
        #expect(three.layout.slots.last?.userId == StageFixtureScript.localUserId)
        let frames = three.currentFrames()
        let content = StageLayoutPolicy.contentFrame(Self.iphoneSE)
        try #require(!frames.isEmpty)
        #expect(abs(frames[0].width - content.width) < 0.01)
        let four = presenter(StageFixtureScript.base(count: 4))
        #expect(!four.layout.slots.contains { $0.role == .gridWide })

        let landscape = presenter(StageFixtureScript.base(count: 5), viewport: Self.androidLandscape)
        #expect(!landscape.layout.slots.contains { $0.role == .gridWide })
    }

    @Test func soloOneOnOneShareAndActivityFrames() throws {
        let solo = presenter(StageFixtureScript.inputs(for: .soloCameraOff))
        #expect(solo.layout.kind == .solo)
        #expect(solo.currentFrames().first.map { $0.x == 0 && $0.y == 0 && $0.width == 375 && $0.height == 667 } == true)
        #expect(solo.layout.isAloneConfirmed)
        let unconfirmed = presenter(StageFixtureScript.inputs(for: .soloUnconfirmed))
        #expect(!unconfirmed.layout.isAloneConfirmed)
        let oneOnOne = presenter(StageFixtureScript.inputs(for: .oneOnOne))
        #expect(oneOnOne.layout.kind == .oneOnOne)
        #expect(oneOnOne.layout.slots.map(\.role) == [.spotlightMain, .selfFloating])
        let oneOnOneFrames = oneOnOne.currentFrames()
        try #require(oneOnOneFrames.count >= 2)
        let selfFrame = oneOnOneFrames[1]

        #expect(abs(selfFrame.maxX - (375 - 12)) < 0.01 && abs(selfFrame.maxY - (667 - 64 - 12)) < 0.01)
        let share = presenter(StageFixtureScript.inputs(for: .presentation))
        #expect(share.layout.kind == .presentation)
        #expect(share.layout.slots.first?.id == StageSlot.shareId(StageFixtureScript.remoteId(0)))
        #expect(share.layout.slots.first?.fit == .fit)

        try #require(share.layout.slots.count >= 2)
        #expect(share.layout.slots[1].userId == StageFixtureScript.remoteId(0))
        let activity = presenter(StageFixtureScript.inputs(for: .nowPlaying))
        #expect(activity.layout.kind == .game)
        #expect(activity.layout.slots.first?.id == StageSlot.activityId)

        #expect(activity.layout.slots.contains { $0.userId == StageFixtureScript.localUserId && $0.role == .rail })
    }

    @Test func kindChooserFollowsTheWebPrecedence() {
        let base = StageFixtureScript.base(count: 4)
        #expect(StageLayoutPolicy.kind(base, showsVideoOverActivity: false) == .grid)
        #expect(StageLayoutPolicy.kind(StageFixtureScript.base(count: 1), showsVideoOverActivity: false) == .solo)
        #expect(StageLayoutPolicy.kind(StageFixtureScript.base(count: 2), showsVideoOverActivity: false) == .oneOnOne)
        #expect(StageLayoutPolicy.kind(StageFixtureScript.copy(StageFixtureScript.base(count: 2), viewMode: "tiled"),
                                       showsVideoOverActivity: false) == .grid)
        #expect(StageLayoutPolicy.kind(StageFixtureScript.base(count: 13), showsVideoOverActivity: false) == .sidebar)
        #expect(StageLayoutPolicy.kind(StageFixtureScript.base(count: 12), showsVideoOverActivity: false) == .grid)
        #expect(StageLayoutPolicy.kind(StageFixtureScript.copy(base, viewMode: "spotlight"), showsVideoOverActivity: false) == .spotlight)
        #expect(StageLayoutPolicy.kind(StageFixtureScript.copy(base, viewMode: "sidebar"), showsVideoOverActivity: false) == .sidebar)

        let sharing = StageFixtureScript.copy(base, screenShareUserId: "r1")
        #expect(StageLayoutPolicy.kind(sharing, showsVideoOverActivity: false) == .presentation)
        #expect(StageLayoutPolicy.kind(StageFixtureScript.copy(sharing, pinnedUserId: "r2"), showsVideoOverActivity: false) == .spotlight)

        #expect(StageLayoutPolicy.kind(StageFixtureScript.copy(base, pinnedUserId: "gone"), showsVideoOverActivity: false) == .grid)

        let game = StageFixtureScript.copy(sharing, isGameActive: true)
        #expect(StageLayoutPolicy.kind(game, showsVideoOverActivity: false) == .game)
        #expect(StageLayoutPolicy.kind(game, showsVideoOverActivity: true) == .presentation)
        let attendee = StageInputs.make(isWebinarAttendee: true)
        #expect(StageLayoutPolicy.kind(attendee, showsVideoOverActivity: false) == .attendeeWaiting)
        #expect(StageLayoutPolicy.kind(StageInputs.make(isWebinarAttendee: true, webinarSpeakerUserId: "host"),
                                       showsVideoOverActivity: false) == .attendeeLive)
    }

    @Test func joinOrderIsStableYouLastAndAJoinNeverMovesAVisibleSlot() {
        let roster = [
            StageParticipantInput.make(userId: "zed", joinSerial: 2),
            StageParticipantInput.make(userId: "amy", joinSerial: 3),
            StageParticipantInput.make(userId: "you", isLocal: true),
            StageParticipantInput.make(userId: "bo", joinSerial: 1),
            StageParticipantInput.make(userId: "new", joinSerial: 0),
        ]

        #expect(StageOrderPolicy.joinOrder(roster) == ["bo", "zed", "amy", "new"])
        #expect(StageOrderPolicy.reconcile(previous: ["amy", "bo"], participants: roster) == ["amy", "bo", "zed", "new"])
        #expect(StageOrderPolicy.swapped(["a", "b", "c"], promote: "c", demote: "a") == ["c", "b", "a"])
        let stage = presenter(StageFixtureScript.base(count: 4))
        let before = personSlots(stage).map(\.userId)
        #expect(before == ["r1", "r2", "r3", "you"])
        var next = StageFixtureScript.base(count: 4).participants
        next.append(StageParticipantInput.make(userId: "r9", displayName: "Late", isCameraOff: false, joinSerial: 9, videoKey: "probe:r9"))
        stage.apply(StageFixtureScript.copy(StageFixtureScript.base(count: 4), participants: next))
        #expect(personSlots(stage).map(\.userId) == ["r1", "r2", "r3", "r9", "you"])

        stage.apply(StageFixtureScript.copy(StageFixtureScript.base(count: 4), participants: next.filter { $0.userId != "r2" }))
        #expect(personSlots(stage).map(\.userId) == ["r1", "r3", "r9", "you"])
    }

    @Test func selfViewRulesPortedFromTheLegacyVisibilityContext() {
        #expect(StageOrderPolicy.selfRole(selfViewMode: "auto", kind: .oneOnOne) == .selfFloating)
        #expect(StageOrderPolicy.selfRole(selfViewMode: "auto", kind: .grid) == nil)
        #expect(StageOrderPolicy.selfRole(selfViewMode: "floating", kind: .grid) == .selfFloating)
        #expect(StageOrderPolicy.selfRole(selfViewMode: "minimized", kind: .spotlight) == .selfMinimized)
        #expect(StageOrderPolicy.selfRole(selfViewMode: "tile", kind: .oneOnOne) == nil)
        for kind in [StageKind.game, .app, .browser, .solo, .attendeeLive, .attendeeWaiting] {
            #expect(StageOrderPolicy.selfRole(selfViewMode: "floating", kind: kind) == nil)
        }
    }

    @Test func speakerChangesInAFittingGridOnlyLightTheRing() {
        let stage = presenter(StageFixtureScript.inputs(for: .grid6))
        let layout = stage.layout
        let capsule = stage.capsule
        let chrome = stage.chrome
        let entries = personSlots(stage).map { stage.tileChrome.entry(for: $0.userId).model }
        var at = 1_000.0
        for id in StageFixtureScript.speakerScript(for: .grid6) {
            stage.speakerChanged(id, atMillis: at)
            at += 300
            #expect(stage.speaking.isSpeaking(id))
        }
        #expect(StageFixtureScript.speakerScript(for: .grid6).count == 20)
        #expect(stage.layout == layout)
        #expect(stage.capsule == capsule && stage.chrome == chrome)
        #expect(personSlots(stage).map { stage.tileChrome.entry(for: $0.userId).model } == entries)
        #expect(stage.promotionTasksStarted == 0 && !stage.hasLivePromotionTask)

        let speaking = personSlots(stage).filter { stage.speaking.isSpeaking($0.userId) }
        #expect(speaking.count == 1)
    }

    @Test func overflowPromotionWaitsOneTwoSecondsAndSwapsAtMostOncePerEightSeconds() {
        var clock = 10_000.0
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.now = { clock }
        stage.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        stage.setViewport(Self.iphoneSE)
        stage.apply(StageFixtureScript.base(count: 12))
        let hidden = StageFixtureScript.hiddenSpeaker(for: .grid12)
        #expect(!StageOrderPolicy.visibleRemoteIds(stage.layout.slots, localUserId: "you").contains(hidden))
        let revision = stage.layout.revision
        stage.speakerChanged(hidden, atMillis: clock)
        #expect(stage.pendingPromotionCandidate == hidden)
        #expect(abs(stage.pendingPromotionDelayMillis - 1_200) < 0.001)
        #expect(stage.hasLivePromotionTask)
        #expect(stage.layout.revision == revision)

        clock += 600
        stage.firePendingPromotion()
        #expect(stage.layout.revision == revision)
        clock += 600
        stage.firePendingPromotion()
        #expect(stage.layout.revision == revision + 1)
        #expect(StageOrderPolicy.visibleRemoteIds(stage.layout.slots, localUserId: "you").contains(hidden))

        let another = StageFixtureScript.remoteId(9)
        #expect(!StageOrderPolicy.visibleRemoteIds(stage.layout.slots, localUserId: "you").contains(another))
        clock += 100
        stage.speakerChanged(another, atMillis: clock)
        #expect(abs(stage.pendingPromotionDelayMillis - 7_900) < 0.001)
        clock += 7_000
        stage.firePendingPromotion()
        #expect(stage.layout.revision == revision + 1)
        clock += 900
        stage.firePendingPromotion()
        #expect(stage.layout.revision == revision + 2)

        let small = StagePresenter(shell: MeetingShellPresenter())
        small.setViewport(Self.iphoneSE)
        small.apply(StageFixtureScript.base(count: 3))
        small.speakerChanged("r1", atMillis: clock)
        #expect(small.pendingPromotionCandidate.isEmpty && !small.hasLivePromotionTask)
        stage.reset()
        #expect(!stage.hasLivePromotionTask)
    }

    @Test func spotlightFeaturedSpeakerHasHysteresis() {
        var clock = 50_000.0
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.now = { clock }
        stage.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        stage.setViewport(Self.iphone17e)
        stage.apply(StageFixtureScript.inputs(for: .spotlight))
        #expect(stage.layout.kind == .spotlight)
        #expect(stage.layout.featuredUserId == "r1")
        let revision = stage.layout.revision
        stage.speakerChanged("r3", atMillis: clock)
        clock += 1_199
        stage.firePendingPromotion()
        #expect(stage.layout.revision == revision)
        clock += 1
        stage.firePendingPromotion()
        #expect(stage.layout.featuredUserId == "r3" && stage.layout.revision == revision + 1)
        #expect(stage.layout.slots.first?.userId == "r3" && stage.layout.slots.first?.role == .spotlightMain)
        stage.speakerChanged("r4", atMillis: clock)
        clock += 7_999
        stage.firePendingPromotion()
        #expect(stage.layout.featuredUserId == "r3")
        clock += 1
        stage.firePendingPromotion()
        #expect(stage.layout.featuredUserId == "r4")

        stage.apply(StageFixtureScript.copy(StageFixtureScript.inputs(for: .spotlight), pinnedUserId: "r2"))
        stage.speakerChanged("r5", atMillis: clock)
        #expect(stage.pendingPromotionCandidate.isEmpty)
        stage.reset()
        #expect(!stage.hasLivePromotionTask)
    }

    @Test func resetAndANewCallSessionLeaveNoTaskAndNoStaleStores() {
        let stage = presenter(StageFixtureScript.base(count: 12))
        stage.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        stage.speakerChanged(StageFixtureScript.hiddenSpeaker(for: .grid12), atMillis: stage.now())
        stage.setTransientChrome(id: ChromeAutoHidePolicy.moreSheet, open: true)
        #expect(stage.hasLivePromotionTask)
        #expect(stage.tileChrome.count == 12)
        let next = StageInputs.make(callSession: 2, isInCall: true, localUserId: "you", roomLabel: "next",
                                    participants: StageFixtureScript.roster(count: 2))
        stage.apply(next)
        #expect(!stage.hasLivePromotionTask)
        #expect(stage.tileChrome.count == 2)
        #expect(stage.transientChromeSummary == "none")
        stage.reset()
        #expect(!stage.hasLivePromotionTask && stage.tileChrome.count == 0 && stage.bindings.count == 0)
        #expect(stage.layout.slots.isEmpty)
    }

    @Test func rolesSweepKeepsOneSlotIdForYourRenderer() {
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.setViewport(Self.iphone17e)
        var roles: [StageSlotRole] = []
        for step in 0..<StageFixtureScript.rolesSweepStepCount {
            stage.apply(StageFixtureScript.rolesSweepStep(step))
            let mine = stage.layout.slots.filter { $0.userId == StageFixtureScript.localUserId && $0.id.hasPrefix("p:") }
            #expect(mine.count == 1)
            #expect(mine.first?.id == StageSlot.participantId(StageFixtureScript.localUserId))
            if let role = mine.first?.role { roles.append(role) }
        }
        #expect(roles == [.grid, .rail, .spotlightMain, .selfFloating, .selfMinimized])
    }

    @Test func tileWritesAreScopedAndBindingSwapsPublishNoLayout() throws {
        let stage = presenter(StageFixtureScript.inputs(for: .grid6))
        let r2 = stage.tileChrome.entry(for: "r2")
        let r3Before = stage.tileChrome.entry(for: "r3").model
        let revision = stage.layout.revision
        var rows = StageFixtureScript.inputs(for: .grid6).participants
        let index = try #require(rows.firstIndex(where: { $0.userId == "r2" }))
        let old = rows[index]
        rows[index] = StageParticipantInput.make(userId: old.userId, displayName: old.displayName, isMuted: !old.isMuted,
                                                 isCameraOff: old.isCameraOff, joinSerial: old.joinSerial, videoKey: old.videoKey)
        stage.apply(StageFixtureScript.copy(StageFixtureScript.inputs(for: .grid6), participants: rows))

        #expect(stage.tileChrome.entry(for: "r2") === r2)
        #expect(r2.model.isMuted == !old.isMuted)
        #expect(stage.tileChrome.entry(for: "r3").model == r3Before)
        #expect(stage.layout.revision == revision)

        let binding = stage.bindings.binding(for: StageSlot.participantId("r2"))
        #expect(binding.videoKey == "probe:r2")
        rows[index] = StageParticipantInput.make(userId: old.userId, displayName: old.displayName, isMuted: !old.isMuted,
                                                 isCameraOff: old.isCameraOff, joinSerial: old.joinSerial, videoKey: "consumer-2")
        let r2Model = r2.model
        stage.apply(StageFixtureScript.copy(StageFixtureScript.inputs(for: .grid6), participants: rows))
        #expect(stage.bindings.binding(for: StageSlot.participantId("r2")) === binding)
        #expect(binding.videoKey == "consumer-2")
        #expect(stage.layout.revision == revision)
        #expect(r2.model == r2Model)
    }

    @Test func fitOverridesSurviveKindChangesAndClearOnReset() {

        let stage = presenter(StageFixtureScript.inputs(for: .grid6))
        stage.setFit(.fit, userId: "r1")
        #expect(stage.layout.slots.first { $0.userId == "r1" }?.fit == .fit)
        stage.apply(StageFixtureScript.inputs(for: .spotlight))
        #expect(stage.layout.slots.first { $0.id == "p:r1" }?.fit == .fit)
        stage.reset()
        stage.apply(StageFixtureScript.inputs(for: .grid6))
        #expect(stage.layout.slots.first { $0.userId == "r1" }?.fit == .fill)
    }

    @Test func capsuleSubtitleHandAndChromeSnapshots() {
        let grid = presenter(StageFixtureScript.inputs(for: .grid6LockedCaptions))
        #expect(grid.capsule.subtitleKind == StageCapsuleModel.countKind && grid.capsule.count == 6)
        #expect(grid.capsule.isLocked && grid.capsule.captionsOn && grid.capsule.title == StageFixtureScript.roomLabel)
        #expect(presenter(StageFixtureScript.inputs(for: .soloCameraOff)).capsule.subtitleKind == StageCapsuleModel.aloneKind)
        let share = presenter(StageFixtureScript.inputs(for: .presentation))
        #expect(share.capsule.subtitleKind == StageCapsuleModel.presentingKind && share.capsule.subtitleName == "Avery")
        let local = presenter(StageInputs.make(callSession: 1, localUserId: "you",
                                               participants: StageFixtureScript.roster(count: 3), isLocalScreenSharing: true))
        #expect(local.capsule.subtitleKind == StageCapsuleModel.youPresentingKind)

        #expect(StagePresenter.handState(isRaised: false, inFlight: true) == .raising)
        #expect(StagePresenter.handState(isRaised: true, inFlight: false) == .raised)
        #expect(StagePresenter.handState(isRaised: true, inFlight: true) == .lowering)
        #expect(StagePresenter.handState(isRaised: false, inFlight: false) == .lowered)
        #expect(presenter(StageFixtureScript.inputs(for: .handRaising)).localHand == .raising)

        #expect(!grid.chrome.canFlipCamera)
        #expect(presenter(StageFixtureScript.inputs(for: .oneOnOne)).chrome.canFlipCamera)
        let playing = presenter(StageFixtureScript.inputs(for: .nowPlaying))
        #expect(playing.chrome.nowPlaying == nil)
        playing.setShowsVideoOverActivity(true)
        #expect(playing.chrome.nowPlaying == NowPlayingChip(kind: "game", name: "Trivia"))
        #expect(playing.layout.hiddenActivityKind == "game" && playing.layout.kind == .grid)
        playing.showHiddenActivity()
        #expect(playing.chrome.nowPlaying == nil && playing.layout.kind == .game)
    }

    @Test func entryAnnouncementPostsOncePerCallSession() {
        let stage = presenter(StageFixtureScript.inputs(for: .grid6))
        #expect(stage.announcement?.kind == StageAnnouncement.joinedKind)
        #expect(stage.announcement?.name == StageFixtureScript.roomLabel)
        let id = stage.announcement?.id
        for _ in 0..<20 {
            stage.apply(StageFixtureScript.inputs(for: .grid8))
        }
        #expect(stage.announcement?.id == id)
        #expect(stage.announcementLog == ["joined:" + StageFixtureScript.roomLabel])
    }

    @Test func stageOutcomeTokensAndTheOwnershipTable() throws {
        let stage = presenter(StageFixtureScript.inputs(for: .grid4))
        let start = stage.feedbackState.token.sequence
        stage.apply(StageFixtureScript.inputs(for: .nowPlaying))
        #expect(stage.feedbackState.token.kind == .gameStarted && stage.feedbackState.token.sequence == start + 1)
        stage.apply(StageFixtureScript.inputs(for: .nowPlaying))
        #expect(stage.feedbackState.token.sequence == start + 1)
        stage.apply(StageFixtureScript.copy(StageFixtureScript.inputs(for: .grid4), liveNotes: .live))
        #expect(stage.feedbackState.token.kind == .transcriptionStarted)
        stage.apply(StageFixtureScript.copy(StageFixtureScript.inputs(for: .grid4), liveNotes: .paused))
        #expect(stage.feedbackState.token.kind == .transcriptionStopped)

        let stageKinds: [FeedbackKind] = [.hostMutedYou, .cameraOffByHost, .handLoweredByHost, .becameHost, .lostHost, .shareStarted,
                                          .shareStopped, .shareStoppedBySystem, .transcriptionStarted, .transcriptionStopped, .gameStarted]
        let shellKinds: [FeedbackKind] = [.joined, .admitted, .connectionLost, .joinFailed, .denied, .removed, .connectionRestored, .actionRejected]
        #expect(Set(stageKinds).isDisjoint(with: Set(shellKinds)))
        for kind in stageKinds { #expect(kind.isAsyncOutcome) }
        for file in ["Sources/Conclave/Core/Session/MeetingShellPresenter.swift", "Sources/Conclave/Core/Session/MeetingSessionPolicies.swift"] {
            let text = try stageSource(file)
            for kind in stageKinds {
                #expect(!text.contains("." + kind.rawValue + ")") && !text.contains("." + kind.rawValue + "\n"), "\(file) publishes \(kind)")
            }
        }
        let presenterSource = try stageSource("Sources/Conclave/Features/Meeting/Stage/StagePresenter.swift")
        for kind in shellKinds {
            #expect(!presenterSource.contains("FeedbackKind." + kind.rawValue), "the stage publishes the shell kind \(kind)")
        }
    }

    @Test func reactionsKeepStableIdsAndFollowTheRenderLimits() {
        #expect(StageReactionPolicy.renderLimit(participantCount: 19) == 20)
        #expect(StageReactionPolicy.renderLimit(participantCount: 20) == 12)
        #expect(StageReactionPolicy.renderLimit(participantCount: 35) == 12)
        #expect(StageReactionPolicy.renderLimit(participantCount: 36) == 8)
        let six = presenter(StageFixtureScript.inputs(for: .reactionsBurst25))
        six.reactionsChanged(StageFixtureScript.reactions(count: 25))
        #expect(StageReactionPolicy.visibleEvents(six.reactions).count == 20)
        let forty = presenter(StageFixtureScript.inputs(for: .reactionsBurst40), viewport: Self.ipadPortrait)
        forty.reactionsChanged(StageFixtureScript.reactions(count: 25))
        #expect(StageReactionPolicy.visibleEvents(forty.reactions).count == 8)
        let ids = six.reactions.events.map(\.id)
        let revision = six.reactions.revision
        six.reactionsChanged(StageFixtureScript.reactions(count: 25))
        #expect(six.reactions.events.map(\.id) == ids && six.reactions.revision == revision)

        six.reactionsChanged(StageFixtureScript.reactions(count: 40))
        #expect(six.reactions.events.count == MeetingReactionConstants.maxActiveReactions)
        #expect(six.layout.revision == presenter(StageFixtureScript.inputs(for: .reactionsBurst25)).layout.revision)
    }

    @Test func visibilityCountsOnlyVisibleUncoveredRendererSlots() {
        let stage = presenter(StageFixtureScript.inputs(for: .grid12))
        let frames = stage.currentFrames()
        let report = StageVisibilityPolicy.report(frames: frames, slots: stage.layout.slots, viewport: Self.iphoneSE, kind: .grid,
                                                  coverage: "none", chromeHidden: false, isInPip: false, pipTarget: nil)
        #expect(report.visibleUserIds.count == 5)
        #expect(!report.visibleUserIds.contains(StageFixtureScript.hiddenSpeaker(for: .grid12)))
        let covered = StageVisibilityPolicy.report(frames: frames, slots: stage.layout.slots, viewport: Self.iphoneSE, kind: .grid,
                                                   coverage: "full", chromeHidden: false, isInPip: false, pipTarget: nil)
        #expect(covered.visibleUserIds.isEmpty && covered.coverage == "full")
        let target = PipTargetFrame(slotId: "p:r1", left: 0, top: 0, right: 100, bottom: 100, videoWidth: 0, videoHeight: 0)
        let pip = StageVisibilityPolicy.report(frames: frames, slots: stage.layout.slots, viewport: Self.iphoneSE, kind: .grid,
                                               coverage: "none", chromeHidden: false, isInPip: true, pipTarget: target)
        #expect(pip.visibleUserIds == ["r1"])

        let minimized = presenter(StageFixtureScript.rolesSweepStep(4), viewport: Self.iphone17e)
        let mini = StageVisibilityPolicy.report(frames: minimized.currentFrames(), slots: minimized.layout.slots, viewport: Self.iphone17e,
                                                kind: minimized.layout.kind, coverage: "none", chromeHidden: false, isInPip: false, pipTarget: nil)
        #expect(!mini.visibleUserIds.contains("you"))

        var calls = 0
        stage.onVisibilityChanged = { _ in calls += 1 }
        stage.reportVisibility(report)
        stage.reportVisibility(report)
        #expect(calls == 1)
    }

    @Test func hiddenCameraOffSpeakerKeepsTheirTileAndStaysAudible() {

        let stage = presenter(StageFixtureScript.inputs(for: .hideTiles))
        #expect(!personSlots(stage).contains { $0.userId == "r2" } && !personSlots(stage).contains { $0.userId == "r3" })
        stage.speakerChanged("r2", atMillis: 1_000)
        #expect(personSlots(stage).contains { $0.userId == "r2" })
        #expect(!personSlots(stage).contains { $0.userId == "r3" })
        let report = StageVisibilityPolicy.report(frames: stage.currentFrames(), slots: stage.layout.slots, viewport: Self.iphoneSE,
                                                  kind: stage.layout.kind, coverage: "none", chromeHidden: false, isInPip: false,
                                                  pipTarget: nil)

        let client = FakeStageConsumerClient(consumers: [
            StageConsumerInput(consumerId: "a-r2", userId: "r2", kind: .audio, isPaused: false),
            StageConsumerInput(consumerId: "a-r3", userId: "r3", kind: .audio, isPaused: false),
            StageConsumerInput(consumerId: "a-r5", userId: "r5", kind: .audio, isPaused: false),
            StageConsumerInput(consumerId: "v-r1", userId: "r1", kind: .video, isPaused: false),
            StageConsumerInput(consumerId: "v-r9", userId: "r9", kind: .video, isPaused: false),
        ])
        client.apply(StageConsumerVisibilityPolicy.decisions(consumers: client.consumers, report: report, receiveVideo: true))
        #expect(client.pausedAudio.isEmpty, "audio paused: \(client.pausedAudio)")
        #expect(client.paused == ["v-r9"])

        for receive in [true, false] {
            for coverage in ["none", "partial", "full"] {
                let other = StageVisibilityReport(visibleUserIds: [], visibleShareUserId: "", coverage: coverage, isInPip: false, pipTarget: nil)
                let decisions = StageConsumerVisibilityPolicy.decisions(consumers: client.consumers, report: other, receiveVideo: receive)
                for decision in decisions where decision.kind == .audio {
                    #expect(decision.action == .keep)
                }
            }
        }
        #expect(StageConsumerVisibilityPolicy.visibleVideoUserIds(report).contains("r2"))
    }

    @Test func bothMediaClientsLimitTheVisibilityPolicyToWebcamVideo() throws {

        let ios = stageNormalized(try stageSource("Sources/Conclave/Core/WebRTC/WebRTCClient.swift"))
        #expect(ios.contains("guard var info = consumers[consumerId], info.kind == \"video\", info.type == ProducerType.webcam.rawValue else { continue }"))
        let android = stageNormalized(try stageSource("Sources/Conclave/Skip/WebRTCClient+Android.kt"))
        #expect(android.contains("if (info.kind != \"video\" || info.type != ProducerType.webcam.rawValue) continue"))
    }

    @Test func everyFixtureStateBuildsAndMagicTapCountsOnce() {
        for state in StageFixtureState.allCases {
            let session = StageFixtureSession(state: state)

            let recovers = state == StageFixtureState.recovering || state == StageFixtureState.meetingInfoRecovering
                || state == StageFixtureState.activitiesRecovering || state == StageFixtureState.browserReconnecting
            #expect(session.shell.session.phase == (recovers ? MeetingPhaseKind.recovering : MeetingPhaseKind.inCall), "\(state.rawValue)")
            #expect(StageFixtureScript.state(named: state.rawValue) == state)
        }
        let session = StageFixtureSession(state: .grid6)
        session.magicTap()

        #expect(session.counters.toggleMicrophone == 1)
        session.minimize()
        #expect(session.counters.minimize == 1 && session.counters.leave == 0)
        #expect(session.countersReadout().hasPrefix("toggleMicrophone=1 minimize=1 leave=0"))
        #expect(StageFixtureScript.pattern(named: nil) == .staticPattern)
        #expect(StageFixtureScript.pattern(named: "live") == .livePattern)
        #expect(RendererProbePattern.allCases.map(\.rawValue) == ["none", "static", "live"])

        session.stage.togglePin(userId: "r2")
        #expect(session.stage.layout.kind == .spotlight && session.stage.layout.pinnedUserId == "r2")
        #expect(session.panelReadout() == "none")
        session.stage.openPeople(destination: .none)
        #expect(session.panelReadout() == "panel=participants invoker=call destination=none")
    }

    @Test func rendererLedgerBalancesAcrossTwentyCycles() {

        let ledger = RendererIdentityLedger()
        let keep = ledger.created(key: "p:r1", slot: .stage)
        for cycle in 0..<20 {
            let serial = ledger.created(key: "p:r" + String(cycle % 3 + 2), slot: .stage)
            ledger.released(key: "p:r" + String(cycle % 3 + 2), serial: serial, slot: .stage)
        }
        #expect(ledger.counts(.stage).live == 1)
        #expect(ledger.counts(.stage).created == 21 && ledger.counts(.stage).released == 20)
        #expect(ledger.serial(for: "p:r1") == keep)
    }

    @Test func stageSourcesStayFlatDashFreeAndOffTheCore() throws {
        let files = try stageFiles(under: "Sources/Conclave/Features/Meeting/Stage", extensions: ["swift"])
            + stageFiles(under: "Sources/Conclave/Skip/ui/call/stage", extensions: ["kt"])
            + ["Sources/Conclave/App/Hosting/RendererProbe+iOS.swift", "Sources/Conclave/Skip/ui/hosting/RendererProbe.kt",
               "Sources/Conclave/Skip/VideoRenderer.kt"]
        #expect(files.count >= 20)
        for file in files {
            let text = try stageSource(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file) mentions a gradient")
            for pattern in ["glassEffect", "GlassEffectContainer(", "ultraThinMaterial", "regularMaterial", "preferredColorScheme(.dark)",
                            "announceForAccessibility", "@Stable", "@Immutable", "FloatingToolbar", "ButtonGroup",
                            "dynamicLightColorScheme", "dynamicDarkColorScheme", "LazyVGrid", "LazyVerticalGrid", "ScrollView",
                            "HapticManager", "MeetingShare."] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
            #expect(stageMatches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x)"#, in: text).isEmpty, "\(file) builds a color from a literal")
            #expect(stageMatches(#"Color\(0x"#, in: text).isEmpty, "\(file) builds a color from a literal")

            if !file.hasSuffix("StageLiveRenderers+iOS.swift") && !file.hasSuffix("SlotView.kt") {
                #expect(!text.contains("MeetingViewModel.shared"), "\(file) reads the view model")
            }
        }

        for file in try stageFiles(under: "Sources/Conclave/Features/Meeting/Stage", extensions: ["swift"]) where !file.contains("+iOS") {
            let text = try stageSource(file)
            #expect(!text.contains("#if"), "\(file) is shared and must not branch by platform")
            #expect(stageMatches(#"\bprotocol\s"#, in: text).isEmpty, "\(file) declares a protocol")
            #expect(stageMatches(#"case\s+\w+\("#, in: text).isEmpty, "\(file) has an associated value")
            #expect(stageMatches(#"\.(map|compactMap|flatMap)\(\w+(\.init)?\)"#, in: text).isEmpty, "\(file) maps with a function reference")
            #expect(!text.contains("inout "), "\(file) uses inout")
            #expect(!text.contains("isLetter"), "\(file) uses Character.isLetter")
        }
    }

    @Test func iosCallRootIsOneContainerWithMagicTapAndSiblingLayers() throws {
        let root = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/CallRoot+iOS.swift"))
        #expect(root.contains(".accessibilityAction(.magicTap) { shell.toggleMicrophone() }"))
        #expect(root.contains(".accessibilityElement(children: .contain)"))
        #expect(root.contains("ZStack { StageCanvas(stage: stage, renderers: renderers, chrome: chromeVisibility)"))
        #expect(root.contains(".conclaveCallAppearance()") && root.contains(".environment(\\.colorScheme, .dark)"))
        #expect(root.contains("NativePanelInspectorHost(coordinator: shell.panels") && root.contains("NativePanelSheetHost(coordinator: shell.panels"))

        let body = try #require(root.range(of: "var body: some View {"))
        let end = try #require(root.range(of: "struct CallPanelContent: View {", range: body.upperBound..<root.endIndex))
        let rootBody = String(root[body.upperBound..<end.lowerBound])
        for read in ["stage.layout", "stage.kind", "chromeVisibility.state", "stage.capsule", "stage.autoHideBlocker"] {
            #expect(!rootBody.contains(read), "the root body reads \(read)")
        }
        let canvas = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/StageCanvas+iOS.swift"))
        #expect(canvas.contains("struct StageSlotLayout: Layout"))
        #expect(canvas.contains(".layoutValue(key: StageSlotIdKey.self, value: slot.id)"))
        #expect(canvas.contains("stage.setViewport(next)") && canvas.contains("StageViewportPolicy.iOS("))
        #expect(canvas.contains(".frame(width: CGFloat(viewport.width), height: CGFloat(viewport.height))"))
        #expect(canvas.contains(".accessibilityRotor(Text(ConclaveStrings.text(\"Raised Hands\")))"))
        #expect(canvas.contains(".accessibilityRotor(Text(ConclaveStrings.text(\"Speaking\")))"))
        let slot = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/SlotView+iOS.swift"))

        #expect(slot.components(separatedBy: "ConclaveTileChrome(").count - 1 == 1)
        #expect(slot.contains(".transaction { transaction in transaction.animation = nil } .accessibilityHidden(true) .accessibilityIgnoresInvertColors()"))
        #expect(slot.contains(".opacity(slot.role == .selfMinimized ? 0 : 1)"))
        #expect(slot.contains("ShareLink(item: url") && slot.contains("UIPasteboard.general.url = url"))
        #expect(slot.contains(".conclaveGestureFeedback(.linkCopied, trigger: copies)"))
    }

    @Test func androidCallRootKeysRenderersAndMinimizesOnBack() throws {
        let root = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/CallRoot.kt"))
        #expect(root.contains("HostingTheme(inCall = true) {"))
        #expect(root.contains("BackHandler(enabled = panels.current == null) { onMinimize() }"))
        #expect(root.contains("NativePanelHost( panels = shell.panels,"))
        #expect(root.contains("liveRegion = LiveRegionMode.Polite"))
        #expect(root.contains("if (covered) hideFromAccessibility()"))
        let canvas = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/StageCanvas.kt"))
        #expect(canvas.contains("key(slot.id) {") && canvas.contains("placeRelative(x, y)"))

        #expect(canvas.contains("SideEffect { if (!inPip) stage.setViewport(viewport) }"))
        let slot = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/SlotView.kt"))
        #expect(slot.contains("rendererKey = \"stage:$slotId\", clearBeforeAttach = false"))
        #expect(slot.contains("graphicsLayer { alpha = if (minimized) 0f else 1f }"))
        #expect(slot.contains("putExtra(Intent.EXTRA_TITLE, roomLabel)") && slot.contains("Intent.createChooser(intent, null)"))
        let renderer = stageNormalized(try stageSource("Sources/Conclave/Skip/VideoRenderer.kt"))

        #expect(renderer.contains("val ledger = LocalRendererLedger.current"))
        #expect(renderer.contains("attachIdentity(ledger, rendererLifecycleKey.toString())"))
        #expect(renderer.contains("renderer.releaseIdentity()"))
        let onFrame = try #require(renderer.range(of: "override fun onFrame(frame: VideoFrame) {"))
        let onFrameEnd = try #require(renderer.range(of: "override fun onSurfaceTextureAvailable", range: onFrame.upperBound..<renderer.endIndex))
        let frameBody = String(renderer[onFrame.upperBound..<onFrameEnd.lowerBound])
        #expect(!frameBody.contains("removeSink") && !frameBody.contains("addSink") && !frameBody.contains("ledger"))
    }

    @Test func rendererProbesDrawFlatPatternsAndStayCounted() throws {
        let ios = try stageSource("Sources/Conclave/App/Hosting/RendererProbe+iOS.swift")
        #expect(ios.hasPrefix("#if DEBUG && os(iOS) && !SKIP\n"))
        #expect(ios.contains("CADisplayLink") && ios.contains("DesignTokens.avatarPalette"))
        #expect(ios.contains("func updateUIView(_ uiView: RendererProbeView, context: Context) {}"))
        #expect(!ios.contains("Timer") && !ios.contains("RTCVideoTrack"))
        let android = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/hosting/RendererProbe.kt"))
        #expect(android.contains("val canvas = lockCanvas() ?: return"))
        #expect(android.contains("RendererProbePattern.staticPattern -> drawPattern()"))
        #expect(android.contains("mainHandler.removeCallbacks(liveStep)"))
        #expect(android.contains("isOpaque = true setLayerType(LAYER_TYPE_HARDWARE, null)"))
    }
}

#if os(macOS)

@MainActor
@Suite(.serialized)
struct StageViewModelWiringTests {
    private func makeJoinedViewModel() -> MeetingViewModel {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        return viewModel
    }

    @Test func everyStageFieldRefreshesTheStageExactlyOnceAndShellOnlyFieldsNever() {
        let viewModel = makeJoinedViewModel()
        let state = viewModel.state
        func refreshesOnce(_ name: String, _ change: () -> Void) {
            let before = viewModel.stageRefreshCount
            change()
            #expect(viewModel.stageRefreshCount == before + 1, "\(name) refreshed \(viewModel.stageRefreshCount - before) times")
            #expect(viewModel.stage.inputs == viewModel.makeStageInputs(), "\(name) left stale stage inputs")
        }
        func refreshesNever(_ name: String, _ change: () -> Void) {
            let before = viewModel.stageRefreshCount
            change()
            #expect(viewModel.stageRefreshCount == before, "\(name) refreshed the stage")
        }
        refreshesOnce("isRecoveringConnection") { state.isRecoveringConnection = true }
        refreshesOnce("isResumingFromBackground") { state.isResumingFromBackground = true }
        refreshesOnce("serverRestartNotice") { state.serverRestartNotice = "Restarting" }
        refreshesOnce("adminNoticeMessage") { state.adminNoticeMessage = "Notice" }
        refreshesOnce("isNetworkOffline") { state.isNetworkOffline = true }
        refreshesOnce("roomId") { state.roomId = "room-b" }
        refreshesOnce("isRoomLocked") { state.isRoomLocked = true }
        refreshesOnce("meetingRequiresInviteCode") { state.meetingRequiresInviteCode = true }
        refreshesOnce("isWebinarEnabled") { state.isWebinarEnabled = true }
        refreshesOnce("isWebinarPublicAccess") { state.isWebinarPublicAccess = true }
        refreshesOnce("webinarAttendeeCount") { state.webinarAttendeeCount = 3 }
        refreshesOnce("webinarLinkURL") { state.webinarLinkURL = "https://example.com/w" }
        refreshesOnce("webinarFeedMode") { state.webinarFeedMode = "manual" }
        refreshesOnce("webinarSpeakerUserId") { state.webinarSpeakerUserId = "host@example.com" }
        refreshesOnce("isAdmin") { state.isAdmin = true }
        refreshesOnce("hostUserIds") { state.hostUserIds = ["local@example.com#local-session"] }
        refreshesOnce("displayName") { state.displayName = "Robin" }
        refreshesOnce("participants") { state.participants["r@example.com#r"] = Participant(id: "r@example.com#r", isCameraOff: false) }
        refreshesOnce("displayNames") { state.displayNames["r@example.com#r"] = "Rae" }
        refreshesOnce("pendingUsers") { state.pendingUsers["p@example.com#p"] = "Pat" }
        refreshesOnce("hasInitialPresenceSnapshot") { state.hasInitialPresenceSnapshot = true }
        refreshesOnce("isMuted") { state.isMuted = false }
        refreshesOnce("isCameraOff") { state.isCameraOff = false }
        refreshesOnce("isAudioOnlyMode") { state.isAudioOnlyMode = true }
        refreshesOnce("isScreenSharing") { state.isScreenSharing = true }
        refreshesOnce("isHandRaised") { state.isHandRaised = true }
        refreshesOnce("connectionQuality") { state.connectionQuality = .poor }
        refreshesOnce("isBrowserActive") { state.isBrowserActive = true }
        refreshesOnce("activeAppId") { state.activeAppId = "wheel" }
        refreshesOnce("activeScreenShareUserId") { state.activeScreenShareUserId = "r@example.com#r" }
        refreshesOnce("pinnedUserId") { state.pinnedUserId = "r@example.com#r" }
        refreshesOnce("viewMode") { state.viewMode = .tiled }
        refreshesOnce("viewMaxTiles") { state.viewMaxTiles = 9 }
        refreshesOnce("hideTilesWithoutVideo") { state.hideTilesWithoutVideo = true }
        refreshesOnce("selfViewMode") { state.selfViewMode = .floating }
        refreshesOnce("selfViewCorner") { state.selfViewCorner = .topLeft }

        refreshesNever("joinFormErrorMessage") { state.joinFormErrorMessage = "Invalid" }
        refreshesNever("meetingEndedNoticeMessage") { state.meetingEndedNoticeMessage = "Ended" }
        refreshesNever("waitingMessage") { state.waitingMessage = "Waiting" }
        refreshesNever("isReactionsDisabled") { state.isReactionsDisabled = true }

        refreshesNever("gamePublicState") { state.gamePublicState = nil }

        refreshesNever("activeSpeakerId") { state.activeSpeakerId = "r@example.com#r" }
        refreshesNever("activeReactions") { state.activeReactions = [] }
    }

    @Test func canonicalStageIdsLightTheRightTile() {
        let viewModel = makeJoinedViewModel()
        let state = viewModel.state
        state.participants["remote@example.com#remote-session"] = Participant(id: "remote@example.com#remote-session", isCameraOff: false)
        #expect(state.canonicalStageUserId(state.userId) == state.userId)
        #expect(state.canonicalStageUserId("local@example.com") == state.userId)
        #expect(state.canonicalStageUserId("remote@example.com#remote-session") == "remote@example.com#remote-session")
        #expect(state.canonicalStageUserId("") == nil && state.canonicalStageUserId(nil) == nil)
        #expect(state.canonicalStageUserId("stranger@example.com#elsewhere") == nil)

        state.activeSpeakerId = "local@example.com"
        #expect(viewModel.stage.speakerUserId == state.userId)
        state.activeSpeakerId = "remote@example.com#remote-session"
        #expect(viewModel.stage.speakerUserId == "remote@example.com#remote-session")
        let local = viewModel.makeStageInputs().participants.first { $0.isLocal }
        #expect(local?.userId == state.userId)
    }

    @Test func joinSerialsComeFromTheCoreAndSurviveARecoveryRejoin() {
        let viewModel = makeJoinedViewModel()
        viewModel.markRemoteParticipantPresent("ann@example.com#s1")
        viewModel.markRemoteParticipantPresent("bob@example.com#s2")
        let rows = viewModel.makeStageInputs().participants.filter { !$0.isLocal }
        #expect(rows.count == 2)
        let ann = rows.first { $0.userId.hasPrefix("ann") }?.joinSerial ?? 0
        let bob = rows.first { $0.userId.hasPrefix("bob") }?.joinSerial ?? 0
        #expect(ann > 0 && bob > ann)

        viewModel.state.participants.removeAll()
        viewModel.markRemoteParticipantPresent("bob@example.com#s2")
        viewModel.markRemoteParticipantPresent("ann@example.com#s1")
        let again = viewModel.makeStageInputs().participants.filter { !$0.isLocal }
        #expect(again.first { $0.userId.hasPrefix("ann") }?.joinSerial == ann)
        #expect(again.first { $0.userId.hasPrefix("bob") }?.joinSerial == bob)

        #expect(StageOrderPolicy.joinOrder(again).first?.hasPrefix("ann") == true)
    }
}
#endif

@MainActor
final class FakeStageConsumerClient {
    private(set) var consumers: [StageConsumerInput]
    private(set) var paused: [String] = []
    private(set) var pausedAudio: [String] = []

    init(consumers: [StageConsumerInput]) {
        self.consumers = consumers
    }

    func apply(_ decisions: [StageConsumerDecision]) {
        for decision in decisions where decision.action == .pause {
            paused.append(decision.consumerId)
            if decision.kind == .audio { pausedAudio.append(decision.consumerId) }
        }
    }
}

func stageNormalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func stagePackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

func stageSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: stagePackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

func stageFiles(under directory: String, extensions: Set<String>) throws -> [String] {
    let root = stagePackageRoot()
    var result: [String] = []
    let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
    while let url = enumerator?.nextObject() as? URL {
        if extensions.contains(url.pathExtension) { result.append(url.path) }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

func stageMatches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}
#endif
