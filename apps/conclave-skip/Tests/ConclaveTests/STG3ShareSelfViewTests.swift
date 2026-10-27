#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// STG-3 (OUT/PLAN-screens.md section 5): screen-share viewing, the local presenter state and the self view. The shared
/// `ShareZoomPolicy`, `ShareAnnouncementPolicy`, `SelfViewSnapPolicy` and `StageCameraFlip` (HD request B5-T8 R1), the
/// presenter behavior they feed, the one camera owner (`LocalPreviewController`, SC8 and S60 C6-2 as one delta), the SC8
/// view model rows (macOS suite) and source scans of the iOS and Compose files the macOS host does not compile. Covers
/// S20 5 l and 6 l where a host can check them; the gesture, render-target and silent runtime cells are in
/// HD/slices/B5-T8.md.
///
/// Dependencies on HD/requests/B5-T8.md (applied by the batch integrator): R1 (the policy file: every test here needs
/// it to compile), R2 and R3 a (the chrome's flip-in-flight and paused fields), R3 b (share tokens and the presenting
/// announcement), R4 (Move items dispatch), R5 (the self view size in the canvas frames), R6 and R7 (the view model
/// rows). Tests that need one say so.
@MainActor
struct STG3ShareSelfViewTests {
    static let slotWidth = 375.0
    static let slotHeight = 667.0
    static let videoWidth = 1920.0
    static let videoHeight = 1080.0

    private func presenter(_ inputs: StageInputs, viewport: StageViewport = StagePoliciesTests.iphoneSE) -> StagePresenter {
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.setViewport(viewport)
        stage.apply(inputs)
        return stage
    }

    /// The 1:1 fixture (your camera on) with the STG-3 inputs set directly (`StageFixtureScript.copy` gains them with R11).
    private func oneOnOne(corner: String = "bottom-right", cameraOn: Bool = true, flipInFlight: Bool = false,
                          paused: Bool = false, localShare: Bool = false, count: Int = 2) -> StageInputs {
        let base = StageFixtureScript.base(count: count, localCameraOn: cameraOn)
        return StageInputs.make(callSession: base.callSession, isInCall: true, localUserId: base.localUserId,
                                roomLabel: base.roomLabel, meetingLink: base.meetingLink, participants: base.participants,
                                selfViewCorner: corner, screenShareUserId: localShare ? base.localUserId : "",
                                isLocalScreenSharing: localShare, isAloneConfirmed: false, canFlipCamera: true,
                                isFrontCamera: true, isFlipInFlight: flipInFlight, isCameraPaused: paused,
                                routeKind: "speaker", routeName: "Speaker", joinedAtMillis: base.joinedAtMillis)
    }

    private func live(_ start: ShareZoomValue, magnification: Double, anchorX: Double, anchorY: Double, dx: Double = 0,
                      dy: Double = 0) -> ShareZoomValue {
        ShareZoomPolicy.live(start: start, magnification: magnification, anchorX: anchorX, anchorY: anchorY, translationX: dx,
                             translationY: dy, slotWidth: Self.slotWidth, slotHeight: Self.slotHeight,
                             videoWidth: Self.videoWidth, videoHeight: Self.videoHeight)
    }

    private func settled(_ value: ShareZoomValue) -> ShareZoomValue {
        ShareZoomPolicy.settled(value, slotWidth: Self.slotWidth, slotHeight: Self.slotHeight, videoWidth: Self.videoWidth,
                                videoHeight: Self.videoHeight)
    }

    // MARK: Share zoom (S20 5 c, d, h, k, l)

    @Test func zoomStaysBetweenOneAndFourAndAnOvershootSpringsBack() {
        let over = live(ShareZoomValue.identity, magnification: 6, anchorX: 187.5, anchorY: 333.5)
        #expect(over.scale == ShareZoomPolicy.overshootMaximum)
        #expect(settled(over) == ShareZoomValue(scale: 4, panX: 0, panY: 0))
        let under = live(ShareZoomValue.identity, magnification: 0.5, anchorX: 187.5, anchorY: 333.5)
        #expect(under.scale == ShareZoomPolicy.overshootMinimum)
        #expect(settled(under) == ShareZoomValue.identity)
        // A release within 2% of 1x is exactly 1x with no pan; a release inside bounds stays put.
        #expect(settled(ShareZoomValue(scale: 1.01, panX: 3, panY: 2)) == ShareZoomValue.identity)
        let inside = ShareZoomValue(scale: 2.5, panX: 100, panY: 0)
        #expect(settled(inside) == inside)
        #expect(!ShareZoomValue.identity.isZoomed && inside.isZoomed)
    }

    @Test func aPinchToThreeTimesKeepsTheContentEdgesInsideTheSlot() {
        // Fixture presentation-remote (S20 5 l): the 1920 x 1080 pattern fitted on 375 x 667 is 375 x 210.9375.
        let contentHeight = ShareZoomPolicy.contentHeight(slotWidth: Self.slotWidth, slotHeight: Self.slotHeight,
                                                          videoWidth: Self.videoWidth, videoHeight: Self.videoHeight)
        #expect(abs(contentHeight - 210.9375) < 0.0001)
        // Pinch to 3x around the top left corner, then drag far right and down.
        let value = live(ShareZoomValue.identity, magnification: 3, anchorX: 0, anchorY: 0, dx: 5000, dy: 5000)
        #expect(value.scale == 3)
        let contentWidth = Self.slotWidth * 3
        #expect(abs(value.panX - (contentWidth - Self.slotWidth) / 2) < 0.0001)
        let left = Self.slotWidth / 2 + value.panX - contentWidth / 2
        #expect(left <= 0.0001 && left + contentWidth >= Self.slotWidth - 0.0001)
        // A content side still smaller than the slot stays centered; at 4x it pans up to its own edge.
        #expect(value.panY == 0)
        let limit = ShareZoomPolicy.maximumPanY(scale: 4, slotWidth: Self.slotWidth, slotHeight: Self.slotHeight,
                                                videoWidth: Self.videoWidth, videoHeight: Self.videoHeight)
        #expect(abs(limit - (210.9375 * 4 - Self.slotHeight) / 2) < 0.0001)
        // Before the frame size is known the slot itself is the content.
        #expect(ShareZoomPolicy.maximumPanX(scale: 2, slotWidth: Self.slotWidth, slotHeight: Self.slotHeight, videoWidth: 0,
                                            videoHeight: 0) == 187.5)
    }

    @Test func doubleTapTogglesOneAndTwoTimesAtTheTapPoint() {
        let tapped = ShareZoomPolicy.doubleTapped(ShareZoomValue.identity, atX: 300, atY: 333.5, slotWidth: Self.slotWidth,
                                                  slotHeight: Self.slotHeight, videoWidth: Self.videoWidth,
                                                  videoHeight: Self.videoHeight)
        #expect(tapped.scale == ShareZoomPolicy.doubleTapScale)
        // The content point under the finger stays under it.
        let localX = 300 - Self.slotWidth / 2
        #expect(abs((localX - tapped.panX) / tapped.scale - localX) < 0.0001)
        #expect(tapped.panY == 0)
        #expect(ShareZoomPolicy.doubleTapped(tapped, atX: 10, atY: 10, slotWidth: Self.slotWidth, slotHeight: Self.slotHeight,
                                             videoWidth: Self.videoWidth, videoHeight: Self.videoHeight) == ShareZoomValue.identity)
        // At the slot edge the pan stops at the content edge.
        let edge = ShareZoomPolicy.doubleTapped(ShareZoomValue.identity, atX: Self.slotWidth, atY: 333.5, slotWidth: Self.slotWidth,
                                                slotHeight: Self.slotHeight, videoWidth: Self.videoWidth,
                                                videoHeight: Self.videoHeight)
        #expect(edge.panX == -187.5)
    }

    @Test func accessibilityZoomStepsThroughOneTwoAndFour() {
        #expect(ShareZoomPolicy.steppedScale(fromScale: 1, zoomIn: true) == 2)
        #expect(ShareZoomPolicy.steppedScale(fromScale: 2, zoomIn: true) == 4)
        #expect(ShareZoomPolicy.steppedScale(fromScale: 4, zoomIn: true) == 4)
        #expect(ShareZoomPolicy.steppedScale(fromScale: 1.5, zoomIn: true) == 2)
        #expect(ShareZoomPolicy.steppedScale(fromScale: 4, zoomIn: false) == 2)
        #expect(ShareZoomPolicy.steppedScale(fromScale: 3, zoomIn: false) == 2)
        #expect(ShareZoomPolicy.steppedScale(fromScale: 2, zoomIn: false) == 1)
        let stepped = ShareZoomPolicy.stepped(ShareZoomValue.identity, zoomIn: true, slotWidth: Self.slotWidth,
                                              slotHeight: Self.slotHeight, videoWidth: Self.videoWidth, videoHeight: Self.videoHeight)
        #expect(stepped == ShareZoomValue(scale: 2, panX: 0, panY: 0))
        #expect(ShareZoomPolicy.stepped(stepped, zoomIn: false, slotWidth: Self.slotWidth, slotHeight: Self.slotHeight,
                                        videoWidth: Self.videoWidth, videoHeight: Self.videoHeight) == ShareZoomValue.identity)
        // "Zoom 2x", "Zoom 2.5x": one decimal, a whole number without it.
        #expect(ShareZoomPolicy.spokenScale(2.04) == 2 && ShareZoomPolicy.isWholeScale(2.04))
        #expect(ShareZoomPolicy.spokenScale(2.46) == 2.5 && !ShareZoomPolicy.isWholeScale(2.46))
    }

    @Test func theRendererIsLaidOutOncePerSettledZoomCappedAtTheFrame() {
        // iOS at 3x: the fitted content is 1125 x 632.8 px, so the drawable never passes 1920 / 1125 of the slot.
        let cap = Self.videoWidth / 1125.0
        #expect(abs(ShareZoomPolicy.layoutScale(scale: 3, slotWidth: Self.slotWidth, slotHeight: Self.slotHeight, pixelsPerUnit: 3,
                                                videoWidth: Self.videoWidth, videoHeight: Self.videoHeight) - cap) < 0.0001)
        #expect(ShareZoomPolicy.layoutScale(scale: 1.5, slotWidth: Self.slotWidth, slotHeight: Self.slotHeight, pixelsPerUnit: 3,
                                            videoWidth: Self.videoWidth, videoHeight: Self.videoHeight) == 1.5)
        #expect(ShareZoomPolicy.layoutScale(scale: 3, slotWidth: Self.slotWidth, slotHeight: Self.slotHeight, pixelsPerUnit: 3,
                                            videoWidth: 0, videoHeight: 0) == 3)
        // A frame smaller than the view never lays the renderer out below 1x.
        #expect(ShareZoomPolicy.layoutScale(scale: 2, slotWidth: Self.slotWidth, slotHeight: Self.slotHeight, pixelsPerUnit: 3,
                                            videoWidth: 640, videoHeight: 360) == 1)
        // Android measures the slot in pixels: a 1920 x 1080 share on a 1080 px wide view caps at 1920 / 1080 (S20 5 d).
        #expect(abs(ShareZoomPolicy.layoutScale(scale: 2, slotWidth: 1080, slotHeight: 1920, pixelsPerUnit: 1,
                                                videoWidth: Self.videoWidth, videoHeight: Self.videoHeight) - 1920.0 / 1080.0) < 0.0001)
        // 20 zoom cycles (pinch to 3x and settle, double tap back) end at 1x: one settled layout per settle (S20 5 l).
        var value = ShareZoomValue.identity
        var layouts: [Double] = []
        for _ in 0..<20 {
            value = settled(live(value, magnification: 3, anchorX: 187.5, anchorY: 333.5))
            layouts.append(ShareZoomPolicy.layoutScale(scale: value.scale, slotWidth: Self.slotWidth, slotHeight: Self.slotHeight,
                                                       pixelsPerUnit: 3, videoWidth: Self.videoWidth, videoHeight: Self.videoHeight))
            value = ShareZoomPolicy.doubleTapped(value, atX: 0, atY: 0, slotWidth: Self.slotWidth, slotHeight: Self.slotHeight,
                                                 videoWidth: Self.videoWidth, videoHeight: Self.videoHeight)
            layouts.append(ShareZoomPolicy.layoutScale(scale: value.scale, slotWidth: Self.slotWidth, slotHeight: Self.slotHeight,
                                                       pixelsPerUnit: 3, videoWidth: Self.videoWidth, videoHeight: Self.videoHeight))
        }
        #expect(value == ShareZoomValue.identity && layouts.count == 40)
        #expect(ShareZoomPolicy.interpolated(start: ShareZoomValue.identity, end: ShareZoomValue(scale: 3, panX: 10, panY: -10),
                                             fraction: 0.5) == ShareZoomValue(scale: 2, panX: 5, panY: -5))
    }

    @Test func onlyTheMainShareOfARemotePresenterZooms() {
        #expect(ShareZoomPolicy.isZoomable(slotId: "share:r1", role: .share, isLocal: false))
        // A pin is set: the share is the first rail slot, zoom unavailable until it is main (S20 4 a, 5 f).
        #expect(!ShareZoomPolicy.isZoomable(slotId: "share:r1", role: .rail, isLocal: false))
        // Your own share shows the placeholder, never your screen (Q8).
        #expect(!ShareZoomPolicy.isZoomable(slotId: "share:you", role: .share, isLocal: true))
        #expect(!ShareZoomPolicy.isZoomable(slotId: "p:r1", role: .spotlightMain, isLocal: false))
        let pinned = presenter(StageFixtureScript.inputs(for: .presentationPinned))
        #expect(pinned.layout.slots.contains { $0.id == "share:r1" && $0.role == .rail })
        let sharing = presenter(StageFixtureScript.inputs(for: .presentation))
        #expect(sharing.layout.slots.first.map { $0.id == "share:r1" && $0.role == .share && $0.fit == .fit } == true)
    }

    @Test func theLandscapeStripHidesWithChromeWhereTheVisibilityReportSaysSo() {
        let viewport = StagePoliciesTests.androidLandscape
        let stage = presenter(StageFixtureScript.inputs(for: .presentation), viewport: viewport)
        let report = StageVisibilityPolicy.report(frames: stage.currentFrames(), slots: stage.layout.slots, viewport: viewport,
                                                  kind: stage.layout.kind, coverage: StageVisibilityPolicy.coverageNone,
                                                  chromeHidden: true, isInPip: false, pipTarget: nil)
        let rails = stage.layout.slots.filter { $0.role == .rail }
        #expect(!rails.isEmpty)
        for slot in rails {
            #expect(ShareZoomPolicy.railHidesWithChrome(kind: stage.layout.kind, role: slot.role,
                                                        isCompactHeight: StageLayoutPolicy.isCompactHeight(viewport)))
            #expect(!report.visibleUserIds.contains(slot.userId) || slot.id.hasPrefix("share:"))
        }
        #expect(report.visibleShareUserId == "r1")
        // Portrait keeps the strip; other kinds keep their rail.
        #expect(!ShareZoomPolicy.railHidesWithChrome(kind: .presentation, role: .rail,
                                                     isCompactHeight: StageLayoutPolicy.isCompactHeight(StagePoliciesTests.iphoneSE)))
        #expect(!ShareZoomPolicy.railHidesWithChrome(kind: .spotlight, role: .rail, isCompactHeight: true))
        #expect(!ShareZoomPolicy.railHidesWithChrome(kind: .presentation, role: .share, isCompactHeight: true))
    }

    // MARK: The local presenter (S20 5 a, b, e, f, g, j)

    @Test func yourShareShowsThePlaceholderSlotTheCapsuleAndTheStopBanner() {
        let stage = presenter(oneOnOne(count: 4))
        let start = stage.feedbackState.token.sequence
        stage.apply(oneOnOne(localShare: true, count: 4))
        #expect(stage.layout.kind == .presentation && stage.layout.isLocalPresenting)
        #expect(stage.layout.slots.first.map { $0.id == StageSlot.shareId("you") && $0.role == .share } == true)
        #expect(stage.capsule.subtitleKind == StageCapsuleModel.youPresentingKind)
        #expect(stage.autoHideBlocker == .presenting)
        #expect(!ShareZoomPolicy.isZoomable(slotId: StageSlot.shareId("you"), role: .share, isLocal: true))
        // STG-5's banner lane carries "You're sharing your screen" with Stop Sharing (S20 5 b, 10).
        stage.applyNotices(StageNoticeInputs.make(callSession: 1, isHost: true, localUserId: "you", participantCount: 4,
                                                  isScreenSharing: true))
        #expect(stage.banner?.kind == NoticeKind.sharing)
        #expect(stage.banner?.actions.map(\.id) == [NoticeAction.stopSharing])
        // Needs R3 b: the stage publishes shareStarted, then shareStopped (S20 0.5 token table, RECONCILE R12).
        #expect(stage.feedbackState.token.kind == .shareStarted && stage.feedbackState.token.sequence == start + 1)
        stage.apply(oneOnOne(count: 4))
        #expect(stage.feedbackState.token.kind == .shareStopped && stage.feedbackState.token.sequence == start + 2)
    }

    @Test func aRemoteShareAnnouncesItsPresenterOnceAndNeverOnEntry() {
        let base = StageFixtureScript.base(count: 4)
        let sharing = StageFixtureScript.inputs(for: .presentation)
        #expect(ShareAnnouncementPolicy.startedPresenterName(previous: base, next: sharing) == "Avery")
        #expect(ShareAnnouncementPolicy.startedPresenterName(previous: sharing, next: sharing) == "")
        #expect(ShareAnnouncementPolicy.startedPresenterName(previous: StageInputs.make(), next: sharing) == "")
        #expect(ShareAnnouncementPolicy.startedPresenterName(previous: oneOnOne(count: 4), next: oneOnOne(localShare: true, count: 4)) == "")
        #expect(ShareAnnouncementPolicy.localShareFeedback(previous: oneOnOne(count: 4), next: oneOnOne(localShare: true, count: 4))
                == .shareStarted)
        #expect(ShareAnnouncementPolicy.localShareFeedback(previous: StageInputs.make(), next: oneOnOne(localShare: true, count: 4)) == nil)
        // Needs R3 b: one polite announcement on the stage channel.
        let stage = presenter(base)
        stage.apply(sharing)
        #expect(stage.announcementLog.last == ShareAnnouncementPolicy.presentingKind + ":Avery")
        stage.apply(sharing)
        #expect(stage.announcementLog.filter { $0.hasPrefix(ShareAnnouncementPolicy.presentingKind) }.count == 1)
    }

    // MARK: The self view (S20 6 c, d, e, h, i, l)

    @Test func theFloatingSelfViewIsPortraitAndSizedFromTheShortEdge() {
        #expect(SelfViewSnapPolicy.floatingWidth(StagePoliciesTests.iphoneSE) == 105)
        #expect(SelfViewSnapPolicy.floatingHeight(StagePoliciesTests.iphoneSE) == 140)
        let narrow = StageViewport(width: 320, height: 568, insetTop: 76, insetBottom: 64, insetLeading: 0, insetTrailing: 0,
                                   widthClass: StageSizeClass.compact, heightClass: StageSizeClass.regular, placement: .bottomBar)
        #expect(SelfViewSnapPolicy.floatingWidth(narrow) == 96)
        let wide = StageViewport(width: 500, height: 900, insetTop: 76, insetBottom: 64, insetLeading: 0, insetTrailing: 0,
                                 widthClass: StageSizeClass.compact, heightClass: StageSizeClass.regular, placement: .bottomBar)
        #expect(SelfViewSnapPolicy.floatingWidth(wide) == 132)
        #expect(SelfViewSnapPolicy.floatingWidth(StagePoliciesTests.ipadPortrait) == 160)
        #expect(abs(SelfViewSnapPolicy.floatingWidth(StagePoliciesTests.android360) - 100.8) < 0.0001)
        #expect(abs(SelfViewSnapPolicy.floatingWidth(StagePoliciesTests.androidLandscape) - 100.8) < 0.0001)
        // Landscape phones stay portrait (S20 6 c; 6 m replaces the 136 x 80 landscape tile). Needs R5 in the frames.
        let landscape = StageViewport(width: 667, height: 375, insetTop: 56, insetBottom: 12, insetLeading: 0, insetTrailing: 64,
                                      widthClass: StageSizeClass.compact, heightClass: StageSizeClass.compact,
                                      placement: .trailingStack)
        #expect(SelfViewSnapPolicy.floatingWidth(landscape) == 105)
        let stage = presenter(StageFixtureScript.inputs(for: .oneOnOne), viewport: landscape)
        let frame = StageLayoutPolicy.find("p:you", in: stage.currentFrames())
        #expect(frame.map { abs($0.width - 105) < 0.0001 && abs($0.height - 140) < 0.0001 } == true)
        // S20 6 l: 3:4 at the bottom trailing corner, 105 wide on 375 pt.
        let portrait = presenter(StageFixtureScript.inputs(for: .oneOnOne))
        let corner = StageLayoutPolicy.find("p:you", in: portrait.currentFrames())
        #expect(corner.map { $0.width == 105 && $0.height == 140 && $0.maxX == 375 - 12 && $0.maxY == 667 - 64 - 12 } == true)
    }

    @Test func aDropSnapsToTheQuadrantOfThePredictedEnd() {
        let viewport = StagePoliciesTests.iphoneSE
        let frame = StageLayoutPolicy.selfFrame(viewport: viewport, role: .selfFloating, corner: "bottom-right", slotId: "p:you")
        // S20 6 l: a fling toward the top left commits "top-left"; a short drag stays.
        #expect(SelfViewSnapPolicy.dropCorner(frame: frame, leadingTranslationX: -250, translationY: -300, viewport: viewport)
                == "top-left")
        #expect(SelfViewSnapPolicy.dropCorner(frame: frame, leadingTranslationX: -20, translationY: -20, viewport: viewport)
                == "bottom-right")
        #expect(MeetingSelfViewCorner(rawValue: "top-left") == .topLeft)
        // The reserved area's center splits the stage (insets above the bar slot and below the top chrome slot).
        let midY = viewport.insetTop + (viewport.height - viewport.insetTop - viewport.insetBottom) / 2
        #expect(SelfViewSnapPolicy.corner(centerX: 10, centerY: midY - 1, viewport: viewport) == "top-left")
        #expect(SelfViewSnapPolicy.corner(centerX: 10, centerY: midY + 1, viewport: viewport) == "bottom-left")
        // Right to left: a physical drag to the left moves toward the trailing edge, the raw "right" corners.
        let leading = SelfViewSnapPolicy.leadingX(-250, isRightToLeft: true)
        #expect(leading == 250)
        let bottomLeft = StageLayoutPolicy.selfFrame(viewport: viewport, role: .selfFloating, corner: "bottom-left", slotId: "p:you")
        #expect(SelfViewSnapPolicy.dropCorner(frame: bottomLeft, leadingTranslationX: leading, translationY: 0, viewport: viewport)
                == "bottom-right")
        // The Android fling uses the iOS deceleration model, so a fling picks the same corner on both platforms.
        #expect(abs(SelfViewSnapPolicy.projectedDistance(velocity: 1000) - 499) < 0.001)
        // selfViewSnapped plays once, only on a change of corner (S20 6 e, h).
        #expect(SelfViewSnapPolicy.playsSnapFeedback(previousCorner: "bottom-right", nextCorner: "top-left"))
        #expect(!SelfViewSnapPolicy.playsSnapFeedback(previousCorner: "top-left", nextCorner: "top-left"))
        // The FLIP shift mirrors in right to left.
        let topLeft = StageLayoutPolicy.selfFrame(viewport: viewport, role: .selfFloating, corner: "top-left", slotId: "p:you")
        #expect(SelfViewSnapPolicy.physicalShiftX(fromFrame: frame, toFrame: topLeft, isRightToLeft: false) == topLeft.x - frame.x)
        #expect(SelfViewSnapPolicy.physicalShiftX(fromFrame: frame, toFrame: topLeft, isRightToLeft: true) == frame.x - topLeft.x)
        #expect(SelfViewSnapPolicy.shiftY(fromFrame: frame, toFrame: topLeft) == topLeft.y - frame.y)
    }

    @Test func snapCornersStayInsideTheSafeAreaAndTheReservedChromeSlots() {
        // Compact-height landscape with the trailing vertical stack (S20 6 c): every corner clears the stack, the top row
        // and the bar slot by the 12 pt margin, and the quadrant split is the reserved area's center, not the canvas's.
        let landscape = StageViewport(width: 667, height: 375, insetTop: 56, insetBottom: 12, insetLeading: 44, insetTrailing: 64,
                                      widthClass: StageSizeClass.compact, heightClass: StageSizeClass.compact,
                                      placement: .trailingStack)
        for corner in SelfViewSnapPolicy.corners {
            let frame = StageLayoutPolicy.selfFrame(viewport: landscape, role: .selfFloating, corner: corner, slotId: "p:you")
            #expect(frame.x >= landscape.insetLeading + 12 - 0.0001, "\(corner)")
            #expect(frame.maxX <= landscape.width - landscape.insetTrailing - 12 + 0.0001, "\(corner)")
            #expect(frame.y >= landscape.insetTop + 12 - 0.0001, "\(corner)")
            #expect(frame.maxY <= landscape.height - landscape.insetBottom - 12 + 0.0001, "\(corner)")
            // A drop with no travel keeps the corner the slot is in.
            #expect(SelfViewSnapPolicy.dropCorner(frame: frame, leadingTranslationX: 0, translationY: 0, viewport: landscape) == corner)
        }
        let midX = landscape.insetLeading + (landscape.width - landscape.insetLeading - landscape.insetTrailing) / 2
        #expect(SelfViewSnapPolicy.corner(centerX: midX - 1, centerY: 100, viewport: landscape) == "top-left")
        #expect(SelfViewSnapPolicy.corner(centerX: midX + 1, centerY: 100, viewport: landscape) == "top-right")
        // The minimized chip snaps inside the same reserved area.
        let chip = StageLayoutPolicy.selfFrame(viewport: landscape, role: .selfMinimized, corner: "bottom-left", slotId: "p:you")
        #expect(chip.x == landscape.insetLeading + 12 && chip.maxY == landscape.height - landscape.insetBottom - 12)
    }

    @Test func aCommittedCornerMovesTheSelfViewInOneLayoutRevision() {
        let stage = presenter(oneOnOne())
        let revision = stage.layout.revision
        let chrome = stage.chrome
        let capsule = stage.capsule
        stage.apply(oneOnOne(corner: "top-left"))
        #expect(stage.layout.selfCorner == "top-left" && stage.layout.revision == revision + 1)
        #expect(stage.chrome == chrome && stage.capsule == capsule)
        let viewport = StagePoliciesTests.iphoneSE
        let frame = StageLayoutPolicy.find("p:you", in: stage.currentFrames())
        #expect(frame.map { $0.x == viewport.insetLeading + 12 && $0.y == viewport.insetTop + 12 } == true)
        // The minimized chip keeps the corner too.
        let chip = StageLayoutPolicy.selfFrame(viewport: viewport, role: .selfMinimized, corner: "top-right", slotId: "p:you")
        #expect(chip.maxX == viewport.width - 12 && chip.y == viewport.insetTop + 12)
    }

    @Test func moveItemsNamePhysicalCornersAndCommitLeadingBasedOnes() {
        let titles = SelfViewMoveTitles(topLeft: "Move to Top Left", topRight: "Move to Top Right", bottomLeft: "Move to Bottom Left",
                                        bottomRight: "Move to Bottom Right")
        let ltr = SelfViewSnapPolicy.moveSections(role: .selfFloating, isLocal: true, titles: titles, isRightToLeft: false)
        #expect(ltr.count == 1 && ltr.first?.id == SelfViewSnapPolicy.moveSectionId)
        #expect(ltr.first?.items.map(\.id) == ["selfView.move.top-left", "selfView.move.top-right", "selfView.move.bottom-left",
                                                 "selfView.move.bottom-right"])
        #expect(ltr.first?.items.map(\.title) == ["Move to Top Left", "Move to Top Right", "Move to Bottom Left", "Move to Bottom Right"])
        #expect(ltr.first?.items.allSatisfy { $0.isEnabled && $0.concept.isEmpty && $0.role == .normal } == true)
        let rtl = SelfViewSnapPolicy.moveSections(role: .selfFloating, isLocal: true, titles: titles, isRightToLeft: true)
        #expect(rtl.first?.items.map(\.id) == ["selfView.move.top-right", "selfView.move.top-left", "selfView.move.bottom-right",
                                                 "selfView.move.bottom-left"])
        #expect(rtl.first?.items.map(\.title) == ltr.first?.items.map(\.title))
        // The floating view and the minimized chip carry them; nothing else does (S20 6 i).
        #expect(SelfViewSnapPolicy.moveSections(role: .selfMinimized, isLocal: true, titles: titles, isRightToLeft: false).count == 1)
        #expect(SelfViewSnapPolicy.moveSections(role: .grid, isLocal: true, titles: titles, isRightToLeft: false).isEmpty)
        #expect(SelfViewSnapPolicy.moveSections(role: .selfFloating, isLocal: false, titles: titles, isRightToLeft: false).isEmpty)
        for corner in SelfViewSnapPolicy.corners {
            #expect(SelfViewSnapPolicy.corner(forItemId: SelfViewSnapPolicy.moveItemId(corner)) == corner)
            #expect(MeetingSelfViewCorner(rawValue: corner) != nil)
        }
        #expect(SelfViewSnapPolicy.corner(forItemId: TileMenuItemId.pin.rawValue) == "")
        #expect(SelfViewSnapPolicy.corner(forItemId: "selfView.move.middle") == "")
        // The tile menu keeps the Move section after the stage items (the people seam), icon-consistent.
        let context = TileMenuContext(slotId: "p:you", userId: "you", role: .selfFloating, kind: .oneOnOne, fit: .fill, isLocal: true,
                                      isPinned: false, isCameraOff: false, canFlipCamera: true, offersFlipItem: true)
        let sections = TileMenuPolicy.sections(context, titles: STG2TileTests.titles, people: ltr)
        #expect(sections.map(\.id) == [TileMenuPolicy.stageSectionId, SelfViewSnapPolicy.moveSectionId])
        #expect(TileMenuPolicy.accessibilityItems(sections).count == 7)
        for section in sections {
            #expect(ConclaveMenuPolicy.isIconConsistent(section))
        }
        // Needs R4: a Move item commits the corner through the presenter (one command, no flip, no pin).
        let stage = presenter(oneOnOne())
        var commands: [StageCommand] = []
        stage.onCommand = { command in commands.append(command) }
        #expect(TileMenuDispatcher.perform(SelfViewSnapPolicy.moveItemId("top-left"), context: context, stage: stage))
        #expect(commands == [StageCommand(kind: .moveSelfView, userId: "", value: "top-left")])
    }

    // MARK: Camera flip and facing (RECONCILE R13, R22; SC8; S60 C6-2)

    @Test func aUserFlipDispatchesOnlyWhileTheStageOffersIt() {
        let stage = presenter(oneOnOne())
        var commands: [StageCommand] = []
        stage.onCommand = { command in commands.append(command) }
        #expect(stage.chrome.canFlipCamera)
        #expect(StageCameraFlip.perform(stage))
        #expect(commands.map(\.kind) == [.flipCamera])
        // Camera off: the stage offers no flip; nothing dispatches and the control plays nothing.
        let off = presenter(oneOnOne(cameraOn: false))
        off.onCommand = { command in commands.append(command) }
        #expect(!off.chrome.canFlipCamera && !StageCameraFlip.perform(off))
        // Needs R2 and R3 a: a flip in flight keeps the control (disabled) and dispatches nothing.
        let inFlight = presenter(oneOnOne(flipInFlight: true))
        inFlight.onCommand = { command in commands.append(command) }
        #expect(inFlight.chrome.canFlipCamera && inFlight.chrome.isFlipInFlight)
        #expect(!StageCameraFlip.perform(inFlight))
        #expect(commands.count == 1)
        // Needs R4: the tile menu's Flip Camera goes through the same gate.
        let context = TileMenuContext(slotId: "p:you", userId: "you", role: .selfFloating, kind: .oneOnOne, fit: .fill, isLocal: true,
                                      isPinned: false, isCameraOff: false, canFlipCamera: true, offersFlipItem: true)
        #expect(!TileMenuDispatcher.perform(TileMenuItemId.flipCamera.rawValue, context: context, stage: inFlight))
        #expect(commands.count == 1)
    }

    @Test func aFlipChangesTheMirrorAndTheFlipValueWithoutUnrelatedChurn() {
        let front = StageFixtureScript.inputs(for: .oneOnOne)
        let stage = presenter(front)
        let layout = stage.layout
        let capsule = stage.capsule
        let chromeRevision = stage.chrome.revision
        stage.apply(StageFixtureScript.copy(front, isFrontCamera: false))
        #expect(!stage.chrome.isFrontCamera && stage.chrome.revision == chromeRevision + 1)
        #expect(stage.layout == layout && stage.capsule == capsule)
        #expect(LocalCameraFacing.from(isFront: stage.chrome.isFrontCamera) == .back)
        #expect(LocalCameraFacing.front.shouldMirrorLocalVideo && !LocalCameraFacing.back.shouldMirrorLocalVideo)
        #expect(LocalCameraFacing.front.isFront && LocalCameraFacing.front.next == .back)
        #expect(LocalCameraPublication.publishes(current: .front, reported: .back))
        #expect(!LocalCameraPublication.publishes(current: .back, reported: .back))
    }

    @Test func thePausedCameraReachesYourTileOnlyWithTheCameraOn() {
        // Needs R2 and R3 a.
        #expect(presenter(oneOnOne(paused: true)).chrome.isCameraPaused)
        #expect(!presenter(oneOnOne(cameraOn: false, paused: true)).chrome.isCameraPaused)
        #expect(LocalCameraPublication.showsPaused(interruption: .background, isCameraOff: false))
        #expect(!LocalCameraPublication.showsPaused(interruption: .background, isCameraOff: true))
        #expect(!LocalCameraPublication.isPaused(.none) && LocalCameraPublication.isPaused(.inUseByAnotherClient))
    }

    @Test func theOneCameraOwnerPublishesTheFacingAndTheCallCameraPause() {
        // The macOS controller (no capture device) runs the same members as the iOS and Android ones.
        let camera = LocalPreviewController()
        var changes = 0
        var publishes = 0
        camera.onCallCameraChange = { changes += 1 }
        camera.onChange = { publishes += 1 }
        #expect(camera.facing == .front)
        #expect(camera.adoptCallFacing(.back))
        #expect(camera.facing == .back && changes == 1 && publishes == 1)
        // An equal report publishes nothing.
        #expect(!camera.adoptCallFacing(.back))
        #expect(changes == 1 && publishes == 1)
        camera.noteCallCameraInterruption(.background)
        #expect(camera.isCallCameraPaused && camera.callCameraInterruption == .background && changes == 2)
        camera.noteCallCameraInterruption(.background)
        #expect(changes == 2)
        camera.noteCallCameraResumed()
        #expect(!camera.isCallCameraPaused && changes == 3)
        camera.resetCallCamera()
        #expect(changes == 3)
        // While the call owns the camera (the latch), a facing report starts no capture.
        camera.start(facing: .back)
        camera.handOffToCall()
        #expect(camera.isPublishLatched)
        let starts = camera.startCount
        #expect(camera.adoptCallFacing(.front))
        #expect(camera.startCount == starts && camera.isPublishLatched && changes == 4)
        // A lobby flip changes the one facing too.
        camera.flip()
        #expect(camera.facing == .back && changes == 5)
    }

    // MARK: Source scans (the macOS host does not compile the iOS views or the Kotlin)

    @Test func iosSlotViewDragsSnapsAndKeepsItsConstantStructure() throws {
        let slot = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/SlotView+iOS.swift"))
        for pin in ["ShareZoomContainer(zoom: zoom, isZoomable: zoomable, slotId: slot.id, stage: stage) {",
                    ".opacity(slot.role == .selfMinimized ? 0 : 1)",
                    ".overlay { SharePlaceholder(model: model, binding: binding, isShare: isShare) }",
                    ".modifier(SelfViewDragModifier(slot: slot, stage: stage))",
                    ".gesture(drag, including: movable ? .all : .subviews)",
                    "DragGesture(minimumDistance: CGFloat(SelfViewSnapPolicy.dragMinimumDistance), coordinateSpace: .global)",
                    "value.predictedEndTranslation", "stage.moveSelfView(toCorner: target)",
                    ".conclaveGestureFeedback(.selfViewSnapped, trigger: snaps)", "withAnimation(ConclaveMotion.snap)",
                    "ConclaveMotion.travel(ConclaveMotion.snap, reduceMotion: reduceMotion)",
                    "if StageCameraFlip.perform(stage) {", ".disabled(chrome.isFlipInFlight)", ".accessibilityHidden(isShare)",
                    "TileMenuModel.make(slot: slot, model: model, stage: stage, people: extraSections)",
                    // Batch 5 integrator: make() reads the People presenter first; the tile passes only the Move section.
                    "let extraSections = SelfViewMoveText.sections(slot: slot, model: model, layoutDirection: layoutDirection)",
                    ".modifier(ShareStripFade(stage: stage, role: slot.role))", "ConclaveStrings.text(\"Camera paused\")",
                    "ConclaveStrings.text(\"Move to Top Left\")"] {
            #expect(slot.contains(pin), "SlotView+iOS.swift lacks \(pin)")
        }
        // The drag is not high priority (the flip control and taps still work, INM A10); one tile chrome per slot.
        #expect(!slot.contains("highPriorityGesture"))
        #expect(slot.components(separatedBy: "ConclaveTileChrome(").count - 1 == 1)
        // The floating flip control is its own element now, not the chrome's accessory.
        #expect(slot.contains("FloatingSelfFlipControl(slot: slot, entry: entry, stage: stage)"))
        #expect(!slot.contains("selfViewAccessory: { SelfViewFlipButton"))
    }

    @Test func iosShareZoomRunsTransformsWhileFingersMoveAndResizesOnSettle() throws {
        let zoom = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/ShareZoom+iOS.swift"))
        for pin in ["MagnifyGesture(minimumScaleDelta: 0.01)", "SpatialTapGesture(count: 2)", ".exclusively(before: TapGesture(count: 1)",
                    ".accessibilityZoomAction", "withAnimation(ConclaveMotion.zoomSnap, completionCriteria: .removed)",
                    ".scaleEffect(CGFloat(live.scale) / layoutScale)", ".offset(x: CGFloat(live.panX), y: CGFloat(live.panY))",
                    ".frame(width: proxy.size.width * layoutScale, height: proxy.size.height * layoutScale)", ".clipped()",
                    "ShareZoomPolicy.layoutScale(", "ConclaveSymbols.rectangleInsetFilledOnRectangle",
                    "HostingTheme.token(DesignTokens.iosInCallSurface)", "ConclaveStrings.format(\"Shared Screen from %@\"",
                    "ConclaveStrings.text(\"Reset Zoom\")", "ConclaveStrings.format(\"Zoom %@x\"",
                    ".environment(\\.layoutDirection, .leftToRight)", "chrome?.send(ChromeVisibilityEvent.tap)",
                    "if zoom.slotSizeChanged(size) { renderTargetResize?() }"] {
            #expect(zoom.contains(pin), "ShareZoom+iOS.swift lacks \(pin)")
        }
        // Zoom and pan are view-local, never published (S20 5 j); no glass, no core reads.
        for forbidden in ["onCommand", "moveSelfView", "MeetingViewModel", "setViewport", "glassEffect", "Material"] {
            #expect(!zoom.contains(forbidden), "ShareZoom+iOS.swift uses \(forbidden)")
        }
    }

    @Test func androidSelfViewDragsInTheDrawPhaseAndTheShareZoomsOnALayer() throws {
        let slot = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/SlotView.kt"))
        for pin in ["detectDragGestures(", "drag.velocity.addPosition(change.uptimeMillis, change.position)",
                    "val offset = drag.offset.value", "translationX = offset.x", "stage.moveSelfView(toCorner = target)",
                    "haptics.gesture(FeedbackKind.selfViewSnapped)", "Modifier.systemGestureExclusion()",
                    "drag.offset.animateTo(Offset.Zero, ConclaveMotion.spatialDefault())",
                    "ShareZoomBox(zoom, zoomable, slot.id, stage, Modifier.fillMaxSize().graphicsLayer { alpha = if (minimized) 0f else 1f })",
                    "SharePlaceholder(model, binding, isShare, Modifier.fillMaxSize())", "customActions = actions.map",
                    "stateDescription = value", "conclaveString(\"stg_move_top_left\")", "conclaveString(\"stg_camera_paused\")",
                    "SelfViewSnapPolicy.moveSections(", "LocalStageChromeVisibility", "LocalStageViewport"] {
            #expect(slot.contains(pin), "SlotView.kt lacks \(pin)")
        }
        // STG-2 pins stay: one long-press haptic, the press-point detector.
        #expect(slot.components(separatedBy: "haptics.gesture(FeedbackKind.longPress)").count - 1 == 1)
        #expect(slot.contains("modifier = Modifier.fillMaxSize().tileLongPress(menu.hasItems) { at ->"))
        let zoom = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/ShareZoom.kt"))
        for pin in ["event.calculateZoom()", "event.calculatePan()", "detectTapGestures(", "onDoubleTap = { at ->", ".clipToBounds()",
                    "Constraints.fixed(laidWidth, laidHeight)", "placeable.place((width - laidWidth) / 2, (height - laidHeight) / 2)",
                    "scaleX = scale", "translationX = live.panX.toFloat()", "ShareZoomPolicy.layoutScale(",
                    "progress.animateTo(1f, ConclaveMotion.zoomSnap())", "ConclaveIcons.PresentToAllFill1",
                    "conclaveString(\"stg_reset_zoom\")", "conclaveString(\"stg_zoom_in\")", "conclaveString(\"stg_zoom_out\")",
                    "conclaveString(\"stg_shared_screen_from\", model.displayName)", "chrome?.send(ChromeVisibilityEvent.tap)"] {
            #expect(zoom.contains(pin), "ShareZoom.kt lacks \(pin)")
        }
        for forbidden in ["MeetingViewModel", "onCommand", "moveSelfView", "detectTransformGestures(", "Text(\""] {
            #expect(!zoom.contains(forbidden), "ShareZoom.kt uses \(forbidden)")
        }
    }

    @Test func bothCameraOwnersExposeTheSameCallCameraMembers() throws {
        let swift = try stageSource("Sources/Conclave/Core/WebRTC/LocalPreviewController.swift")
        let kotlin = try stageSource("Sources/Conclave/Skip/LocalPreviewController.kt")
        for member in ["var onCallCameraChange: (() -> Void)?", "func adoptCallFacing(_ reported: LocalCameraFacing) -> Bool",
                       "func noteCallCameraInterruption(_ reason: PreviewInterruption)", "func noteCallCameraResumed()",
                       "func resetCallCamera()", "private(set) var callCameraInterruption: PreviewInterruption",
                       "var isCallCameraPaused: Bool", "AVCaptureSession.wasInterruptedNotification,"] {
            #expect(swift.contains(member), "Swift controller lacks \(member)")
        }
        for member in ["var onCallCameraChange: (() -> Unit)?", "fun adoptCallFacing(reported: LocalCameraFacing): Boolean",
                       "fun noteCallCameraInterruption(reason: PreviewInterruption)", "fun noteCallCameraResumed()",
                       "fun resetCallCamera()", "var callCameraInterruption: PreviewInterruption", "val isCallCameraPaused: Boolean"] {
            #expect(kotlin.contains(member), "Kotlin controller lacks \(member)")
        }
        // The publish latch holds: no producer, track or capturer path on either side (ENT-3's scan, repeated here).
        for text in [swift, kotlin] {
            for pattern in ["createProducer", "RTCCameraVideoCapturer", "CameraVideoCapturer", "VideoTrack", "webRTCClient"] {
                #expect(!text.contains(pattern))
            }
        }
    }

    @Test func stg3SourcesStayDashFreeFlatAndLocalized() throws {
        let files = ["Sources/Conclave/Features/Meeting/Stage/ShareZoom+iOS.swift", "Sources/Conclave/Features/Meeting/Stage/SlotView+iOS.swift",
                     "Sources/Conclave/Skip/ui/call/stage/ShareZoom.kt", "Sources/Conclave/Skip/ui/call/stage/SlotView.kt",
                     "Sources/Conclave/Core/WebRTC/LocalCameraFacing.swift", "Sources/Conclave/Core/WebRTC/LocalPreviewController.swift",
                     "Sources/Conclave/Skip/LocalPreviewController.kt"]
        for file in files {
            let text = try stageSource(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file) mentions a gradient")
            #expect(!text.contains("HapticManager") && !text.contains("@Stable"), "\(file)")
            #expect(stageMatches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x)"#, in: text).isEmpty, "\(file) builds a color from a literal")
        }
        // Needs R17 (and B5-T2's fragment for "Shared Screen from %@"): every catalog key and resource name resolves.
        let catalog = try stageSource("Sources/Conclave/Resources/Localizable.xcstrings")
        let keys = try #require(try JSONSerialization.jsonObject(with: Data(catalog.utf8)) as? [String: Any])["strings"] as? [String: Any]
        for file in ["Sources/Conclave/Features/Meeting/Stage/ShareZoom+iOS.swift", "Sources/Conclave/Features/Meeting/Stage/SlotView+iOS.swift"] {
            for match in stageMatches(#"ConclaveStrings\.(text|format)\("[^"]+""#, in: try stageSource(file)) {
                let key = String(match.drop { $0 != "\"" }.dropFirst().dropLast())
                #expect(keys?[key] != nil, "\(file): missing catalog key \(key)")
            }
        }
        let resources = try stageSource("Android/app/src/main/res/values/strings.xml")
        for file in ["Sources/Conclave/Skip/ui/call/stage/ShareZoom.kt", "Sources/Conclave/Skip/ui/call/stage/SlotView.kt"] {
            for match in stageMatches(#""(ppl|stg|ds)_[a-z0-9_]+""#, in: try stageSource(file)) {
                let name = String(match.dropFirst().dropLast())
                #expect(resources.contains("name=\"" + name + "\""), "\(file): missing resource \(name)")
            }
        }
    }
}

#if os(macOS)
/// S20 SC8, S60 C6-2, S20 6 f through the view model (macOS host; no network, no camera). Needs HD/requests/B5-T8.md R6
/// and R7. The shared camera owner is restored at the end.
@MainActor
@Suite(.serialized)
struct STG3CameraFacingViewModelTests {
    @Test func theCameraOwnersFacingAndPauseReachTheStageInputs() {
        let viewModel = MeetingViewModel()
        let camera = LocalPreviewController.shared
        let original = camera.facing
        defer {
            camera.adoptCallFacing(original)
            camera.resetCallCamera()
        }
        let flipped = original.next
        camera.adoptCallFacing(flipped)
        #expect(viewModel.state.localCameraFacing == flipped)
        #expect(viewModel.makeStageInputs().isFrontCamera == flipped.isFront)
        camera.noteCallCameraInterruption(.inUseByAnotherClient)
        #expect(viewModel.state.isLocalCameraPaused && viewModel.makeStageInputs().isCameraPaused)
        camera.resetCallCamera()
        #expect(!viewModel.state.isLocalCameraPaused)
        // A replaced state is rebound and resynced from the owner (tests replace it wholesale).
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        #expect(viewModel.state.localCameraFacing == flipped)
    }
}
#endif
#endif
