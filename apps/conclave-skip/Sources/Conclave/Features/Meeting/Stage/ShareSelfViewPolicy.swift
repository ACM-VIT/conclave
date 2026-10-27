import Foundation

// STG-3 (OUT/PLAN-screens.md section 5; S20 5, 6, 0.6 SL6, SL7, 0.7 SC8; RECONCILE R13): the pure rules behind share
// viewing (zoom and pan, the settle-time render-target size, the landscape strip) and the self view (its size, the
// velocity-aware corner snap, the Move actions) plus the user camera flip. Shared (transpiled) Swift under the S1C 3.6
// rules: String raw-value enums, scalar structs and arrays of structs, no associated values, no tuples, no protocols,
// no platform branches. Units are the caller's: points on iOS; dp for the self view and pixels for the share zoom on
// Android. Every rule is a ratio or a comparison inside one unit. Views resolve every string; nothing here localizes.
//
// Zoom and pan are view-local and never published (S20 5 j); the self view drag publishes nothing until the drop
// commits one corner through `StagePresenter.moveSelfView(toCorner:)` (S20 6 k).

// MARK: Share zoom (S20 5 c, d, f, h, i, k; SL7)

/// One zoom state of the share slot: `scale` 1 to 4 (0.85 to 4.5 while the fingers overshoot) and the pan of the
/// content's center from the slot's center, in slot units, positive toward the physical right and down.
struct ShareZoomValue: Equatable {
    let scale: Double
    let panX: Double
    let panY: Double

    static let identity = ShareZoomValue(scale: 1.0, panX: 0.0, panY: 0.0)

    /// Zoomed past 1x: pan is enabled, the Reset Zoom chip shows and the element value reads the zoom (S20 5 f, i).
    var isZoomed: Bool { scale > ShareZoomPolicy.zoomedThreshold }
}

enum ShareZoomPolicy {
    static let minimumScale = 1.0
    static let maximumScale = 4.0
    /// How far a pinch may overshoot either end while the fingers move; the release springs back (`zoomSnap`, S20 5 h).
    static let overshootMinimum = 0.85
    static let overshootMaximum = 4.5
    static let doubleTapScale = 2.0
    /// A settle within 2% of 1x returns to exactly 1x with no pan.
    static let zoomedThreshold = 1.02
    /// The iOS zoom action and the Android Zoom in and Zoom out actions step through these (S20 5 c, d, i).
    static let accessibilitySteps: [Double] = [1.0, 2.0, 4.0]

    /// Zoom and pan apply to the main share slot of a remote presenter only. A share in the rail (a pin is set, S20 4 a)
    /// keeps identity transforms until it is main again, and your own share shows a placeholder, never your screen.
    static func isZoomable(slotId: String, role: StageSlotRole, isLocal: Bool) -> Bool {
        slotId.hasPrefix("share:") && role == StageSlotRole.share && !isLocal
    }

    /// The landscape share strip hides with chrome (S20 5 c, 8 a); renderers stay mounted. The same rule
    /// `StageVisibilityPolicy.report` uses to report the strip invisible, so the views and the consumer policy agree.
    static func railHidesWithChrome(kind: StageKind, role: StageSlotRole, isCompactHeight: Bool) -> Bool {
        kind == StageKind.presentation && role == StageSlotRole.rail && isCompactHeight
    }

    static func clampScale(_ scale: Double) -> Double {
        min(maximumScale, max(minimumScale, scale))
    }

    static func overshootScale(_ scale: Double) -> Double {
        min(overshootMaximum, max(overshootMinimum, scale))
    }

    /// The share content's width at 1x: the decoded frame fitted into the slot (letterboxed, S20 5 e), or the slot itself
    /// while the frame size is not known yet (the fixture's static pattern, the first frames of a share).
    static func contentWidth(slotWidth: Double, slotHeight: Double, videoWidth: Double, videoHeight: Double) -> Double {
        if videoWidth <= 0 || videoHeight <= 0 || slotWidth <= 0 || slotHeight <= 0 { return max(0.0, slotWidth) }
        return min(slotWidth, slotHeight * videoWidth / videoHeight)
    }

    static func contentHeight(slotWidth: Double, slotHeight: Double, videoWidth: Double, videoHeight: Double) -> Double {
        if videoWidth <= 0 || videoHeight <= 0 || slotWidth <= 0 || slotHeight <= 0 { return max(0.0, slotHeight) }
        return min(slotHeight, slotWidth * videoHeight / videoWidth)
    }

    /// Content edges never leave the slot (S20 5 c): a zoomed side larger than the slot pans until its edge meets the
    /// slot edge; a side still smaller than the slot stays centered.
    static func maximumPanX(scale: Double, slotWidth: Double, slotHeight: Double, videoWidth: Double, videoHeight: Double) -> Double {
        let content = contentWidth(slotWidth: slotWidth, slotHeight: slotHeight, videoWidth: videoWidth, videoHeight: videoHeight)
        return max(0.0, (content * scale - slotWidth) / 2.0)
    }

    static func maximumPanY(scale: Double, slotWidth: Double, slotHeight: Double, videoWidth: Double, videoHeight: Double) -> Double {
        let content = contentHeight(slotWidth: slotWidth, slotHeight: slotHeight, videoWidth: videoWidth, videoHeight: videoHeight)
        return max(0.0, (content * scale - slotHeight) / 2.0)
    }

    static func clampedPan(_ value: ShareZoomValue, slotWidth: Double, slotHeight: Double, videoWidth: Double,
                           videoHeight: Double) -> ShareZoomValue {
        let limitX = maximumPanX(scale: value.scale, slotWidth: slotWidth, slotHeight: slotHeight, videoWidth: videoWidth,
                                 videoHeight: videoHeight)
        let limitY = maximumPanY(scale: value.scale, slotWidth: slotWidth, slotHeight: slotHeight, videoWidth: videoWidth,
                                 videoHeight: videoHeight)
        return ShareZoomValue(scale: value.scale, panX: min(limitX, max(-limitX, value.panX)),
                              panY: min(limitY, max(-limitY, value.panY)))
    }

    /// Zooms to `scale` around a point of the slot (origin at the slot's physical top left), keeping the content under
    /// that point where it is.
    static func zoomed(_ value: ShareZoomValue, toScale scale: Double, anchorX: Double, anchorY: Double, slotWidth: Double,
                       slotHeight: Double) -> ShareZoomValue {
        if value.scale <= 0 { return ShareZoomValue(scale: scale, panX: 0.0, panY: 0.0) }
        let localX = anchorX - slotWidth / 2.0
        let localY = anchorY - slotHeight / 2.0
        let ratio = scale / value.scale
        return ShareZoomValue(scale: scale, panX: localX - (localX - value.panX) * ratio, panY: localY - (localY - value.panY) * ratio)
    }

    /// One frame of a pinch and pan (S20 5 h: the content tracks the fingers): from the gesture's starting value, the
    /// magnification around where the pinch started plus the translation. Scale may overshoot; pan stays inside the
    /// content edges at that scale.
    static func live(start: ShareZoomValue, magnification: Double, anchorX: Double, anchorY: Double, translationX: Double,
                     translationY: Double, slotWidth: Double, slotHeight: Double, videoWidth: Double,
                     videoHeight: Double) -> ShareZoomValue {
        let scale = overshootScale(start.scale * magnification)
        let around = zoomed(start, toScale: scale, anchorX: anchorX, anchorY: anchorY, slotWidth: slotWidth, slotHeight: slotHeight)
        let moved = ShareZoomValue(scale: scale, panX: around.panX + translationX, panY: around.panY + translationY)
        return clampedPan(moved, slotWidth: slotWidth, slotHeight: slotHeight, videoWidth: videoWidth, videoHeight: videoHeight)
    }

    /// Where a gesture settles (S20 5 h): the scale back inside 1x to 4x around the slot center (the spring back of an
    /// overshoot), exactly 1x near 1x, the pan inside the content edges. A release inside bounds stays put.
    static func settled(_ value: ShareZoomValue, slotWidth: Double, slotHeight: Double, videoWidth: Double,
                        videoHeight: Double) -> ShareZoomValue {
        let scale = clampScale(value.scale)
        if scale < zoomedThreshold { return ShareZoomValue.identity }
        let centered = zoomed(value, toScale: scale, anchorX: slotWidth / 2.0, anchorY: slotHeight / 2.0, slotWidth: slotWidth,
                              slotHeight: slotHeight)
        return clampedPan(centered, slotWidth: slotWidth, slotHeight: slotHeight, videoWidth: videoWidth, videoHeight: videoHeight)
    }

    /// Double tap (S20 5 c, d): 1x to 2x at the tap point; any zoom back to 1x.
    static func doubleTapped(_ value: ShareZoomValue, atX: Double, atY: Double, slotWidth: Double, slotHeight: Double,
                             videoWidth: Double, videoHeight: Double) -> ShareZoomValue {
        if value.isZoomed { return ShareZoomValue.identity }
        let zoomedIn = zoomed(value, toScale: doubleTapScale, anchorX: atX, anchorY: atY, slotWidth: slotWidth, slotHeight: slotHeight)
        return clampedPan(zoomedIn, slotWidth: slotWidth, slotHeight: slotHeight, videoWidth: videoWidth, videoHeight: videoHeight)
    }

    /// The next accessibility step in or out (1x, 2x, 4x).
    static func steppedScale(fromScale scale: Double, zoomIn: Bool) -> Double {
        if zoomIn {
            for step in accessibilitySteps {
                if step > scale + 0.01 { return step }
            }
            return maximumScale
        }
        var result = minimumScale
        for step in accessibilitySteps {
            if step < scale - 0.01 { result = step }
        }
        return result
    }

    /// An accessibility zoom step around the slot center.
    static func stepped(_ value: ShareZoomValue, zoomIn: Bool, slotWidth: Double, slotHeight: Double, videoWidth: Double,
                        videoHeight: Double) -> ShareZoomValue {
        let next = steppedScale(fromScale: value.scale, zoomIn: zoomIn)
        if next < zoomedThreshold { return ShareZoomValue.identity }
        let centered = zoomed(value, toScale: next, anchorX: slotWidth / 2.0, anchorY: slotHeight / 2.0, slotWidth: slotWidth,
                              slotHeight: slotHeight)
        return clampedPan(centered, slotWidth: slotWidth, slotHeight: slotHeight, videoWidth: videoWidth, videoHeight: videoHeight)
    }

    /// The scale the renderer is laid out at once per settled zoom (S20 5 c, d, k), so its drawable or texture carries real
    /// pixels instead of a magnified buffer. It never passes the decoded frame: past the frame's own pixels a larger
    /// drawable adds no detail, so the remainder stays a layer transform. `pixelsPerUnit` is the display scale on iOS
    /// and 1 on Android (the slot is measured in pixels there).
    static func layoutScale(scale: Double, slotWidth: Double, slotHeight: Double, pixelsPerUnit: Double, videoWidth: Double,
                            videoHeight: Double) -> Double {
        let target = clampScale(scale)
        if videoWidth <= 0 || videoHeight <= 0 || pixelsPerUnit <= 0 { return target }
        let width = contentWidth(slotWidth: slotWidth, slotHeight: slotHeight, videoWidth: videoWidth, videoHeight: videoHeight)
            * pixelsPerUnit
        let height = contentHeight(slotWidth: slotWidth, slotHeight: slotHeight, videoWidth: videoWidth, videoHeight: videoHeight)
            * pixelsPerUnit
        if width <= 0 || height <= 0 { return target }
        let cap = max(minimumScale, min(videoWidth / width, videoHeight / height))
        return min(target, cap)
    }

    /// Between two values; Android drives a settle with one 0 to 1 spring (iOS animates the value itself).
    static func interpolated(start: ShareZoomValue, end: ShareZoomValue, fraction: Double) -> ShareZoomValue {
        ShareZoomValue(scale: start.scale + (end.scale - start.scale) * fraction,
                       panX: start.panX + (end.panX - start.panX) * fraction,
                       panY: start.panY + (end.panY - start.panY) * fraction)
    }

    /// The zoom a reader hears ("Zoom 2x", "Zoom 2.5x"): one decimal.
    static func spokenScale(_ scale: Double) -> Double {
        (scale * 10.0).rounded() / 10.0
    }

    /// A whole spoken zoom drops the decimal ("2x", not "2.0x").
    static func isWholeScale(_ scale: Double) -> Bool {
        let spoken = spokenScale(scale)
        return spoken == spoken.rounded()
    }
}

// MARK: The local presenter and presentation announcements (S20 5 a, e, g, i; 0.5 token table)

enum ShareAnnouncementPolicy {
    /// `StageAnnouncement.kind` for "%@ started presenting" (S20 5 g; polite, web STG-23).
    static let presentingKind = "presenting"

    /// The remote presenter's name when a remote share starts or the presenter changes; "" otherwise. Never on the first
    /// snapshot of a call (the entry announcement keeps the one-shot channel) and never for your own share, which the
    /// banner already says (S20 5 b, 10).
    static func startedPresenterName(previous: StageInputs, next: StageInputs) -> String {
        if previous.participants.isEmpty || previous.callSession != next.callSession { return "" }
        let presenter = next.screenShareUserId
        if presenter.isEmpty || presenter == previous.screenShareUserId { return "" }
        if next.isLocalScreenSharing || presenter == next.localUserId { return "" }
        return next.participant(presenter)?.displayName ?? ""
    }

    /// The presenter-side outcome token of a local share transition (S20 5 e; the stage is its only publisher, R12):
    /// `shareStarted` when your share starts, `shareStopped` when it ends, nil otherwise and on the first snapshot of a
    /// call. `shareStoppedBySystem` needs the system-stop signal of the share flow (WP3) and is not derived here.
    static func localShareFeedback(previous: StageInputs, next: StageInputs) -> FeedbackKind? {
        if previous.participants.isEmpty || previous.callSession != next.callSession { return nil }
        if next.isLocalScreenSharing && !previous.isLocalScreenSharing { return FeedbackKind.shareStarted }
        if !next.isLocalScreenSharing && previous.isLocalScreenSharing { return FeedbackKind.shareStopped }
        return nil
    }
}

// MARK: Self view (S20 6 c, d, e, h, i, l; SL6)

/// The four Move action titles, resolved per platform (S20 6 g); they name physical corners.
struct SelfViewMoveTitles: Equatable {
    let topLeft: String
    let topRight: String
    let bottomLeft: String
    let bottomRight: String
}

enum SelfViewSnapPolicy {
    /// S20 6 c: width = clamp(0.28 x short edge, 96, 132) on phones, 160 on regular width; height = width x 4 / 3.
    static let phoneWidthRatio = 0.28
    static let phoneMinimumWidth = 96.0
    static let phoneMaximumWidth = 132.0
    static let regularWidth = 160.0
    /// The drag starts after 10 points or dp, so the flip control and a tap still work (S20 6 c; INM A10).
    static let dragMinimumDistance = 10.0
    /// The Android fling projection uses the iOS normal scroll deceleration rate (0.998 per millisecond), the same model as
    /// the iOS `predictedEndTranslation`, so a fling picks the same corner on both platforms.
    static let decelerationRate = 0.998
    /// `MeetingSelfViewCorner` raw values. Raw corners are leading based: `StageLayoutPolicy.selfFrame` and both
    /// canvases measure from the leading edge and mirror in right-to-left layouts.
    static let topLeft = "top-left"
    static let topRight = "top-right"
    static let bottomLeft = "bottom-left"
    static let bottomRight = "bottom-right"
    static let corners: [String] = [topLeft, topRight, bottomLeft, bottomRight]
    static let moveItemPrefix = "selfView.move."
    static let moveSectionId = "tile.selfView.move"

    /// The floating self view's width for this viewport (portrait 3:4 in every orientation, S20 6 c).
    static func floatingWidth(_ viewport: StageViewport) -> Double {
        if StageLayoutPolicy.usesRegularSpacing(viewport) { return regularWidth }
        let shortEdge = min(viewport.width, viewport.height)
        return min(phoneMaximumWidth, max(phoneMinimumWidth, shortEdge * phoneWidthRatio))
    }

    static func floatingHeight(_ viewport: StageViewport) -> Double {
        floatingWidth(viewport) * 4.0 / 3.0
    }

    /// The fling distance (caller's unit) for a release velocity in units per second.
    static func projectedDistance(velocity: Double) -> Double {
        velocity / 1000.0 * decelerationRate / (1.0 - decelerationRate)
    }

    /// The corner whose quadrant of the reserved stage area holds a point measured from the leading edge (S20 6 c).
    static func corner(centerX: Double, centerY: Double, viewport: StageViewport) -> String {
        let midX = viewport.insetLeading + (viewport.width - viewport.insetLeading - viewport.insetTrailing) / 2.0
        let midY = viewport.insetTop + (viewport.height - viewport.insetTop - viewport.insetBottom) / 2.0
        let top = centerY < midY
        let leading = centerX < midX
        if top { return leading ? topLeft : topRight }
        return leading ? bottomLeft : bottomRight
    }

    /// The drop: the slot's laid-out frame (leading based) moved by the predicted translation (the iOS
    /// `predictedEndTranslation`, or the Android drag plus its fling projection), converted to the leading axis.
    static func dropCorner(frame: StageFrame, leadingTranslationX: Double, translationY: Double, viewport: StageViewport) -> String {
        corner(centerX: frame.x + frame.width / 2.0 + leadingTranslationX, centerY: frame.y + frame.height / 2.0 + translationY,
               viewport: viewport)
    }

    /// Physical horizontal movement (the iOS global translation, Android pointer deltas) on the leading axis.
    static func leadingX(_ physicalX: Double, isRightToLeft: Bool) -> Double {
        isRightToLeft ? -physicalX : physicalX
    }

    /// How far the slot moves physically when its corner changes. The drop lays the slot out once at its new corner and
    /// starts the visual offset at minus this shift, so the tile stays under the finger and springs to the corner (FLIP;
    /// the renderer is never re-laid out per frame, S20 6 k).
    static func physicalShiftX(fromFrame: StageFrame, toFrame: StageFrame, isRightToLeft: Bool) -> Double {
        leadingX(toFrame.x - fromFrame.x, isRightToLeft: isRightToLeft)
    }

    static func shiftY(fromFrame: StageFrame, toFrame: StageFrame) -> Double {
        toFrame.y - fromFrame.y
    }

    /// `selfViewSnapped` plays once, on a commit to a different corner only (S20 6 e, h).
    static func playsSnapFeedback(previousCorner: String, nextCorner: String) -> Bool {
        previousCorner != nextCorner
    }

    // MARK: Move actions (S20 6 c, d, i, l)

    /// Your floating view and your minimized chip both carry the four Move actions.
    static func offersMove(role: StageSlotRole, isLocal: Bool) -> Bool {
        isLocal && role.isSelfMovable
    }

    static func moveItemId(_ corner: String) -> String {
        moveItemPrefix + corner
    }

    /// The raw corner of a Move item id, or "" for any other id (the tile menu dispatcher routes Move items with it).
    static func corner(forItemId itemId: String) -> String {
        if !itemId.hasPrefix(moveItemPrefix) { return "" }
        let raw = String(itemId.dropFirst(moveItemPrefix.count))
        return corners.contains(raw) ? raw : ""
    }

    /// Titles name physical corners; raw corners are leading based, so right-to-left swaps left and right.
    static func rawCorner(physical: String, isRightToLeft: Bool) -> String {
        if !isRightToLeft { return physical }
        if physical == topLeft { return topRight }
        if physical == topRight { return topLeft }
        if physical == bottomLeft { return bottomRight }
        if physical == bottomRight { return bottomLeft }
        return physical
    }

    /// The Move section, passed to the tile menu after its stage section (the same extra-sections seam the PPL-2 people
    /// items use), in reading order Top Left, Top Right, Bottom Left, Bottom Right. Icon-free like the stage section.
    static func moveSections(role: StageSlotRole, isLocal: Bool, titles: SelfViewMoveTitles, isRightToLeft: Bool) -> [MenuSectionModel] {
        if !offersMove(role: role, isLocal: isLocal) { return [] }
        var items: [MenuItemModel] = []
        items.append(moveItem(physical: topLeft, title: titles.topLeft, isRightToLeft: isRightToLeft))
        items.append(moveItem(physical: topRight, title: titles.topRight, isRightToLeft: isRightToLeft))
        items.append(moveItem(physical: bottomLeft, title: titles.bottomLeft, isRightToLeft: isRightToLeft))
        items.append(moveItem(physical: bottomRight, title: titles.bottomRight, isRightToLeft: isRightToLeft))
        return [MenuSectionModel(id: moveSectionId, items: items)]
    }

    static func moveItem(physical: String, title: String, isRightToLeft: Bool) -> MenuItemModel {
        MenuItemModel(id: moveItemId(rawCorner(physical: physical, isRightToLeft: isRightToLeft)), title: title, concept: "",
                      role: MenuItemRole.normal, isOn: false, isEnabled: true, disabledReason: "")
    }
}

// MARK: User camera flip (RECONCILE R13; S20 6 e, f, h, SC8)

enum StageCameraFlip {
    /// Dispatches a user flip only while the stage offers it (your camera is on, a second camera exists and no flip is
    /// in flight, SC8). True tells the touched control to play `selectionChanged` once (R13); a flip the stage does not
    /// offer dispatches nothing and plays nothing.
    @MainActor
    static func perform(_ stage: StagePresenter) -> Bool {
        let chrome = stage.chrome
        if !chrome.canFlipCamera || chrome.isFlipInFlight { return false }
        stage.flipCamera()
        return true
    }
}
