#if !SKIP
import Testing
@testable import Conclave

@MainActor
struct OwnerStageControlsPolishTests {
    private func portrait(safeTop: Double = 47, safeBottom: Double = 34) -> StageViewport {
        StageViewportPolicy.iOS(contentWidth: 390, contentHeight: 844 - safeTop - safeBottom,
                                safeArea: StageChromeInsets(top: safeTop, bottom: safeBottom, leading: 0, trailing: 0),
                                regularWidth: false, compactHeight: false, topReserve: 56, barReserve: 64, trailingReserve: 64)
    }

    @Test func portraitUsesTheFullCanvasAndReservesSafeAreasOnce() {
        for (top, bottom) in [(47.0, 34.0), (20.0, 0.0), (0.0, 0.0)] {
            let viewport = portrait(safeTop: top, safeBottom: bottom)
            #expect(viewport.width == 390 && viewport.height == 844)
            let content = StageLayoutPolicy.contentFrame(viewport)
            #expect(content.y == top + 56 + 8)
            #expect(content.maxY == 844 - bottom - 64 - 8)
            #expect(content.height == 844 - top - bottom - 56 - 64 - 16)
        }
    }

    @Test func activityAndParticipantStripReachTheReservedBottomWithoutABlankBand() throws {
        let viewport = portrait()
        let slots = [StageSlot(id: StageSlot.activityId, role: .activity, userId: "", fit: .fit),
                     StageSlot(id: "p:peer", role: .rail, userId: "peer", fit: .fill),
                     StageSlot(id: "p:self", role: .rail, userId: "self", fit: .fill)]
        for kind in [StageKind.game, .app, .browser] {
            let frames = StageLayoutPolicy.frames(viewport: viewport, kind: kind, slots: slots, selfCorner: "bottom-right")
            let activity = try #require(StageLayoutPolicy.find(StageSlot.activityId, in: frames))
            let peer = try #require(StageLayoutPolicy.find("p:peer", in: frames))
            let local = try #require(StageLayoutPolicy.find("p:self", in: frames))
            #expect(activity.height == 512)
            #expect(peer.y == activity.maxY + 8)
            #expect(peer.maxY == 738 && local.maxY == 738)
            #expect(!StageLayoutPolicy.overlaps(activity, peer))
            #expect(!StageLayoutPolicy.overlaps(peer, local))
        }
    }

    @Test func landscapeReconstructsBothCutoutsAndClearsTrailingControls() {
        let viewport = StageViewportPolicy.iOS(contentWidth: 724, contentHeight: 354,
            safeArea: StageChromeInsets(top: 0, bottom: 21, leading: 59, trailing: 61),
            regularWidth: false, compactHeight: true, topReserve: 56, barReserve: 64, trailingReserve: 64)
        #expect(viewport.width == 844 && viewport.height == 375)
        #expect(viewport.placement == .trailingStack)
        let content = StageLayoutPolicy.contentFrame(viewport)
        #expect(content.x == 67 && content.maxX == 711)
        #expect(content.maxY == 334)
    }

    @Test func fullBleedVideoKeepsItsFrameWhileItsNameClearsControls() throws {
        let viewport = portrait()
        let slot = StageSlot(id: "p:self", role: .spotlightMain, userId: "self", fit: .fill)
        let frames = StageLayoutPolicy.frames(viewport: viewport, kind: .solo, slots: [slot], selfCorner: "bottom-right")
        let frame = try #require(frames.first)
        #expect(frame.x == 0 && frame.y == 0 && frame.width == 390 && frame.height == 844)
        let inset = StageViewportPolicy.tileInsets(kind: .solo, role: slot.role, viewport: viewport)
        #expect(inset.bottom + 8 - viewport.insetBottom == 16)
        #expect(StageViewportPolicy.tileInsets(kind: .game, role: .rail, viewport: viewport) == .zero)
        #expect(StageViewportPolicy.tileInsets(kind: .sidebar, role: .spotlightMain, viewport: viewport) == .zero)
        #expect(StageViewportPolicy.tileInsets(kind: .grid, role: .grid, viewport: viewport) == .zero)
    }

    @Test func avatarOnlyHeaderHidesWhileCallControlsStayAvailable() {
        let stage = StageFixtureSession(state: .audioOnly).stage
        #expect(stage.autoHideBlocker == .noRemoteVideo)
        let headerCanHide = ChromeAutoHidePolicy.canAutoHideHeader(blocker: stage.autoHideBlocker, voiceOver: false,
                                                                 switchControl: false, focusInChrome: false)
        let controlsCanHide = ChromeAutoHidePolicy.canAutoHide(blocker: stage.autoHideBlocker, voiceOver: false,
                                                             switchControl: false, focusInChrome: false)
        let hidden = ChromeAutoHidePolicy.reduce(.initial, event: .timerFired, canAutoHide: headerCanHide)
        #expect(hidden.isHidden && !controlsCanHide)
        #expect(!ChromeAutoHidePolicy.controlsHidden(hidden, canAutoHide: controlsCanHide))
        #expect(!ChromeAutoHidePolicy.reduce(hidden, event: .tap, canAutoHide: headerCanHide).isHidden)
        #expect(ChromeAutoHidePolicy.controlsHidden(hidden, canAutoHide: true))
    }

    @Test func protectedInteractionsAndAssistiveTechnologyKeepTheHeader() {
        for blocker in AutoHideBlocker.allCases where blocker != .none && blocker != .noRemoteVideo {
            #expect(!ChromeAutoHidePolicy.canAutoHideHeader(blocker: blocker, voiceOver: false,
                                                          switchControl: false, focusInChrome: false))
        }
        for blocker in [AutoHideBlocker.none, .noRemoteVideo] {
            #expect(!ChromeAutoHidePolicy.canAutoHideHeader(blocker: blocker, voiceOver: true, switchControl: false, focusInChrome: false))
            #expect(!ChromeAutoHidePolicy.canAutoHideHeader(blocker: blocker, voiceOver: false, switchControl: true, focusInChrome: false))
            #expect(!ChromeAutoHidePolicy.canAutoHideHeader(blocker: blocker, voiceOver: false, switchControl: false, focusInChrome: true))
        }
    }

    @Test func captionsMenuActionPreservesStateAndTwoLineBudget() throws {
        let session = ControlsFixtureSession(state: .guest)
        let before = session.controls.moreMetrics
        #expect(session.controls.setCaptions(true) == .dispatched)
        let enabled = try #require(session.controls.more.item(.captions))
        #expect(enabled.isOn && MoreMenuPolicy.hasSubtitle(enabled))
        #expect(session.controls.moreMetrics == before)
        #expect(session.controls.setCaptions(false) == .dispatched)
        #expect(session.controls.more.item(.captions)?.isOn == false)
        #expect(session.controls.moreMetrics == before)
    }
}
#endif
