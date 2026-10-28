#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// STG-2 (OUT/PLAN-screens.md section 5): tile anatomy, active speaker, the tile menu, spotlight and pinning. The pure
/// `TileFeaturePolicy`, `TileMenuPolicy`, `TileMenuDispatcher` and `SpotlightRailPolicy`, the presenter behavior their
/// hooks add, the SC2 view model rows (macOS suite) and source scans of the iOS and Compose tile files. Covers S20 3 l1
/// to l6 (the parts a host can check), 4 l, SC2, SC4 and RECONCILE R19's split (people items arrive with PPL-2). The
/// Kotlin half is T/Skip/STG2TileBridgeTests.kt.
///
/// Dependencies on HD/requests/B4-T5.md (applied by the batch integrator): presenter pin announcements (R4a), the
/// camera-on featured speaker (R4b, R5a), the S20 4 rail geometry (R6), the SC2 view model rows (R1, R2), the fixture
/// states (R11) and the strings merge (R13). Tests that need one say so.
@MainActor
struct STG2TileTests {
    static let titles = TileMenuTitles(pin: "Pin", unpin: "Unpin", flipCamera: "Flip Camera", minimizeSelfView: "Minimize Self View",
                                       showSelfView: "Show Self View", showFullVideo: "Show Full Video", cropToFill: "Crop to Fill")

    /// `nil` is the iPhone SE viewport, read here on the main actor rather than in a nonisolated default argument.
    private func presenter(_ inputs: StageInputs, viewport: StageViewport? = nil) -> StagePresenter {
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.setViewport(viewport ?? StagePoliciesTests.iphoneSE)
        stage.apply(inputs)
        return stage
    }

    private func context(slotId: String = "p:r1", userId: String = "r1", role: StageSlotRole = .grid, kind: StageKind = .grid,
                         fit: StageVideoFit = .fill, local: Bool = false, pinned: Bool = false, cameraOff: Bool = false,
                         canFlip: Bool = false, offersFlip: Bool = true) -> TileMenuContext {
        TileMenuContext(slotId: slotId, userId: userId, role: role, kind: kind, fit: fit, isLocal: local, isPinned: pinned,
                        isCameraOff: cameraOff, canFlipCamera: canFlip, offersFlipItem: offersFlip)
    }

    private func model(pinned: Bool = false, presenting: Bool = false, weak: Bool = false) -> TileChromeModel {
        TileChromeModel(userId: "r1", displayName: "Avery", avatarSeed: "Avery:r1", isLocal: false, isMuted: false, isCameraOff: false,
                        isHandRaised: false, isPinned: pinned, isPresenting: presenting, isWeakConnection: weak, isReconnecting: false,
                        reconnectReason: "", isHost: false, isVoiceAgent: false)
    }

    private func item(_ id: String, _ title: String, concept: String = "", role: MenuItemRole = .normal, enabled: Bool = true,
                      reason: String = "") -> MenuItemModel {
        MenuItemModel(id: id, title: title, concept: concept, role: role, isOn: false, isEnabled: enabled, disabledReason: reason)
    }

    private func personIds(_ slots: [StageSlot]) -> [String] {
        slots.filter { $0.id.hasPrefix("p:") }.map { $0.userId }
    }

    // MARK: Tile menu items (S20 3 f, g; RECONCILE R19)

    @Test func remoteTilesOfferPinAndTheFitItem() {
        #expect(TileMenuPolicy.stageItems(context()) == [.pin, .showFullVideo])
        #expect(TileMenuPolicy.stageItems(context(role: .spotlightMain, kind: .spotlight, pinned: true)) == [.unpin, .showFullVideo])
        // SC4: the slot's fit already carries the per-session override, so the item offers the other one.
        #expect(TileMenuPolicy.stageItems(context(fit: .fit)) == [.pin, .cropToFill])
        // A camera-off tile draws the avatar: no fit item.
        #expect(TileMenuPolicy.stageItems(context(cameraOff: true)) == [.pin])
        #expect(TileMenuPolicy.stageItems(context(role: .rail, kind: .presentation)) == [.pin, .showFullVideo])
        #expect(TileMenuPolicy.stageItems(context(role: .spotlightMain, kind: .oneOnOne)) == [.pin, .showFullVideo])
        // The Flip item is only ever yours.
        #expect(!TileMenuPolicy.stageItems(context(canFlip: true)).contains(.flipCamera))
    }

    @Test func yourTileMenuFollowsTheSelfViewRules() {
        let you = "you"
        let grid = context(slotId: "p:you", userId: you, local: true, canFlip: true)
        #expect(TileMenuPolicy.stageItems(grid) == [.pin, .flipCamera, .showFullVideo])
        // Android keeps Flip in the top row (S20 6 d).
        #expect(TileMenuPolicy.stageItems(context(slotId: "p:you", userId: you, local: true, canFlip: true, offersFlip: false))
                == [.pin, .showFullVideo])
        // Floating in 1:1 (S20 3 f): Flip Camera, Minimize Self View, Show Full Video, and no Pin of yourself.
        let floating = context(slotId: "p:you", userId: you, role: .selfFloating, kind: .oneOnOne, local: true, canFlip: true)
        #expect(TileMenuPolicy.stageItems(floating) == [.flipCamera, .minimizeSelfView, .showFullVideo])
        // The floating self view is never a pin target, whatever the kind.
        #expect(TileMenuPolicy.stageItems(context(slotId: "p:you", userId: you, role: .selfFloating, kind: .grid, local: true))
                == [.minimizeSelfView, .showFullVideo])
        #expect(TileMenuPolicy.stageItems(context(slotId: "p:you", userId: you, role: .selfMinimized, kind: .oneOnOne, local: true,
                                                  canFlip: true)) == [.flipCamera, .showSelfView])
        #expect(TileMenuPolicy.stageItems(context(slotId: "p:you", userId: you, role: .selfMinimized, kind: .oneOnOne, local: true,
                                                  canFlip: true, offersFlip: false)) == [.showSelfView])
        // Alone nobody pins.
        #expect(TileMenuPolicy.stageItems(context(slotId: "p:you", userId: you, role: .spotlightMain, kind: .solo, local: true,
                                                  canFlip: true)) == [.flipCamera, .showFullVideo])
        // Camera off: the chrome snapshot reports no flip, and there is no fit item.
        #expect(TileMenuPolicy.stageItems(context(slotId: "p:you", userId: you, local: true, cameraOff: true)) == [.pin])
        #expect(TileMenuPolicy.stageItems(context(slotId: "p:you", userId: you, role: .spotlightMain, kind: .spotlight, local: true,
                                                  pinned: true, offersFlip: false)) == [.unpin, .showFullVideo])
    }

    @Test func slotsWithoutAMenu() {
        #expect(TileMenuPolicy.stageItems(context(slotId: "share:r1", role: .share, kind: .presentation)).isEmpty)
        #expect(TileMenuPolicy.stageItems(context(slotId: "share:r1", role: .rail, kind: .spotlight)).isEmpty)
        #expect(TileMenuPolicy.stageItems(context(slotId: StageSlot.overflowId, userId: "", role: .overflow)).isEmpty)
        #expect(TileMenuPolicy.stageItems(context(slotId: StageSlot.activityId, userId: "", role: .activity, kind: .game)).isEmpty)
        #expect(TileMenuPolicy.stageItems(context(role: .programFeed, kind: .attendeeLive)).isEmpty)
        #expect(TileMenuPolicy.stageItems(context(role: .speakerInset, kind: .attendeeLive)).isEmpty)
        #expect(!TileMenuPolicy.hasMenu(slotId: "p:r1", role: .grid, kind: .attendeeWaiting))
        #expect(TileMenuPolicy.hasMenu(slotId: "p:r1", role: .rail, kind: .game))
    }

    @Test func sectionsPutTheStageFirstAndThePeopleItemsAfterWithoutTheirPin() throws {
        let people = [
            MenuSectionModel(id: "ppl.1", items: [item("mute", "Mute", concept: "mute_person")]),
            MenuSectionModel(id: "ppl.0", items: [item("pin", "Pin", concept: "pin"), item("message", "Send Private Message", concept: "chat")]),
            MenuSectionModel(id: "ppl.pinOnly", items: [item("unpin", "Unpin", concept: "unpin")]),
            MenuSectionModel(id: "ppl.3", items: [item("remove", "Remove from Meeting\u{2026}", concept: "remove_person", role: .destructive)]),
        ]
        let sections = TileMenuPolicy.sections(context(), titles: Self.titles, people: people)
        #expect(sections.map(\.id) == [TileMenuPolicy.stageSectionId, "ppl.1", "ppl.0", "ppl.3"])
        try #require(sections.count >= 3)
        #expect(sections[0].items.map(\.id) == ["pin", "showFullVideo"])
        #expect(sections[0].items.map(\.title) == ["Pin", "Show Full Video"])
        // S20 keeps Pin (R19): the people group 0 arrives without its own Pin.
        #expect(sections[2].items.map(\.id) == ["message"])
        #expect(ConclaveMenuPolicy.destructiveItemsAreLast(sections))
        for section in sections {
            #expect(ConclaveMenuPolicy.isIconConsistent(section), "\(section.id) mixes icons")
        }
        // The stage group is icon-free until the SR1 glyphs exist.
        #expect(sections[0].items.allSatisfy { $0.concept.isEmpty && $0.role == .normal && $0.isEnabled })
        #expect(TileMenuPolicy.itemCount(sections) == 5)
        // No items: no sections at all.
        #expect(TileMenuPolicy.sections(context(slotId: "share:r1", role: .share), titles: Self.titles, people: []).isEmpty)
    }

    @Test func iosContextMenuHidesUnavailableItemsAndActionsSkipThem() throws {
        // S20 3 f, l6: in recovery the iOS context menu hides socket actions; Android keeps them disabled with the reason.
        let reason = "Unavailable while reconnecting"
        let people = [
            MenuSectionModel(id: "ppl.1", items: [item("mute", "Mute", concept: "mute_person", enabled: false, reason: reason)]),
            MenuSectionModel(id: "ppl.0", items: [item("hide", "Hide Messages from Avery", concept: "hide_sender")]),
        ]
        let android = TileMenuPolicy.sections(context(), titles: Self.titles, people: people)
        #expect(android.map(\.id) == [TileMenuPolicy.stageSectionId, "ppl.1", "ppl.0"])
        try #require(android.count >= 2)
        #expect(android[1].items.first?.disabledReason == reason)
        let ios = TileMenuPolicy.contextMenuSections(android)
        #expect(ios.map(\.id) == [TileMenuPolicy.stageSectionId, "ppl.0"])
        #expect(TileMenuPolicy.accessibilityItems(android).map(\.id) == ["pin", "showFullVideo", "hide"])
    }

    @Test func dispatcherRoutesPinSelfViewAndFlipThroughCommandsAndWritesTheFit() throws {
        let stage = presenter(StageFixtureScript.inputs(for: .grid6))
        var commands: [StageCommand] = []
        stage.onCommand = { command in commands.append(command) }
        let slot = try #require(stage.layout.slot(id: "p:r1"))
        let menu = TileMenuContext.make(slot: slot, model: stage.tileChrome.entry(for: "r1").model, kind: stage.kind,
                                        canFlipCamera: true, offersFlipItem: true)
        #expect(TileMenuDispatcher.perform("pin", context: menu, stage: stage))
        #expect(commands.last == StageCommand(kind: .togglePin, userId: "r1", value: ""))
        #expect(TileMenuDispatcher.perform("unpin", context: menu, stage: stage))
        #expect(commands.last == StageCommand(kind: .clearPin, userId: "", value: ""))
        #expect(TileMenuDispatcher.perform("flipCamera", context: menu, stage: stage))
        #expect(commands.last?.kind == .flipCamera)
        #expect(TileMenuDispatcher.perform("minimizeSelfView", context: menu, stage: stage))
        #expect(commands.last == StageCommand(kind: .setSelfViewMode, userId: "", value: "minimized"))
        #expect(TileMenuDispatcher.perform("showSelfView", context: menu, stage: stage))
        #expect(commands.last == StageCommand(kind: .setSelfViewMode, userId: "", value: "floating"))
        // SC4: the fit items write the per-session override; it survives a kind change and clears on reset.
        let count = commands.count
        #expect(TileMenuDispatcher.perform("showFullVideo", context: menu, stage: stage))
        #expect(stage.layout.slot(id: "p:r1")?.fit == .fit)
        stage.apply(StageFixtureScript.inputs(for: .spotlight))
        #expect(stage.layout.slot(id: "p:r1")?.fit == .fit)
        #expect(TileMenuDispatcher.perform("cropToFill", context: menu, stage: stage))
        #expect(stage.layout.slot(id: "p:r1")?.fit == .fill)
        #expect(commands.count == count)
        // People items (PPL-2) are not the stage's.
        #expect(!TileMenuDispatcher.perform("mute", context: menu, stage: stage))
        #expect(commands.count == count)
    }

    // MARK: Featured speaker and the spotlight main (S20 4 c)

    private func videoRoster() -> [StageParticipantInput] {
        [
            StageParticipantInput.make(userId: "you", displayName: "You", isLocal: true, isCameraOff: false, videoKey: "probe:you"),
            StageParticipantInput.make(userId: "r1", displayName: "Avery", isCameraOff: false, joinSerial: 1, videoKey: "probe:r1"),
            StageParticipantInput.make(userId: "r2", displayName: "Ben", isCameraOff: true, joinSerial: 2),
            StageParticipantInput.make(userId: "r3", displayName: "Cai", isCameraOff: false, joinSerial: 3, videoKey: "probe:r3"),
        ]
    }

    @Test func aCameraOffSpeakerIsFeaturedOnlyWhenNobodyHasVideo() {
        let roster = videoRoster()
        #expect(TileFeaturePolicy.spotlightCandidate(speakerUserId: "r3", featuredUserId: "r1", pinnedUserId: "", participants: roster) == "r3")
        #expect(TileFeaturePolicy.spotlightCandidate(speakerUserId: "r2", featuredUserId: "r1", pinnedUserId: "", participants: roster) == "")
        #expect(TileFeaturePolicy.spotlightCandidate(speakerUserId: "r1", featuredUserId: "r1", pinnedUserId: "", participants: roster) == "")
        #expect(TileFeaturePolicy.spotlightCandidate(speakerUserId: "you", featuredUserId: "r1", pinnedUserId: "", participants: roster) == "")
        #expect(TileFeaturePolicy.spotlightCandidate(speakerUserId: "r3", featuredUserId: "r1", pinnedUserId: "r2", participants: roster) == "")
        #expect(TileFeaturePolicy.spotlightCandidate(speakerUserId: "", featuredUserId: "r1", pinnedUserId: "", participants: roster) == "")
        #expect(TileFeaturePolicy.spotlightCandidate(speakerUserId: "zz", featuredUserId: "r1", pinnedUserId: "", participants: roster) == "")
        // An audio-only meeting keeps following the speaker.
        let audioOnly = StageFixtureScript.roster(count: 4, remoteCamerasOn: false)
        #expect(!TileFeaturePolicy.anyRemoteVideo(audioOnly))
        #expect(TileFeaturePolicy.spotlightCandidate(speakerUserId: "r2", featuredUserId: "r1", pinnedUserId: "", participants: audioOnly) == "r2")
    }

    @Test func theSpotlightMainPrefersThePinThenVideoAndNeverPicksYou() {
        func main(pin: String = "", featured: String = "", order: [String] = ["r1", "r2", "r3"],
                  roster: [StageParticipantInput]? = nil) -> String {
            TileFeaturePolicy.spotlightMainUserId(pinnedUserId: pin, featuredUserId: featured, remoteOrder: order,
                                                  participants: roster ?? self.videoRoster(), localUserId: "you")
        }
        #expect(main(pin: "r2", featured: "r3") == "r2")
        #expect(main(pin: "you", featured: "r3") == "you")
        // A stale pin falls through.
        #expect(main(pin: "gone", featured: "r3") == "r3")
        #expect(main(featured: "r3") == "r3")
        // The featured speaker has the camera off while others have video: the first remote with video.
        #expect(main(featured: "r2", order: ["r2", "r3", "r1"]) == "r3")
        #expect(main(featured: "") == "r1")
        #expect(main(featured: "you") == "r1")
        // Nobody has video: the featured speaker, then the first remote.
        let audioOnly = StageFixtureScript.roster(count: 4, remoteCamerasOn: false)
        #expect(main(featured: "r2", roster: audioOnly) == "r2")
        #expect(main(featured: "", roster: audioOnly) == "r1")
        // You are main only when nobody else is on stage.
        #expect(main(featured: "", order: []) == "you")
    }

    @Test func aBurstOfSpeakersNeverSwapsTheMainAndAHeldSpeakerSwapsOnce() {
        // S20 4 h, k (SC1 b): featured changes wait 1.2 s and happen at most every 8 s, with the injected clock.
        var clock = 100_000.0
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.now = { clock }
        stage.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        stage.setViewport(StagePoliciesTests.iphone17e)
        stage.apply(StageFixtureScript.inputs(for: .spotlight))
        let revision = stage.layout.revision
        for index in 0..<20 {
            stage.speakerChanged(index % 2 == 0 ? "r3" : "r4", atMillis: clock)
            clock += 300
            stage.firePendingPromotion()
        }
        #expect(stage.layout.revision == revision, "a burst of 300 ms turns moved the main slot")
        stage.speakerChanged("r5", atMillis: clock)
        clock += 1_200
        stage.firePendingPromotion()
        #expect(stage.layout.revision == revision + 1)
        #expect(stage.layout.slots.first?.userId == "r5")
        stage.reset()
        #expect(!stage.hasLivePromotionTask)
    }

    @Test func aCameraOffSpeakerNeverTakesTheMainWhileOthersHaveVideo() {
        // Needs R4b and R5a.
        var clock = 200_000.0
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.now = { clock }
        stage.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        stage.setViewport(StagePoliciesTests.iphone17e)
        var rows = StageFixtureScript.roster(count: 6)
        rows[4] = StageParticipantInput.make(userId: "r4", displayName: "Dev", isMuted: false, isCameraOff: true, joinSerial: 4)
        stage.apply(StageFixtureScript.copy(StageFixtureScript.inputs(for: .spotlight), participants: rows))
        let revision = stage.layout.revision
        stage.speakerChanged("r4", atMillis: clock)
        #expect(stage.pendingPromotionCandidate.isEmpty)
        clock += 9_000
        stage.firePendingPromotion()
        #expect(stage.layout.revision == revision)
        #expect(stage.layout.slots.first?.userId == "r1")
        // Sidebar with 14 (Auto): you never become main when you speak.
        let sidebar = presenter(StageFixtureScript.base(count: 14), viewport: StagePoliciesTests.iphone17e)
        #expect(sidebar.layout.kind == .sidebar)
        #expect(sidebar.layout.slots.first?.userId != StageFixtureScript.localUserId)
        sidebar.speakerChanged(StageFixtureScript.localUserId, atMillis: 1_000)
        #expect(sidebar.pendingPromotionCandidate.isEmpty)
    }

    // MARK: Pinning (S20 4 a, f, g, l)

    @Test func pinAnnouncementsSpeakForPinsAndLeavesOnly() {
        let base = StageFixtureScript.base(count: 6)
        let pinnedBen = StageFixtureScript.copy(base, pinnedUserId: "r2")
        #expect(TileFeaturePolicy.pinAnnouncement(previous: base, next: pinnedBen)
                == TilePinAnnouncement(kind: TileFeaturePolicy.pinnedKind, name: "Ben"))
        #expect(TileFeaturePolicy.pinAnnouncement(previous: pinnedBen, next: StageFixtureScript.copy(base, pinnedUserId: "r3"))
                == TilePinAnnouncement(kind: TileFeaturePolicy.pinnedKind, name: "Cai"))
        // Unpinning by choice has no copy (S20 4 g) and stays silent.
        #expect(TileFeaturePolicy.pinAnnouncement(previous: pinnedBen, next: base) == TilePinAnnouncement.none)
        #expect(TileFeaturePolicy.pinAnnouncement(previous: pinnedBen, next: pinnedBen) == TilePinAnnouncement.none)
        // The pinned person leaves, whether or not the core already cleared the pin; the later clear is silent.
        let withoutBen = StageFixtureScript.roster(count: 6).filter { $0.userId != "r2" }
        let leftPinned = StageFixtureScript.copy(pinnedBen, participants: withoutBen)
        let cleared = TilePinAnnouncement(kind: TileFeaturePolicy.pinClearedKind, name: "Ben")
        #expect(TileFeaturePolicy.pinAnnouncement(previous: pinnedBen, next: leftPinned) == cleared)
        #expect(TileFeaturePolicy.pinAnnouncement(previous: pinnedBen, next: StageFixtureScript.copy(leftPinned, pinnedUserId: "")) == cleared)
        #expect(TileFeaturePolicy.pinAnnouncement(previous: leftPinned, next: StageFixtureScript.copy(leftPinned, pinnedUserId: ""))
                == TilePinAnnouncement.none)
        // The first snapshot and a new call session never announce; a pin on nobody present never announces.
        #expect(TileFeaturePolicy.pinAnnouncement(previous: StageInputs.make(), next: pinnedBen) == TilePinAnnouncement.none)
        let nextSession = StageInputs.make(callSession: 2, isInCall: true, localUserId: "you",
                                           participants: StageFixtureScript.roster(count: 6), pinnedUserId: "r3")
        #expect(TileFeaturePolicy.pinAnnouncement(previous: pinnedBen, next: nextSession) == TilePinAnnouncement.none)
        #expect(TileFeaturePolicy.pinAnnouncement(previous: base, next: StageFixtureScript.copy(base, pinnedUserId: "gone"))
                == TilePinAnnouncement.none)
    }

    @Test func thePresenterAnnouncesAPinAndThePinnedPersonLeavingOnce() {
        // Needs R4a.
        let stage = presenter(StageFixtureScript.copy(StageFixtureScript.base(count: 6), pinnedUserId: "r3"))
        // The first snapshot keeps the entry announcement alone.
        #expect(stage.announcementLog == ["joined:" + StageFixtureScript.roomLabel])
        stage.apply(StageFixtureScript.copy(StageFixtureScript.base(count: 6), pinnedUserId: "r2"))
        #expect(stage.announcementLog.last == "pinned:Ben")
        #expect(stage.announcement?.kind == TileFeaturePolicy.pinnedKind)
        let withoutBen = StageFixtureScript.roster(count: 6).filter { $0.userId != "r2" }
        stage.apply(StageFixtureScript.copy(StageFixtureScript.base(count: 6), participants: withoutBen, pinnedUserId: "r2"))
        #expect(stage.announcementLog.last == "pinCleared:Ben")
        // The pin left the main slot: Auto resumes (grid), and the core's later clear says nothing more.
        #expect(stage.layout.kind == .grid)
        let count = stage.announcementLog.count
        stage.apply(StageFixtureScript.copy(StageFixtureScript.base(count: 6), participants: withoutBen, pinnedUserId: ""))
        #expect(stage.announcementLog.count == count)
    }

    @Test func spotlightPinned9ShowsThreeTilesPlusFiveWithYouLast() throws {
        // S20 4 l at 375 pt, 390 pt and 360 dp. Needs R6 (the 80 x 107 strip).
        let inputs = StageFixtureScript.copy(StageFixtureScript.base(count: 9), pinnedUserId: StageFixtureScript.remoteId(0))
        for viewport in [StagePoliciesTests.iphoneSE, StagePoliciesTests.iphone17e, StagePoliciesTests.android360] {
            let stage = presenter(inputs, viewport: viewport)
            #expect(stage.layout.kind == .spotlight)
            #expect(stage.layout.capacity.railSlots == 4, "\(viewport.width)")
            let first = try #require(stage.layout.slots.first)
            #expect(first.id == "p:r1" && first.role == .spotlightMain)
            let rail = stage.layout.slots.dropFirst()
            #expect(personIds(Array(rail)) == ["r2", "r3", StageFixtureScript.localUserId], "\(viewport.width)")
            #expect(rail.last?.id == StageSlot.overflowId)
            #expect(stage.layout.overflowCount == 5)
            // Every rail tile is a 3:4 strip tile above the bar slot.
            let frames = stage.currentFrames().filter { frame in rail.contains { $0.id == frame.slotId } }
            #expect(frames.allSatisfy { abs($0.width - 80) < 0.01 && abs($0.height - 107) < 0.01 })
        }
    }

    @Test func aPinDuringAShareKeepsThePinMainAndTheShareFirstInTheRail() throws {
        // S20 4 a, l (D17; web chooseStageMode): Unpin hands the main slot to the share, slot ids unchanged.
        let pinned = StageFixtureScript.copy(StageFixtureScript.inputs(for: .presentation), pinnedUserId: StageFixtureScript.remoteId(1))
        let stage = presenter(pinned)
        #expect(stage.layout.kind == .spotlight)
        let main = try #require(stage.layout.slots.first)
        #expect(main.id == "p:r2" && main.role == .spotlightMain)
        let shareInRail = try #require(stage.layout.slots.dropFirst().first)
        #expect(shareInRail.id == StageSlot.shareId("r1") && shareInRail.role == .rail && shareInRail.fit == .fit)
        stage.apply(StageFixtureScript.copy(pinned, pinnedUserId: ""))
        #expect(stage.layout.kind == .presentation)
        #expect(stage.layout.slots.first?.id == StageSlot.shareId("r1") && stage.layout.slots.first?.role == .share)
        // Needs R6: four strip slots at 375 pt keep r2 visible in the rail.
        #expect(stage.layout.slot(id: "p:r2")?.role == .rail)
    }

    @Test func aPinnedSelfNeverGetsASecondSlot() {
        // Needs R5b: pinning yourself with a floating self view used to plan `p:you` twice.
        let inputs = StageFixtureScript.copy(StageFixtureScript.base(count: 3, localCameraOn: true), selfViewMode: "floating",
                                             pinnedUserId: StageFixtureScript.localUserId)
        let stage = presenter(inputs)
        let ids = stage.layout.slots.map(\.id)
        #expect(Set(ids).count == ids.count, "duplicate slot ids \(ids)")
        #expect(stage.layout.slots.first?.id == "p:you" && stage.layout.slots.first?.role == .spotlightMain)
    }

    // MARK: Rail geometry (S20 4 c, d)

    @Test func theRailFollowsTheS20Geometry() {
        for viewport in [StagePoliciesTests.iphoneSE, StagePoliciesTests.iphone17e, StagePoliciesTests.android360] {
            #expect(SpotlightRailPolicy.isStrip(viewport))
            #expect(SpotlightRailPolicy.tileWidth(viewport) == 80 && SpotlightRailPolicy.tileHeight(viewport) == 107)
            #expect(SpotlightRailPolicy.capacity(viewport: viewport) == 4, "\(viewport.width)")
        }
        let landscape = StagePoliciesTests.androidLandscape
        #expect(!SpotlightRailPolicy.isStrip(landscape))
        #expect(SpotlightRailPolicy.tileWidth(landscape) == 160 && abs(SpotlightRailPolicy.tileHeight(landscape) - 90) < 0.001)
        #expect(SpotlightRailPolicy.capacity(viewport: landscape) == 1)
        #expect(SpotlightRailPolicy.tileWidth(StagePoliciesTests.ipadPortrait) == 200)
        #expect(abs(SpotlightRailPolicy.tileHeight(StagePoliciesTests.ipadPortrait) - 112.5) < 0.001)
        #expect(SpotlightRailPolicy.capacity(viewport: StagePoliciesTests.ipadPortrait) == 8)
        #expect(SpotlightRailPolicy.capacity(viewport: StagePoliciesTests.ipadLandscape) == 5)
        // A 673 dp unfolded foldable is medium width: the 160 column.
        #expect(SpotlightRailPolicy.tileWidth(StagePoliciesTests.foldUnfolded) == 160)
        #expect(SpotlightRailPolicy.capacity(viewport: StagePoliciesTests.foldUnfolded) == 6)
        #expect(SpotlightRailPolicy.capacity(viewport: StageViewport.zero) == 0)
        // Needs R6: the layout policy reads the same capacity.
        #expect(StageLayoutPolicy.railCapacity(viewport: StagePoliciesTests.iphoneSE) == 4)
    }

    // MARK: Tile overlays (S20 3 c, d, f; 4 c, d)

    @Test func overlayDecisionsAndTheUnpinTarget() {
        #expect(TileFeaturePolicy.showsFlipControl(isLocal: true, isShare: false, role: .grid, canFlipCamera: true, density: .normal))
        #expect(TileFeaturePolicy.showsFlipControl(isLocal: true, isShare: false, role: .spotlightMain, canFlipCamera: true, density: .spotlight))
        #expect(TileFeaturePolicy.showsFlipControl(isLocal: true, isShare: false, role: .selfFloating, canFlipCamera: true, density: .dense))
        #expect(!TileFeaturePolicy.showsFlipControl(isLocal: true, isShare: false, role: .rail, canFlipCamera: true, density: .dense))
        #expect(!TileFeaturePolicy.showsFlipControl(isLocal: true, isShare: false, role: .selfMinimized, canFlipCamera: true, density: .normal))
        #expect(!TileFeaturePolicy.showsFlipControl(isLocal: true, isShare: true, role: .grid, canFlipCamera: true, density: .normal))
        #expect(!TileFeaturePolicy.showsFlipControl(isLocal: false, isShare: false, role: .grid, canFlipCamera: true, density: .normal))
        #expect(!TileFeaturePolicy.showsFlipControl(isLocal: true, isShare: false, role: .grid, canFlipCamera: false, density: .normal))

        #expect(TileFeaturePolicy.showsUnpinTarget(role: .spotlightMain, isPinned: true, isShare: false))
        #expect(!TileFeaturePolicy.showsUnpinTarget(role: .rail, isPinned: true, isShare: false))
        #expect(!TileFeaturePolicy.showsUnpinTarget(role: .spotlightMain, isPinned: false, isShare: false))
        // Centered on the pinned badge (the leading-most top trailing badge), clamped at the tile edge.
        #expect(TileFeaturePolicy.unpinTargetTrailingInset(model: model(pinned: true), density: .spotlight, targetSize: 44) == 0)
        #expect(TileFeaturePolicy.unpinTargetTrailingInset(model: model(pinned: true, presenting: true, weak: true), density: .spotlight,
                                                           targetSize: 44) == 54)
        #expect(TileFeaturePolicy.unpinTargetTrailingInset(model: model(pinned: true, weak: true), density: .dense, targetSize: 44) == 10)
        #expect(TileFeaturePolicy.unpinTargetTopInset(density: .spotlight, targetSize: 44) == 0)
        #expect(TileFeaturePolicy.unpinTargetTopInset(density: .spotlight, targetSize: TileFeaturePolicy.unpinTargetAndroid) == 0)

        #expect(TileFeaturePolicy.showsOneOnOneCaption(kind: .oneOnOne, role: .spotlightMain, isLocal: false, isCameraOff: true))
        #expect(!TileFeaturePolicy.showsOneOnOneCaption(kind: .spotlight, role: .spotlightMain, isLocal: false, isCameraOff: true))
        #expect(!TileFeaturePolicy.showsOneOnOneCaption(kind: .oneOnOne, role: .spotlightMain, isLocal: false, isCameraOff: false))
        #expect(!TileFeaturePolicy.showsOneOnOneCaption(kind: .solo, role: .spotlightMain, isLocal: true, isCameraOff: true))

        #expect(TileFeaturePolicy.reconnectReasonKind("ping timeout") == "timeout")
        #expect(TileFeaturePolicy.reconnectReasonKind(" Transport Close ") == "network")
        #expect(TileFeaturePolicy.reconnectReasonKind("transport error") == "network")
        #expect(TileFeaturePolicy.reconnectReasonKind("io server disconnect") == "interrupted")
        #expect(TileFeaturePolicy.reconnectReasonKind("") == "interrupted")
        #expect(TileFeaturePolicy.backOnlineMillis == 4_500)
    }

    @Test func theMainFitRuleKeepsFacesUncroppedOnRegularWidthOnly() {
        #expect(TileFeaturePolicy.mainFit(widthClass: StageSizeClass.compact, slotWidth: 390, slotHeight: 844, videoWidth: 1280,
                                          videoHeight: 720) == .fill)
        #expect(TileFeaturePolicy.mainFit(widthClass: StageSizeClass.regular, slotWidth: 1180, slotHeight: 664, videoWidth: 1280,
                                          videoHeight: 720) == .fill)
        #expect(TileFeaturePolicy.mainFit(widthClass: StageSizeClass.regular, slotWidth: 1180, slotHeight: 664, videoWidth: 720,
                                          videoHeight: 1280) == .fit)
        // Within 30% keeps fill; past it fits.
        #expect(TileFeaturePolicy.mainFit(widthClass: StageSizeClass.expanded, slotWidth: 125, slotHeight: 100, videoWidth: 100,
                                          videoHeight: 100) == .fill)
        #expect(TileFeaturePolicy.mainFit(widthClass: StageSizeClass.expanded, slotWidth: 140, slotHeight: 100, videoWidth: 100,
                                          videoHeight: 100) == .fit)
        #expect(TileFeaturePolicy.mainFit(widthClass: StageSizeClass.regular, slotWidth: 1180, slotHeight: 664, videoWidth: 0,
                                          videoHeight: 0) == .fill)
        #expect(TileFeaturePolicy.toggledFit(.fill) == .fit && TileFeaturePolicy.toggledFit(.fit) == .fill)
    }

    // MARK: Fixture states (R11)

    @Test func stg2FixtureStatesBuildTheirCells() throws {
        // Needs R11a.
        let oneOnOne = presenter(StageFixtureScript.inputs(for: try #require(StageFixtureScript.state(named: "oneOnOne-cameraOff"))))
        #expect(oneOnOne.layout.kind == .oneOnOne)
        #expect(oneOnOne.tileChrome.entry(for: "r1").model.isCameraOff)
        let pinnedSelf = presenter(StageFixtureScript.inputs(for: try #require(StageFixtureScript.state(named: "spotlight-pinned-self"))))
        #expect(pinnedSelf.layout.slots.first?.id == "p:you" && pinnedSelf.chrome.canFlipCamera)
        let sidebar = presenter(StageFixtureScript.inputs(for: try #require(StageFixtureScript.state(named: "sidebar-14"))))
        #expect(sidebar.layout.kind == .sidebar)
        let reconnecting = presenter(StageFixtureScript.inputs(for: try #require(StageFixtureScript.state(named: "tile-reconnecting"))))
        #expect(reconnecting.tileChrome.entry(for: "r2").model.isReconnecting)
        #expect(TileFeaturePolicy.reconnectReasonKind(reconnecting.tileChrome.entry(for: "r2").model.reconnectReason) == "timeout")
        let pinned9 = presenter(StageFixtureScript.inputs(for: try #require(StageFixtureScript.state(named: "spotlight-pinned-9"))))
        #expect(pinned9.layout.pinnedUserId == "r1" && pinned9.layout.kind == .spotlight)
        let sharePinned = presenter(StageFixtureScript.inputs(for: try #require(StageFixtureScript.state(named: "presentation-pinned"))))
        #expect(sharePinned.layout.kind == .spotlight && sharePinned.layout.presenterUserId == "r1")
    }

    // MARK: Source scans (iOS views are not compiled by the macOS host)

    @Test func iosTileMenuIsAContextMenuWithAChromeOnlyPreview() throws {
        let menu = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/TileMenu+iOS.swift"))
        #expect(menu.contains("content.contextMenu {") && menu.contains("} preview: { TileMenuPreview(model: model, speaking: speaking) }"))
        #expect(menu.contains("ConclaveMenuContent(sections: menu.contextSections"))
        #expect(menu.contains("var contextSections: [MenuSectionModel] { TileMenuPolicy.contextMenuSections(sections) }"))
        // The preview never holds a renderer (S20 3 l3): chrome over the flat tile fill only.
        #expect(menu.contains("HostingTheme.token(DesignTokens.iosInCallTile)"))
        for renderer in ["RendererSlotView", "StageLiveVideo", "RendererProbe(", "RTCMTLVideoView"] {
            #expect(!menu.contains(renderer), "the tile menu preview creates \(renderer)")
        }
        #expect(menu.contains("TileMenuDispatcher.perform(item.id, context: menu.context, stage: stage)"))
        let slot = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/SlotView+iOS.swift"))
        #expect(slot.components(separatedBy: "ConclaveTileChrome(").count - 1 == 1)
        #expect(slot.contains("actions: menu.accessibilityActions(stage: stage, onDispatched: noteDispatch)"))
        #expect(slot.contains(".stageTileMenu(menu, model: model, speaking: speaking, stage: stage, onDispatched: noteDispatch)"))
        #expect(slot.contains(".conclaveGestureFeedback(.selectionChanged, trigger: menuFlips)"))
        #expect(slot.contains("@Environment(StageChromeVisibility.self) private var chrome: StageChromeVisibility?"))
        #expect(slot.contains(".accessibilityLabel(ConclaveStrings.format(\"Unpin %@\", model.displayName))"))
        #expect(slot.contains("ConclaveStrings.text(\"Camera off\")") && slot.contains("ConclaveStrings.text(\"Back Online\")"))
        // Overlays never take taps from the stage or add accessibility elements beyond the two buttons.
        #expect(slot.components(separatedBy: ".allowsHitTesting(false)").count - 1 >= 2)
        // The floating flip control and your tile's flip control both fade with chrome.
        #expect(slot.components(separatedBy: ".modifier(StageChromeFade())").count - 1 == 2)
    }

    @Test func androidTileMenuAnchorsAtThePressPointWithOneHaptic() throws {
        let menu = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/TileMenu.kt"))
        #expect(menu.contains("val down = awaitFirstDown(requireUnconsumed = false)"))
        #expect(menu.contains("val longPress = awaitLongPressOrCancellation(down.id)"))
        #expect(menu.contains("for (change in event.changes) change.consume()"))
        #expect(!menu.contains("combinedClickable(") && !menu.contains("detectTapGestures("))
        #expect(menu.contains("Box(modifier.absoluteOffset { IntOffset(state.anchor.x.roundToInt(), state.anchor.y.roundToInt()) }.size(0.dp)) {"))
        #expect(menu.contains("ConclaveDropdownMenu( expanded = open,"))
        #expect(menu.contains("stage.setTransientChrome(id = TileMenuPolicy.menuTransientId, open = true)"))
        #expect(menu.contains("conclaveString(\"ppl_pin\")") && menu.contains("conclaveString(\"ppl_unpin\")"))
        #expect(!menu.contains("MeetingViewModel"))
        let slot = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/SlotView.kt"))
        #expect(slot.components(separatedBy: "haptics.gesture(FeedbackKind.longPress)").count - 1 == 1)
        #expect(slot.contains("modifier = Modifier.fillMaxSize().tileLongPress(menu.hasItems) { at ->"))
        #expect(slot.contains("actions = actions,") && slot.contains("accessibilityLongPressLabel = if (menu.hasItems) actionsLabel else null,"))
        #expect(slot.contains("clearAndSetSemantics { contentDescription = label; this.role = Role.Button }"))
        #expect(slot.contains("liveRegion = LiveRegionMode.Polite"))
        // STG-1 pins stay.
        #expect(slot.contains("graphicsLayer { alpha = if (minimized) 0f else 1f }"))
    }

    @Test func stg2SourcesStayDashFreeFlatAndLocalized() throws {
        let files = ["Sources/Conclave/Features/Meeting/Stage/TileFeaturePolicy.swift",
                     "Sources/Conclave/Features/Meeting/Stage/TileMenu+iOS.swift",
                     "Sources/Conclave/Features/Meeting/Stage/SlotView+iOS.swift",
                     "Sources/Conclave/Skip/ui/call/stage/TileMenu.kt",
                     "Sources/Conclave/Skip/ui/call/stage/SlotView.kt",
                     "Tests/ConclaveTests/Skip/STG2TileBridgeTests.kt"]
        for file in files {
            let text = try stageSource(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file) mentions a gradient")
            #expect(!text.contains("HapticManager") && !text.contains("@Stable") && !text.contains("ScrollView"), "\(file)")
            #expect(stageMatches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x)"#, in: text).isEmpty, "\(file) builds a color from a literal")
        }
        // Needs R13: every catalog key and resource name the STG-2 views use exists.
        let catalog = try stageSource("Sources/Conclave/Resources/Localizable.xcstrings")
        let catalogKeys = try #require(try JSONSerialization.jsonObject(with: Data(catalog.utf8)) as? [String: Any])["strings"] as? [String: Any]
        for file in ["Sources/Conclave/Features/Meeting/Stage/TileMenu+iOS.swift", "Sources/Conclave/Features/Meeting/Stage/SlotView+iOS.swift"] {
            let text = try stageSource(file)
            for match in stageMatches(#"ConclaveStrings\.(text|format)\("[^"]+""#, in: text) {
                let key = String(match.drop { $0 != "\"" }.dropFirst().dropLast())
                #expect(catalogKeys?[key] != nil, "\(file): missing catalog key \(key)")
            }
        }
        let resources = try stageSource("Android/app/src/main/res/values/strings.xml")
        for file in ["Sources/Conclave/Skip/ui/call/stage/TileMenu.kt", "Sources/Conclave/Skip/ui/call/stage/SlotView.kt"] {
            let text = try stageSource(file)
            for match in stageMatches(#""(ppl|stg|ds)_[a-z0-9_]+""#, in: text) {
                let name = String(match.dropFirst().dropLast())
                #expect(resources.contains("name=\"" + name + "\""), "\(file): missing resource \(name)")
            }
        }
    }
}

#if os(macOS)
/// S20 SC2 through the view model (macOS host; no network). Needs HD/requests/B4-T5.md R1 and R2.
@MainActor
@Suite(.serialized)
struct STG2PinViewModelTests {
    private static let viewModeKey = "conclave.meetView.viewMode"
    private static let preferenceKeys = ["conclave.meetView.viewMode", "conclave.meetView.viewMaxTiles",
                                         "conclave.meetView.hideTilesWithoutVideo", "conclave.meetView.selfViewMode",
                                         "conclave.meetView.selfViewCorner"]

    private func makeJoinedViewModel() -> MeetingViewModel {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        viewModel.state.participants["remote@example.com#remote-session"] = Participant(id: "remote@example.com#remote-session",
                                                                                         displayName: "Remote", isCameraOff: false)
        viewModel.state.participants["other@example.com#other-session"] = Participant(id: "other@example.com#other-session",
                                                                                       displayName: "Other", isCameraOff: false)
        return viewModel
    }

    /// `MeetingViewPreferences.save` writes the five layout keys; the test restores them.
    private func withSavedPreferences(_ body: () -> Void) {
        let defaults = UserDefaults.standard
        var saved: [String: Any] = [:]
        for key in Self.preferenceKeys {
            if let value = defaults.object(forKey: key) { saved[key] = value }
        }
        body()
        for key in Self.preferenceKeys {
            if let value = saved[key] { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
        }
    }

    @Test func pinThenChangingMaximumTilesLeavesThePersistedViewModeUnchanged() {
        withSavedPreferences {
            let viewModel = makeJoinedViewModel()
            viewModel.state.viewMode = .auto
            viewModel.togglePin("remote@example.com#remote-session")
            #expect(viewModel.state.pinnedUserId == "remote@example.com#remote-session")
            #expect(viewModel.state.viewMode == .auto)
            // The pin still shows spotlight on the legacy root (R2) and the native kind reads it directly.
            #expect(viewModel.state.resolvedViewMode == .spotlight)
            viewModel.setViewMaxTiles(9)
            #expect(UserDefaults.standard.string(forKey: Self.viewModeKey) == "auto")
            viewModel.togglePin("remote@example.com#remote-session")
            #expect(viewModel.state.pinnedUserId == nil && viewModel.state.viewMode == .auto)
            viewModel.togglePin("remote@example.com#remote-session")
            viewModel.clearPin()
            #expect(viewModel.state.pinnedUserId == nil && viewModel.state.viewMode == .auto)
        }
    }

    @Test func choosingTiledEndsThePinAndKeepsTheSelfViewPreference() {
        withSavedPreferences {
            let viewModel = makeJoinedViewModel()
            viewModel.state.viewMode = .auto
            viewModel.state.selfViewMode = .floating
            viewModel.togglePin("remote@example.com#remote-session")
            // A renderable pin wins in every Layout mode on the legacy root (R2).
            viewModel.state.viewMode = .sidebar
            #expect(viewModel.state.resolvedViewMode == .spotlight)
            viewModel.setViewMode(.tiled)
            #expect(viewModel.state.pinnedUserId == nil)
            #expect(viewModel.state.selfViewMode == .floating)
            #expect(viewModel.state.resolvedViewMode == .tiled)
        }
    }
}
#endif
#endif
