import Foundation

struct ShareZoomValue: Equatable {
    let scale: Double
    let panX: Double
    let panY: Double

    static let identity = ShareZoomValue(scale: 1.0, panX: 0.0, panY: 0.0)

    var isZoomed: Bool { scale > ShareZoomPolicy.zoomedThreshold }
}

enum ShareZoomPolicy {
    static let minimumScale = 1.0
    static let maximumScale = 4.0

    static let overshootMinimum = 0.85
    static let overshootMaximum = 4.5
    static let doubleTapScale = 2.0

    static let zoomedThreshold = 1.02

    static let accessibilitySteps: [Double] = [1.0, 2.0, 4.0]

    static func isZoomable(slotId: String, role: StageSlotRole, isLocal: Bool) -> Bool {
        slotId.hasPrefix("share:") && role == StageSlotRole.share && !isLocal
    }

    static func railHidesWithChrome(kind: StageKind, role: StageSlotRole, isCompactHeight: Bool) -> Bool {
        kind == StageKind.presentation && role == StageSlotRole.rail && isCompactHeight
    }

    static func clampScale(_ scale: Double) -> Double {
        min(maximumScale, max(minimumScale, scale))
    }

    static func overshootScale(_ scale: Double) -> Double {
        min(overshootMaximum, max(overshootMinimum, scale))
    }

    static func contentWidth(slotWidth: Double, slotHeight: Double, videoWidth: Double, videoHeight: Double) -> Double {
        if videoWidth <= 0 || videoHeight <= 0 || slotWidth <= 0 || slotHeight <= 0 { return max(0.0, slotWidth) }
        return min(slotWidth, slotHeight * videoWidth / videoHeight)
    }

    static func contentHeight(slotWidth: Double, slotHeight: Double, videoWidth: Double, videoHeight: Double) -> Double {
        if videoWidth <= 0 || videoHeight <= 0 || slotWidth <= 0 || slotHeight <= 0 { return max(0.0, slotHeight) }
        return min(slotHeight, slotWidth * videoHeight / videoWidth)
    }

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

    static func zoomed(_ value: ShareZoomValue, toScale scale: Double, anchorX: Double, anchorY: Double, slotWidth: Double,
                       slotHeight: Double) -> ShareZoomValue {
        if value.scale <= 0 { return ShareZoomValue(scale: scale, panX: 0.0, panY: 0.0) }
        let localX = anchorX - slotWidth / 2.0
        let localY = anchorY - slotHeight / 2.0
        let ratio = scale / value.scale
        return ShareZoomValue(scale: scale, panX: localX - (localX - value.panX) * ratio, panY: localY - (localY - value.panY) * ratio)
    }

    static func live(start: ShareZoomValue, magnification: Double, anchorX: Double, anchorY: Double, translationX: Double,
                     translationY: Double, slotWidth: Double, slotHeight: Double, videoWidth: Double,
                     videoHeight: Double) -> ShareZoomValue {
        let scale = overshootScale(start.scale * magnification)
        let around = zoomed(start, toScale: scale, anchorX: anchorX, anchorY: anchorY, slotWidth: slotWidth, slotHeight: slotHeight)
        let moved = ShareZoomValue(scale: scale, panX: around.panX + translationX, panY: around.panY + translationY)
        return clampedPan(moved, slotWidth: slotWidth, slotHeight: slotHeight, videoWidth: videoWidth, videoHeight: videoHeight)
    }

    static func settled(_ value: ShareZoomValue, slotWidth: Double, slotHeight: Double, videoWidth: Double,
                        videoHeight: Double) -> ShareZoomValue {
        let scale = clampScale(value.scale)
        if scale < zoomedThreshold { return ShareZoomValue.identity }
        let centered = zoomed(value, toScale: scale, anchorX: slotWidth / 2.0, anchorY: slotHeight / 2.0, slotWidth: slotWidth,
                              slotHeight: slotHeight)
        return clampedPan(centered, slotWidth: slotWidth, slotHeight: slotHeight, videoWidth: videoWidth, videoHeight: videoHeight)
    }

    static func doubleTapped(_ value: ShareZoomValue, atX: Double, atY: Double, slotWidth: Double, slotHeight: Double,
                             videoWidth: Double, videoHeight: Double) -> ShareZoomValue {
        if value.isZoomed { return ShareZoomValue.identity }
        let zoomedIn = zoomed(value, toScale: doubleTapScale, anchorX: atX, anchorY: atY, slotWidth: slotWidth, slotHeight: slotHeight)
        return clampedPan(zoomedIn, slotWidth: slotWidth, slotHeight: slotHeight, videoWidth: videoWidth, videoHeight: videoHeight)
    }

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

    static func stepped(_ value: ShareZoomValue, zoomIn: Bool, slotWidth: Double, slotHeight: Double, videoWidth: Double,
                        videoHeight: Double) -> ShareZoomValue {
        let next = steppedScale(fromScale: value.scale, zoomIn: zoomIn)
        if next < zoomedThreshold { return ShareZoomValue.identity }
        let centered = zoomed(value, toScale: next, anchorX: slotWidth / 2.0, anchorY: slotHeight / 2.0, slotWidth: slotWidth,
                              slotHeight: slotHeight)
        return clampedPan(centered, slotWidth: slotWidth, slotHeight: slotHeight, videoWidth: videoWidth, videoHeight: videoHeight)
    }

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

    static func interpolated(start: ShareZoomValue, end: ShareZoomValue, fraction: Double) -> ShareZoomValue {
        ShareZoomValue(scale: start.scale + (end.scale - start.scale) * fraction,
                       panX: start.panX + (end.panX - start.panX) * fraction,
                       panY: start.panY + (end.panY - start.panY) * fraction)
    }

    static func spokenScale(_ scale: Double) -> Double {
        (scale * 10.0).rounded() / 10.0
    }

    static func isWholeScale(_ scale: Double) -> Bool {
        let spoken = spokenScale(scale)
        return spoken == spoken.rounded()
    }
}

enum ShareAnnouncementPolicy {

    static let presentingKind = "presenting"

    static func startedPresenterName(previous: StageInputs, next: StageInputs) -> String {
        if previous.participants.isEmpty || previous.callSession != next.callSession { return "" }
        let presenter = next.screenShareUserId
        if presenter.isEmpty || presenter == previous.screenShareUserId { return "" }
        if next.isLocalScreenSharing || presenter == next.localUserId { return "" }
        return next.participant(presenter)?.displayName ?? ""
    }

    static func localShareFeedback(previous: StageInputs, next: StageInputs) -> FeedbackKind? {
        if previous.participants.isEmpty || previous.callSession != next.callSession { return nil }
        if next.isLocalScreenSharing && !previous.isLocalScreenSharing { return FeedbackKind.shareStarted }
        if !next.isLocalScreenSharing && previous.isLocalScreenSharing { return FeedbackKind.shareStopped }
        return nil
    }
}

struct SelfViewMoveTitles: Equatable {
    let topLeft: String
    let topRight: String
    let bottomLeft: String
    let bottomRight: String
}

enum SelfViewSnapPolicy {

    static let phoneWidthPercent = 28.0
    static let phoneMinimumWidth = 96.0
    static let phoneMaximumWidth = 132.0
    static let regularWidth = 160.0

    static let dragMinimumDistance = 10.0

    static let decelerationRate = 0.998

    static let topLeft = "top-left"
    static let topRight = "top-right"
    static let bottomLeft = "bottom-left"
    static let bottomRight = "bottom-right"
    static let corners: [String] = [topLeft, topRight, bottomLeft, bottomRight]
    static let moveItemPrefix = "selfView.move."
    static let moveSectionId = "tile.selfView.move"

    static func floatingWidth(_ viewport: StageViewport) -> Double {
        if StageLayoutPolicy.usesRegularSpacing(viewport) { return regularWidth }
        let shortEdge = min(viewport.width, viewport.height)
        return min(phoneMaximumWidth, max(phoneMinimumWidth, shortEdge * phoneWidthPercent / 100.0))
    }

    static func floatingHeight(_ viewport: StageViewport) -> Double {
        floatingWidth(viewport) * 4.0 / 3.0
    }

    static func projectedDistance(velocity: Double) -> Double {
        velocity / 1000.0 * decelerationRate / (1.0 - decelerationRate)
    }

    static func corner(centerX: Double, centerY: Double, viewport: StageViewport) -> String {
        let midX = viewport.insetLeading + (viewport.width - viewport.insetLeading - viewport.insetTrailing) / 2.0
        let midY = viewport.insetTop + (viewport.height - viewport.insetTop - viewport.insetBottom) / 2.0
        let top = centerY < midY
        let leading = centerX < midX
        if top { return leading ? topLeft : topRight }
        return leading ? bottomLeft : bottomRight
    }

    static func dropCorner(frame: StageFrame, leadingTranslationX: Double, translationY: Double, viewport: StageViewport) -> String {
        corner(centerX: frame.x + frame.width / 2.0 + leadingTranslationX, centerY: frame.y + frame.height / 2.0 + translationY,
               viewport: viewport)
    }

    static func leadingX(_ physicalX: Double, isRightToLeft: Bool) -> Double {
        isRightToLeft ? -physicalX : physicalX
    }

    static func physicalShiftX(fromFrame: StageFrame, toFrame: StageFrame, isRightToLeft: Bool) -> Double {
        leadingX(toFrame.x - fromFrame.x, isRightToLeft: isRightToLeft)
    }

    static func shiftY(fromFrame: StageFrame, toFrame: StageFrame) -> Double {
        toFrame.y - fromFrame.y
    }

    static func playsSnapFeedback(previousCorner: String, nextCorner: String) -> Bool {
        previousCorner != nextCorner
    }

    static func offersMove(role: StageSlotRole, isLocal: Bool) -> Bool {
        isLocal && role.isSelfMovable
    }

    static func moveItemId(_ corner: String) -> String {
        moveItemPrefix + corner
    }

    static func corner(forItemId itemId: String) -> String {
        if !itemId.hasPrefix(moveItemPrefix) { return "" }
        let raw = String(itemId.dropFirst(moveItemPrefix.count))
        return corners.contains(raw) ? raw : ""
    }

    static func rawCorner(physical: String, isRightToLeft: Bool) -> String {
        if !isRightToLeft { return physical }
        if physical == topLeft { return topRight }
        if physical == topRight { return topLeft }
        if physical == bottomLeft { return bottomRight }
        if physical == bottomRight { return bottomLeft }
        return physical
    }

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

enum StageCameraFlip {

    @MainActor
    static func perform(_ stage: StagePresenter) -> Bool {
        let chrome = stage.chrome
        if !chrome.canFlipCamera || chrome.isFlipInFlight { return false }
        stage.flipCamera()
        return true
    }
}
