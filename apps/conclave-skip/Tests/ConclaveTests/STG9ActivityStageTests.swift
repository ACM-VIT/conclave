#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct STG9ActivityStageTests {
    private let names = ActivityStageNames(appId: "whiteboard", gameName: "Trivia")

    private func stage(_ inputs: StageInputs) -> StagePresenter {
        let presenter = StagePresenter(shell: MeetingShellPresenter())
        presenter.setViewport(StagePoliciesTests.iphoneSE)
        presenter.apply(inputs)
        return presenter
    }

    private func layered(_ name: String, count: Int = 6) -> StageInputs {
        ActivityFixtureScript.stageInputs(named: name, base: StageFixtureScript.base(count: count))
    }

    @Test func liveKindsFollowTheD17Priority() {
        #expect(ActivityStagePolicy.liveKinds(activeAppId: "whiteboard", isBrowserActive: true, isGameActive: true) == ["app", "browser", "game"])
        #expect(ActivityStagePolicy.liveKinds(activeAppId: "", isBrowserActive: false, isGameActive: true) == ["game"])
        #expect(ActivityStagePolicy.liveKinds(activeAppId: "", isBrowserActive: false, isGameActive: false).isEmpty)

        let attendee = StageInputs.make(activeAppId: "whiteboard", isGameActive: true, isWebinarAttendee: true)
        #expect(ActivityStagePolicy.liveKinds(attendee).isEmpty)
    }

    @Test func aHigherActivityNeverSilentlyHidesALowerOne() {
        let both = ActivityStagePolicy.resolve(live: ["app", "game"], preferredKind: "", showsVideoOverActivity: false, names: names)
        #expect(both.activityKind == "app")
        #expect(both.onStageKind == "app")
        #expect(both.hiddenActivityKind == "game")
        #expect(both.chip == NowPlayingChip(kind: "game", name: "Trivia"))
        #expect(both.stageKind == StageKind.app)

        let single = ActivityStagePolicy.resolve(live: ["game"], preferredKind: "", showsVideoOverActivity: false, names: names)
        #expect(single.hiddenActivityKind.isEmpty)
        #expect(single.chip == nil)

        let none = ActivityStagePolicy.resolve(live: [], preferredKind: "game", showsVideoOverActivity: true, names: names)
        #expect(none == ActivityStageResolution.none)
    }

    @Test func showOnTheChipMovesTheHiddenActivityOntoTheCardLocally() {
        let both = ActivityStagePolicy.resolve(live: ["app", "game"], preferredKind: "", showsVideoOverActivity: false, names: names)
        let preference = ActivityStagePolicy.preferenceAfterShowingHidden(both, currentPreference: "")
        #expect(preference == "game")
        let swapped = ActivityStagePolicy.resolve(live: ["app", "game"], preferredKind: preference, showsVideoOverActivity: false, names: names)
        #expect(swapped.onStageKind == "game")
        #expect(swapped.chip == NowPlayingChip(kind: "app", name: "whiteboard"))

        #expect(ActivityStagePolicy.normalizedPreference("game", live: ["app"]).isEmpty)
        let ended = ActivityStagePolicy.resolve(live: ["app"], preferredKind: "game", showsVideoOverActivity: false, names: names)
        #expect(ended.onStageKind == "app")
    }

    @Test func showVideoIsLocalReversibleAndResetsWithTheLastActivity() {
        let video = ActivityStagePolicy.resolve(live: ["game"], preferredKind: "", showsVideoOverActivity: true, names: names)
        #expect(video.onStageKind.isEmpty)
        #expect(video.activityKind == "game")
        #expect(video.hiddenActivityKind == "game")
        #expect(video.chip == NowPlayingChip(kind: "game", name: "Trivia"))
        #expect(video.stageKind == nil)

        #expect(ActivityStagePolicy.preferenceAfterShowingHidden(video, currentPreference: "") == "")
        #expect(!ActivityStagePolicy.normalizedShowsVideo(true, live: []))
        #expect(ActivityStagePolicy.isOnStage(kind: "game", resolution: ActivityStagePolicy.resolve(
            live: ["game"], preferredKind: "", showsVideoOverActivity: false, names: names)))
        #expect(!ActivityStagePolicy.isOnStage(kind: "game", resolution: video))
    }

    @Test func startsAndEndsAreAnnouncedInPriorityOrder() {
        let changes = ActivityStagePolicy.transitions(previous: ["game"], next: ["app", "browser"])
        #expect(changes.started == ["app", "browser"])
        #expect(changes.ended == ["game"])
        #expect(ActivityStagePolicy.transitions(previous: ["app"], next: ["app"]).isEmpty)
        #expect(ActivityStagePolicy.startedAnnouncement == "activityStarted")
        #expect(ActivityStagePolicy.endedAnnouncement == "activityEnded")
    }

    @Test func appAndGameFixtureShowsTheAppWithTheGameChip() {
        let presenter = stage(layered(ActivityFixtureState.appAndGame.rawValue))
        #expect(presenter.kind == StageKind.app)
        #expect(presenter.layout.activityKind == "app")
        #expect(presenter.layout.hiddenActivityKind == "game")
        #expect(presenter.chrome.nowPlaying == NowPlayingChip(kind: "game", name: "Trivia"))

        presenter.showHiddenActivity()
        #expect(presenter.kind == StageKind.game)
        #expect(presenter.chrome.nowPlaying == NowPlayingChip(kind: "app", name: "whiteboard"))
        presenter.showActivity(kind: "app")
        #expect(presenter.kind == StageKind.app)
    }

    @Test func showVideoReturnsThePeopleLayoutAndTheChipBringsTheCardBack() {
        let presenter = stage(layered(ActivityFixtureState.gameTrivia6.rawValue))
        #expect(presenter.kind == StageKind.game)
        presenter.setShowsVideoOverActivity(true)
        #expect(!presenter.kind.isActivity)
        #expect(presenter.layout.showsVideoOverActivity)
        #expect(presenter.chrome.nowPlaying?.kind == "game")
        presenter.showHiddenActivity()
        #expect(presenter.kind == StageKind.game)
        #expect(presenter.chrome.nowPlaying == nil)
    }

    @Test func showVideoAndThePreferenceResetWhenTheActivityEnds() {
        var inputs = layered(ActivityFixtureState.gameTrivia6.rawValue)
        let presenter = stage(inputs)
        presenter.setShowsVideoOverActivity(true)
        inputs = StageFixtureScript.base(count: 6)
        presenter.apply(inputs)
        #expect(!presenter.layout.showsVideoOverActivity)
        #expect(presenter.chrome.nowPlaying == nil)
        presenter.apply(layered(ActivityFixtureState.gameTrivia6.rawValue))

        #expect(presenter.kind == StageKind.game)
    }

    @Test func activityStartAndEndPostOneAnnouncementEach() {
        let presenter = stage(StageFixtureScript.base(count: 4))
        presenter.apply(layered(ActivityFixtureState.gameTrivia6.rawValue, count: 4))
        #expect(presenter.announcement?.kind == ActivityStagePolicy.startedAnnouncement)
        #expect(presenter.announcement?.name == "game:Trivia")
        #expect(ActivityStagePolicy.announcedKind("game:Trivia") == "game" && ActivityStagePolicy.announcedName("game:Trivia") == "Trivia")
        #expect(ActivityStagePolicy.announcementName(kind: "browser", names: names) == "browser:")
        presenter.apply(StageFixtureScript.base(count: 4))
        #expect(presenter.announcement?.kind == ActivityStagePolicy.endedAnnouncement)
        #expect(presenter.announcementLog.filter { $0.hasPrefix(ActivityStagePolicy.startedAnnouncement) }.count == 1)
    }

    @Test func youAreInTheStripLastBeforeOverflowAndNeverFloatOverTheCard() {
        let presenter = stage(layered(ActivityFixtureState.gameTrivia6.rawValue))
        let slots = presenter.layout.slots
        #expect(slots.first?.role == StageSlotRole.activity)
        #expect(!slots.contains { $0.role == StageSlotRole.selfFloating || $0.role == StageSlotRole.selfMinimized })
        let local = slots.firstIndex { $0.id == StageSlot.participantId(StageFixtureScript.localUserId) }
        #expect(local != nil)
        if let overflow = slots.firstIndex(where: { $0.id == StageSlot.overflowId }), let local = local {
            #expect(overflow == slots.count - 1)
            #expect(local == overflow - 1)
        }
    }

    @Test func activitiesSessionSeesTheResolvedCard() {
        let shell = MeetingShellPresenter()
        let presenter = StagePresenter(shell: shell)
        let session = ActivitySession(shell: shell, stage: presenter)
        session.bindStage()
        session.applyActivities(ActivityFixtureScript.activitiesInputs(.appAndGame))
        session.applyGame(ActivityFixtureScript.gameInputs(.appAndGame))
        presenter.setViewport(StagePoliciesTests.iphoneSE)
        presenter.apply(layered(ActivityFixtureState.appAndGame.rawValue))
        let snapshot = session.activities.snapshot
        #expect(snapshot.nowPlaying.map { $0.id } == ["app", "game"])
        #expect(snapshot.nowPlayingItem(kind: .app)?.isOnStage == true)
        #expect(snapshot.nowPlayingItem(kind: .game)?.isOnStage == false)
    }

    @Test func iosContainerIsAFlatCardWithShowVideoAndKeyboardAvoidance() throws {
        let ios = try stageSource("Sources/Conclave/Features/Meeting/Stage/ActivityStage+iOS.swift")
        let flat = stageNormalized(ios)
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP\n"))
        #expect(flat.contains("static let cornerRadius: CGFloat = 16"))
        #expect(flat.contains(".background(HostingTheme.token(DesignTokens.iosInCallSurface), in: shape)"))
        #expect(flat.contains("shape.strokeBorder(HostingTheme.inCallBorder, lineWidth: 1)"))
        #expect(flat.contains(".modifier(KeyboardOverlapAvoidance(keyboardTopY: keyboard.keyboardTopY))"))
        #expect(flat.contains(".accessibilityAddTraits(.isToggle)"))
        #expect(flat.contains(".accessibilityValue(ConclaveStrings.text(\"Showing Activity\"))"))
        #expect(flat.contains("stage.setShowsVideoOverActivity(true)"))
        #expect(flat.contains(".accessibilityAddTraits(.isHeader)"))
        #expect(flat.contains("ActivitiesCopy.opening(parts.name)") && flat.contains("ActivitiesCopy.couldNotOpen(parts.name)"))

        let header = try #require(flat.range(of: "ActivityStageHeader(kind: kind, stage: stage, session: session)"))
        let body = try #require(flat.range(of: "ActivityStageBody(kind: kind, stage: stage, session: session)"))
        #expect(header.lowerBound < body.lowerBound)
        for forbidden in ["DetachedSelfViewOverlay", "selfFloating", ".ignoresSafeArea(.keyboard)", "MeetingViewModel"] {
            #expect(!ios.contains(forbidden), "ActivityStage+iOS.swift uses \(forbidden)")
        }
    }

    @Test func androidContainerPadsOnlyTheCardBodyForTheIme() throws {
        let kotlin = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/ActivityStage.kt"))
        #expect(kotlin.contains("shape = RoundedCornerShape(16.dp)"))
        #expect(kotlin.contains("color = MaterialTheme.colorScheme.surfaceContainer"))
        #expect(kotlin.contains("border = BorderStroke(1.dp, ext.border)"))
        #expect(kotlin.contains("windowInsetsPadding(WindowInsets.ime.only(WindowInsetsSides.Bottom))"))
        #expect(kotlin.contains("ConclaveIconToggleButton( description = conclaveString(\"stg_show_video\"), stateText = conclaveString(\"stg_showing_activity\")"))
        #expect(kotlin.contains("internal val LocalActivitySession = staticCompositionLocalOf<ActivitySession?> { null }"))
        #expect(kotlin.contains("semantics { heading() }"))
        for forbidden in ["imePadding()", "selfFloating", "MeetingViewModel", "FlexibleBottomSheet"] {
            #expect(!kotlin.contains(forbidden), "ActivityStage.kt uses \(forbidden)")
        }
    }

    @Test func activitySourcesStayFlatDashFreeAndSkipLite() throws {
        let files = try stageFiles(under: "Sources/Conclave/Features/Meeting/Activities", extensions: ["swift"])
            + stageFiles(under: "Sources/Conclave/Features/Meeting/Games/Native", extensions: ["swift"])
            + stageFiles(under: "Sources/Conclave/Skip/ui/activities", extensions: ["kt"])
            + stageFiles(under: "Sources/Conclave/Skip/ui/games", extensions: ["kt"])
            + ["Sources/Conclave/Features/Meeting/Stage/ActivityStage+iOS.swift", "Sources/Conclave/Skip/ui/call/stage/ActivityStage.kt",
               "Sources/Conclave/Skip/ui/copy/ActivitiesCopy.kt", "Sources/Conclave/Skip/ui/copy/GameCopy.kt"]
        #expect(files.count >= 25)
        for file in files {
            let text = try stageSource(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file) mentions a gradient")
            #expect(stageMatches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x)"#, in: text).isEmpty, "\(file) builds a color from a literal")
            for pattern in ["glassEffect", "ultraThinMaterial", "regularMaterial", "HapticManager", "MeetingViewModel.shared",
                            "Font.system(size:", "fontFeatureSettings", "fontFamily =", "dynamicDarkColorScheme"] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
        }
        let shared = try stageFiles(under: "Sources/Conclave/Features/Meeting/Activities", extensions: ["swift"])
            + stageFiles(under: "Sources/Conclave/Features/Meeting/Games/Native", extensions: ["swift"])
        for file in shared where !file.contains("+iOS") {
            let text = try stageSource(file)
            #expect(!text.contains("#if"), "\(file) is shared and must not branch by platform")
            #expect(stageMatches(#"\bprotocol\s"#, in: text).isEmpty, "\(file) declares a protocol")
            #expect(stageMatches(#"case\s+\w+\("#, in: text).isEmpty, "\(file) has an associated value")
            #expect(stageMatches(#"\.(map|compactMap|flatMap)\(\w+(\.init)?\)"#, in: text).isEmpty, "\(file) maps with a function reference")
            #expect(!text.contains("inout "), "\(file) uses inout")
            #expect(!text.contains("isLetter"), "\(file) uses Character.isLetter")
            #expect(stageMatches(#"\b[A-Z]\w*\.self\b"#, in: text).isEmpty, "\(file) passes a metatype")
            #expect(!text.contains("import SwiftUI"), "\(file) imports SwiftUI in shared code")
        }
        for file in files where file.hasSuffix("+iOS.swift") {
            let text = try stageSource(file)
            #expect(text.hasPrefix("#if os(iOS) && !SKIP\n") && text.hasSuffix("#endif\n"), "\(file) must be iOS only")
        }
    }
}
#endif
