#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ACT10ActivityChromeTests {
    private func host(_ state: AppHostFixtureState) -> AppHostPresenter {
        let presenter = AppHostPresenter()
        _ = AppHostFixtures.apply(named: state.rawValue, presenter: presenter, owner: AppHostFixtureOwner())
        return presenter
    }

    private func browser(_ state: BrowserStageFixtureState) -> BrowserStagePresenter {
        let presenter = BrowserStagePresenter()
        presenter.sleep = { _ in try? await Task.sleep(nanoseconds: 3_600_000_000_000) }
        BrowserStageFixtures.apply(named: state.rawValue, presenter: presenter, owner: BrowserFixtureOwner())
        return presenter
    }

    private func activities(_ inputs: ActivitiesInputs) -> ActivitiesSnapshot {
        let presenter = ActivitiesPresenter()
        presenter.apply(inputs)
        return presenter.snapshot
    }

    private func model(_ base: AppHostModel, appId: String? = nil, phase: AppHostPhase? = nil, isLocked: Bool? = nil,
                       canEdit: Bool? = nil, tag: AppHostTag? = nil, editorCount: Int? = nil, nameCount: Int? = nil,
                       playback: String? = nil, hasEmbed: Bool? = nil) -> AppHostModel {
        AppHostModel(revision: base.revision, appId: appId ?? base.appId, appSessionId: base.appSessionId, phase: phase ?? base.phase,
                     issue: base.issue, isLocked: isLocked ?? base.isLocked, canEdit: canEdit ?? base.canEdit, canClose: base.canClose,
                     canLock: base.canLock, closePending: base.closePending, lockPending: base.lockPending, tag: tag ?? base.tag,
                     bundleVersion: base.bundleVersion, editorCount: editorCount ?? base.editorCount,
                     nameCount: nameCount ?? base.nameCount, playback: playback ?? base.playback, hasEmbed: hasEmbed ?? base.hasEmbed,
                     reloadSerial: base.reloadSerial, wantsWebView: base.wantsWebView)
    }

    @Test func openingAppShowsALoadingBlockAndAnOpeningStatusInsteadOfLive() {
        let presenter = host(.whiteboardReady)
        #expect(presenter.model.phase == .opening)
        #expect(AppHostChromePolicy.statusBlock(presenter.model) == ActivityStatusBlock.loading)
        #expect(AppHostChromePolicy.statusLine(presenter.model) == .opening)
        #expect(AppHostChromePolicy.bar(presenter.model) == .none, "tools stay hidden until the board is ready")
        #expect(AppHostChromePolicy.chip(presenter.model) == .none)
    }

    @Test func failuresOfferRetryOnlyWhenTheEmbedCanReload() {
        let gone = host(.rendererGone).model
        let goneBlock = AppHostChromePolicy.statusBlock(gone)
        #expect(goneBlock.kind == .failure && goneBlock.needsUpdate == false)
        #expect(goneBlock.showsRetry == gone.hasEmbed)
        #expect(AppHostChromePolicy.statusLine(gone) == .unavailable)

        let mismatch = host(.versionMismatch).model
        let mismatchBlock = AppHostChromePolicy.statusBlock(mismatch)
        #expect(mismatchBlock.kind == .failure && mismatchBlock.needsUpdate && !mismatchBlock.showsRetry)
        #expect(AppHostChromePolicy.chip(mismatch) == .none, "a failed app shows no status chip over the failure")

        #expect(AppHostChromePolicy.statusBlock(model(gone, phase: .failed, hasEmbed: true)).showsRetry)
        #expect(!AppHostChromePolicy.statusBlock(model(gone, phase: .failed, hasEmbed: false)).showsRetry)
    }

    @Test func reconnectingStaysVisibleWhileTheBoardReopens() {
        let reconnecting = host(.whiteboardReconnecting).model
        #expect(reconnecting.tag == .reconnecting)
        #expect(AppHostChromePolicy.chip(reconnecting) == .reconnecting)
        #expect(AppHostChromePolicy.chip(model(reconnecting, phase: .opening, tag: .viewOnly)) == AppHostTag.none)
    }

    @Test func viewOnlyChipCarriesTheLockSoTheHeaderDoesNotRepeatIt() {
        let viewer = model(host(.whiteboardViewOnly).model, phase: .readOnly)
        #expect(AppHostChromePolicy.chip(viewer) == .viewOnly)
        #expect(AppHostChromePolicy.chipShowsLock(.viewOnly) && AppHostChromePolicy.chipShowsLock(.lockedForOthers))
        #expect(!AppHostChromePolicy.chipShowsLock(.reconnecting))
        #expect(AppHostChromePolicy.statusLine(viewer) != .locked)

        let lockedHost = model(host(.whiteboardLockedHost).model, phase: .ready)
        #expect(AppHostChromePolicy.chip(lockedHost) == .lockedForOthers)
        #expect(AppHostChromePolicy.statusLine(lockedHost) != .locked)

        let lockedNoChip = model(lockedHost, tag: AppHostTag.none)
        #expect(AppHostChromePolicy.statusLine(lockedNoChip) == .locked)
    }

    @Test func statusLinePrefersAppSpecificFactsOnceReady() {
        let base = model(host(.whiteboardReady).model, phase: .ready)
        #expect(AppHostChromePolicy.statusLine(model(base, editorCount: 2)) == .editors)
        #expect(AppHostChromePolicy.statusLine(model(base, editorCount: 0)) == AppHostStatusLine.none)
        #expect(AppHostChromePolicy.statusLine(model(base, appId: "wheel", nameCount: 6)) == .names)
        #expect(AppHostChromePolicy.statusLine(model(base, appId: "watch", playback: "paused")) == .playback)
        #expect(AppHostChromePolicy.statusLine(model(base, appId: "watch", playback: "none")) == AppHostStatusLine.none)
        #expect(AppHostChromePolicy.statusLine(model(base, appId: "")) == AppHostStatusLine.none)
        #expect(AppHostChromePolicy.statusLine(AppHostModel.empty) == .opening, "an app that has not bound yet reads as opening, not live")
    }

    @Test func barAppearsOnlyForEditorsOfAReadyBoardOrWheel() {
        let base = model(host(.whiteboardReady).model, phase: .ready, canEdit: true)
        #expect(AppHostChromePolicy.bar(base) == .whiteboard)
        #expect(AppHostChromePolicy.bar(model(base, phase: .closing)) == .whiteboard)
        #expect(AppHostChromePolicy.bar(model(base, appId: "wheel")) == .wheel)
        #expect(AppHostChromePolicy.bar(model(base, appId: "watch")) == .none)
        #expect(AppHostChromePolicy.bar(model(base, canEdit: false)) == .none)
        #expect(AppHostChromePolicy.bar(model(base, phase: .readOnly)) == .none)
        #expect(AppHostChromePolicy.showsBoardHint(base, elementCount: 0, pageId: "page-1"))
        #expect(!AppHostChromePolicy.showsBoardHint(base, elementCount: 3, pageId: "page-1"))
        #expect(!AppHostChromePolicy.showsBoardHint(base, elementCount: 0, pageId: ""))
        #expect(!AppHostChromePolicy.showsBoardHint(model(base, canEdit: false), elementCount: 0, pageId: "page-1"))
    }

    @Test func browserStatesMapToOneBlockOrChip() {
        #expect(BrowserChromePolicy.statusBlock(browser(.starting).model) == ActivityStatusBlock.loading)
        let failed = BrowserChromePolicy.statusBlock(browser(.failed).model)
        #expect(failed.kind == .failure && failed.showsRetry)
        #expect(BrowserChromePolicy.statusBlock(browser(.rendererGone).model).kind == .failure)
        let reconnecting = browser(.reconnecting).model
        #expect(BrowserChromePolicy.statusBlock(reconnecting) == ActivityStatusBlock.none)
        #expect(BrowserChromePolicy.showsReconnectingChip(reconnecting))
        let live = browser(.controller).model
        #expect(BrowserChromePolicy.statusBlock(live) == ActivityStatusBlock.none)
        #expect(!BrowserChromePolicy.showsReconnectingChip(live))
        #expect(BrowserChromePolicy.canFocusKeyboard(live) == (live.inputInteractive && live.hasSurface))
    }

    @Test func browserSectionIsHiddenWhenAParticipantWouldSeeAnEmptyHeader() {
        let participant = activities(ActivityFixtureScript.activitiesInputs(.activitiesParticipantIdle))
        #expect(participant.role == .participant && participant.browser.isAvailable && !participant.browser.hasAudio)
        #expect(!ActivitiesSectionPolicy.showsBrowserSection(participant))

        let hostIdle = activities(ActivityFixtureScript.activitiesInputs(.activitiesHostIdle))
        #expect(ActivitiesSectionPolicy.showsBrowserSection(hostIdle))

        let listening = activities(ActivitiesInputs.make(callSession: 1, isHost: false, isBrowserAvailable: true, isBrowserActive: true,
                                                         browserHostLabel: "example.com", hasBrowserAudio: true))
        #expect(ActivitiesSectionPolicy.showsBrowserSection(listening), "a participant keeps the audio toggle")

        let unavailable = activities(ActivitiesInputs.make(callSession: 1, isHost: true, isBrowserAvailable: false))
        #expect(!ActivitiesSectionPolicy.showsBrowserSection(unavailable))
    }

    @Test func appsLockToggleIsDisabledWithNothingToLock() {
        let idle = activities(ActivityFixtureScript.activitiesInputs(.activitiesHostIdle))
        #expect(idle.appsReason == .noAppOpen && !ActivitiesSectionPolicy.canToggleAppsLock(idle))
        let open = activities(ActivitiesInputs.make(callSession: 1, isHost: true, activeAppId: "whiteboard"))
        #expect(ActivitiesSectionPolicy.canToggleAppsLock(open))
        let presenter = ActivitiesPresenter()
        presenter.sleep = { _ in try? await Task.sleep(nanoseconds: 3_600_000_000_000) }
        presenter.apply(ActivitiesInputs.make(callSession: 1, isHost: true, activeAppId: "whiteboard"))
        presenter.setAppsLocked(true)
        presenter.apply(ActivitiesInputs.make(callSession: 1, isHost: true, activeAppId: "whiteboard", isAppsActionInFlight: true))
        #expect(presenter.snapshot.appsLockPending)
        #expect(!ActivitiesSectionPolicy.canToggleAppsLock(presenter.snapshot))
        let recovering = activities(ActivitiesInputs.make(callSession: 1, isHost: true, isRecovering: true, activeAppId: "whiteboard"))
        #expect(!ActivitiesSectionPolicy.canToggleAppsLock(recovering))
    }

    @Test func eachAppGetsItsOwnGlyph() {
        #expect(ActivityGlyphPolicy.glyph(kind: "app", appId: "whiteboard") == .whiteboard)
        #expect(ActivityGlyphPolicy.glyph(kind: "app", appId: "wheel") == .wheel)
        #expect(ActivityGlyphPolicy.glyph(kind: "app", appId: "watch") == .watch)
        #expect(ActivityGlyphPolicy.glyph(kind: "app", appId: "unknown") == .app)
        #expect(ActivityGlyphPolicy.glyph(kind: "browser", appId: "") == .browser)
        #expect(ActivityGlyphPolicy.glyph(kind: "game", appId: "") == .game)
        #expect(ActivityGlyphPolicy.glyph(kind: "", appId: "whiteboard") == .game)
        let glyphs = Set(["whiteboard", "wheel", "watch"].map { ActivityGlyphPolicy.glyph(kind: "app", appId: $0) })
        #expect(glyphs.count == 3)
    }

    @Test func toolbarCoversEveryToolExactlyOnce() {
        let all = WhiteboardToolbarPolicy.drawingTools + WhiteboardToolbarPolicy.shapeTools + WhiteboardToolbarPolicy.markupTools
        #expect(Set(all) == Set(AppWhiteboardTool.allCases) && all.count == AppWhiteboardTool.allCases.count)
        #expect(WhiteboardToolbarPolicy.shapeTools.allSatisfy { $0.isShape })
        let overflow = Set(WhiteboardToolbarPolicy.moreCommands)
        #expect(overflow.isSuperset(of: Set(WhiteboardToolbarPolicy.pageCommands)))
        #expect(overflow.contains(.zoomToFit) && overflow.contains(.export) && !overflow.contains(.undo) && !overflow.contains(.redo))
    }

    @Test func shapeButtonReflectsTheActiveShape() {
        #expect(WhiteboardToolbarPolicy.shapeGlyph(current: "ellipse") == .ellipse)
        #expect(WhiteboardToolbarPolicy.shapeGlyph(current: "pen") == .rect)
        #expect(WhiteboardToolbarPolicy.shapeGlyph(current: "nonsense") == .rect)
        #expect(WhiteboardToolbarPolicy.isShapeSelected(current: "arrow"))
        #expect(!WhiteboardToolbarPolicy.isShapeSelected(current: "eraser"))
        #expect(WhiteboardToolbarPolicy.isSelected(.eraser, current: "eraser"))
        #expect(!WhiteboardToolbarPolicy.isSelected(.pen, current: "eraser"))
    }

    @Test func overflowShowsPendingWhileAnyPageCommandIsInFlight() {
        let idle = AppToolbarModel.empty
        #expect(!WhiteboardToolbarPolicy.isPending(WhiteboardToolbarPolicy.moreCommands, toolbar: idle))
        #expect(!WhiteboardToolbarPolicy.canRenamePage(idle) && !WhiteboardToolbarPolicy.canDeletePage(idle))
        let busy = AppToolbarModel(revision: 1, tool: idle.tool, previousTool: idle.previousTool, color: idle.color,
                                   strokeWidth: idle.strokeWidth, filled: idle.filled, canUndo: true, canRedo: false,
                                   pageId: "p1", pageName: "Page 1",
                                   pages: [AppPageModel(id: "p1", name: "Page 1", isCurrent: true),
                                           AppPageModel(id: "p2", name: "Page 2", isCurrent: false)],
                                   elementCount: 0, pendingKinds: [AppHostCommandKind.export.rawValue], exportSequence: 0,
                                   exportFailed: false)
        #expect(WhiteboardToolbarPolicy.isPending(WhiteboardToolbarPolicy.moreCommands, toolbar: busy))
        #expect(!WhiteboardToolbarPolicy.isPending(WhiteboardToolbarPolicy.shapeCommands, toolbar: busy))
        #expect(WhiteboardToolbarPolicy.canRenamePage(busy) && WhiteboardToolbarPolicy.canDeletePage(busy))
    }
}
#endif
