#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1bStageMomentsTests {
    static let policyFile = "Sources/Conclave/Features/Meeting/Stage/ChromeAutoHidePolicy.swift"
    static let iosReactionsFile = "Sources/Conclave/Features/Meeting/Stage/Reactions+iOS.swift"
    static let androidReactionsFile = "Sources/Conclave/Skip/ui/call/stage/Reactions.kt"
    static let cellFile = "Sources/Conclave/Features/Meeting/Controls/CallControlCell+iOS.swift"
    static let chromeFile = "Sources/Conclave/Features/Meeting/Stage/StageChrome+iOS.swift"
    static let detailsFile = "Sources/Conclave/Features/Meeting/Stage/MeetingDetailsPanel+iOS.swift"
    static let chipFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveStageChip+iOS.swift"

    private func section(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try #require(text.range(of: start), "missing \(start)")
        let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex), "missing \(end) after \(start)")
        return String(text[lower.upperBound..<upper.lowerBound])
    }

    private func tail(_ text: String, after marker: String, from start: String) throws -> String {
        let anchor = try #require(text.range(of: start), "missing \(start)")
        let split = try #require(text.range(of: marker, range: anchor.upperBound..<text.endIndex), "missing \(marker) after \(start)")
        return String(text[split.upperBound..<text.endIndex])
    }

    private func count(_ needle: String, in text: String) -> Int {
        text.components(separatedBy: needle).count - 1
    }

    @Test func driftDirectionIsDeterministicByEventIdLikeTheLane() {
        let vectors: [(Int, Double)] = [(-1, 1.0), (0, -1.0), (1, -0.5), (2, 0.5), (3, 1.0), (1000, -1.0)]
        for (id, expected) in vectors {
            #expect(StageReactionPolicy.driftDirection(eventId: id) == expected, "\(id)")
        }
        for id in -8...8 {
            #expect(StageReactionPolicy.driftDirection(eventId: id) == StageReactionPolicy.driftDirection(eventId: id + 4), "\(id)")
            let offset = StageReactionPolicy.driftDistance * StageReactionPolicy.driftDirection(eventId: id)
            #expect(offset != 0 && abs(offset) <= StageReactionPolicy.driftDistance, "\(id)")
        }
    }

    @Test func popAndDriftConstantsAreThePolicyValues() {
        #expect(StageReactionPolicy.popMillis == 160.0)
        #expect(StageReactionPolicy.popFromScale == 0.85)
        #expect(StageReactionPolicy.driftDistance == 10.0)
        #expect(StageReactionPolicy.popMillis < StageReactionPolicy.riseMillis)
        #expect(StageReactionPolicy.popFromScale > 0 && StageReactionPolicy.popFromScale < 1)
    }

    private func reactionEvent(_ id: Int) -> ReactionEvent {
        ReactionEvent(id: id, senderName: "", isLocal: false, kind: "emoji", value: "x", label: "x")
    }

    private func reactionSnapshot(_ ids: [Int], renderLimit: Int = 20) -> StageReactionsSnapshot {
        var events: [ReactionEvent] = []
        for id in ids { events.append(reactionEvent(id)) }
        return StageReactionsSnapshot(revision: 1, events: events, renderLimit: renderLimit)
    }

    @Test func reducedMotionShowsTheNewestReactionPerLaneInSlotsThatNeverOverlap() throws {
        let burst = reactionSnapshot(Array(1...25))
        let reduced = StageReactionPolicy.visibleEvents(burst, reduceMotion: true)
        #expect(reduced.map(\.id) == [23, 24, 25])
        #expect(reduced.map { StageReactionPolicy.lane(for: $0.id) } == [2, 0, 1])
        #expect(StageReactionPolicy.visibleEvents(reactionSnapshot([1, 4, 7, 8]), reduceMotion: true).map(\.id) == [7, 8])
        #expect(StageReactionPolicy.visibleEvents(reactionSnapshot([3, 1, 4, 6, 2]), reduceMotion: true).map(\.id) == [4, 6, 2])
        #expect(StageReactionPolicy.visibleEvents(reactionSnapshot(Array(1...25), renderLimit: 2), reduceMotion: true).map(\.id) == [24, 25])
        #expect(StageReactionPolicy.visibleEvents(reactionSnapshot([]), reduceMotion: true).isEmpty)

        let moving = StageReactionPolicy.visibleEvents(burst, reduceMotion: false)
        #expect(moving.count == 20 && moving.first?.id == 6 && moving.last?.id == 25)
        #expect(moving == StageReactionPolicy.visibleEvents(burst))

        #expect(StageReactionPolicy.reducedLaneOffset == 72.0)
        #expect(StageReactionPolicy.reducedSlotWidth == 64.0)
        #expect(StageReactionPolicy.reducedSlotWidth >= StageReactionPolicy.bubbleDiameter)
        #expect(StageReactionPolicy.reducedLaneOffset == StageReactionPolicy.reducedSlotWidth + 8)
        #expect((StageReactionPolicy.reducedSlotWidth - StageReactionPolicy.bubbleDiameter) / 2 == 8)
        #expect(StageReactionPolicy.laneOffset == 20.0 && StageReactionPolicy.laneCount == 3)
        let slotsEnd = StageReactionPolicy.leadingInset + Double(StageReactionPolicy.laneCount - 1) * StageReactionPolicy.reducedLaneOffset
            + StageReactionPolicy.reducedSlotWidth
        #expect(slotsEnd == 220 && slotsEnd <= 360)

        for count in 0...25 {
            for limit in [8, 12, 20] {
                let snapshot = reactionSnapshot(Array(stride(from: 1, through: count, by: 1)), renderLimit: limit)
                let limited = StageReactionPolicy.visibleEvents(snapshot).map(\.id)
                let shown = StageReactionPolicy.visibleEvents(snapshot, reduceMotion: true).map(\.id)
                let lanes = shown.map { StageReactionPolicy.lane(for: $0) }
                #expect(shown.count <= StageReactionPolicy.laneCount, "\(count) \(limit)")
                #expect(Set(lanes).count == lanes.count, "\(count) \(limit)")
                #expect(Set(lanes) == Set(limited.map { StageReactionPolicy.lane(for: $0) }), "\(count) \(limit)")
                #expect(shown == shown.sorted(), "\(count) \(limit)")
                for id in shown {
                    let newest = limited.last { StageReactionPolicy.lane(for: $0) == StageReactionPolicy.lane(for: id) }
                    #expect(newest == id, "\(count) \(limit) \(id)")
                }
                for first in lanes {
                    for second in lanes where first != second {
                        let gap = abs(Double(first - second)) * StageReactionPolicy.reducedLaneOffset - StageReactionPolicy.reducedSlotWidth
                        #expect(gap >= 8, "\(count) \(limit)")
                    }
                }
            }
        }
    }

    @Test func theReducedPillFitsSomeoneAtDefaultTextAndCapsLargeTextOnBothPlatforms() throws {
        let pillPadding = 6.0
        #expect(StageReactionPolicy.reducedSlotWidth - 2 * pillPadding >= 51)
        #expect(StageReactionPolicy.reducedPillMaxFontScale == 1.5)
    }

    @Test func theReactionLayerRisesWithTheTileLabelSoPillsNeverCoverItAtLargeText() throws {
        let androidBar = 76.0
        let iosBar = 64.0
        let androidLine = 16.0
        let iosDefaultLine = 15.5
        #expect(StageReactionPolicy.layerLift == 64.0)
        #expect(StageReactionPolicy.layerBottomInset(barReserve: androidBar, labelLineHeight: androidLine, defaultLabelLineHeight: androidLine) == 140)
        #expect(StageReactionPolicy.layerBottomInset(barReserve: androidBar, labelLineHeight: androidLine * 1.5, defaultLabelLineHeight: androidLine) == 148)
        #expect(StageReactionPolicy.layerBottomInset(barReserve: androidBar, labelLineHeight: androidLine * 2.0, defaultLabelLineHeight: androidLine) == 156)
        #expect(StageReactionPolicy.layerBottomInset(barReserve: androidBar, labelLineHeight: androidLine * 0.85, defaultLabelLineHeight: androidLine) == 140)
        #expect(StageReactionPolicy.layerBottomInset(barReserve: iosBar, labelLineHeight: iosDefaultLine, defaultLabelLineHeight: iosDefaultLine) == 128)
        #expect(abs(StageReactionPolicy.layerBottomInset(barReserve: iosBar, labelLineHeight: 22.7, defaultLabelLineHeight: iosDefaultLine) - 135.2) < 0.0001)
        #expect(StageReactionPolicy.layerBottomInset(barReserve: iosBar, labelLineHeight: 13.0, defaultLabelLineHeight: iosDefaultLine) == 128)

        let labelInset = 8.0
        let labelPadding = 4.0
        let mutedIcon = 16.0
        let paddings = [StageLayoutPolicy.compactPadding, StageLayoutPolicy.regularPadding, StageViewportPolicy.tileControlGap]
        for scale in [0.85, 1.0, 1.15, 1.3, 1.5, 1.8, 2.0] {
            let line = androidLine * scale
            let layer = StageReactionPolicy.layerBottomInset(barReserve: androidBar, labelLineHeight: line, defaultLabelLineHeight: androidLine)
            for padding in paddings {
                let labelTop = androidBar + padding + labelInset + 2 * labelPadding + max(mutedIcon, line)
                #expect(abs((layer - labelTop) - (32 - padding)) < 0.0001, "android \(scale) \(padding)")
                #expect(layer - labelTop >= 16 - 0.0001, "android \(scale) \(padding)")
            }
        }
        for growth in [-2.0, 0.0, 2.4, 4.8, 7.2] {
            let line = iosDefaultLine + growth
            let layer = StageReactionPolicy.layerBottomInset(barReserve: iosBar, labelLineHeight: line, defaultLabelLineHeight: iosDefaultLine)
            for padding in paddings {
                let labelTop = iosBar + padding + labelInset + 2 * labelPadding + line
                #expect(layer - labelTop >= 16 - 0.0001, "ios \(growth) \(padding)")
                if growth >= 0 {
                    #expect(abs((layer - labelTop) - (32.5 - padding)) < 0.0001, "ios \(growth) \(padding)")
                }
            }
        }
    }

    static let androidLandscape = StageViewport(width: 914.3, height: 411.4, insetTop: 84.2, insetBottom: 100.2, insetLeading: 0,
                                                insetTrailing: 0, widthClass: StageSizeClass.expanded, heightClass: StageSizeClass.compact,
                                                placement: .bottomBar)
    static let androidSafeBottom = 24.2
    static let androidCutoutLandscape = StageViewport(width: 914.3, height: 411.4, insetTop: 84.2, insetBottom: 100.2, insetLeading: 32,
                                                      insetTrailing: 0, widthClass: StageSizeClass.expanded,
                                                      heightClass: StageSizeClass.compact, placement: .bottomBar)
    static let androidGestureLandscape = StageViewport(width: 892, height: 412, insetTop: 84, insetBottom: 100, insetLeading: 0,
                                                       insetTrailing: 0, widthClass: StageSizeClass.expanded,
                                                       heightClass: StageSizeClass.compact, placement: .bottomBar)
    static let androidShortLandscape = StageViewport(width: 800, height: 360, insetTop: 84, insetBottom: 100, insetLeading: 0,
                                                     insetTrailing: 0, widthClass: StageSizeClass.medium, heightClass: StageSizeClass.compact,
                                                     placement: .bottomBar)
    static let androidGestureSafeBottom = 24.0
    static let iosLandscape = StageViewportPolicy.iOS(contentWidth: 750, contentHeight: 369,
                                                      safeArea: StageChromeInsets(top: 0, bottom: 21, leading: 47, trailing: 47),
                                                      regularWidth: false, compactHeight: true, topReserve: 56, barReserve: 64,
                                                      trailingReserve: 64)
    static let iosSafeBottom = 21.0

    private func burstStage(_ viewport: StageViewport, count: Int = 6) -> StagePresenter {
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.setViewport(viewport)
        stage.apply(count == 6 ? StageFixtureScript.inputs(for: .reactionsBurst25) : StageFixtureScript.base(count: count))
        return stage
    }

    private func androidMetrics(fontScale: Double, viewport: StageViewport = S1bStageMomentsTests.androidLandscape,
                                safeBottom: Double = S1bStageMomentsTests.androidSafeBottom) -> StageReactionSlotMetrics {
        StageReactionSlotMetrics(
            defaultBottomInset: StageReactionPolicy.layerBottomInset(barReserve: 76, labelLineHeight: 16 * fontScale, defaultLabelLineHeight: 16),
            layerLeading: viewport.insetLeading, layerBottom: safeBottom,
            slotHeight: StageReactionPolicy.reducedSlotHeight(pillLineHeight: 16 * min(fontScale, StageReactionPolicy.reducedPillMaxFontScale)),
            labelBand: StageReactionPolicy.tileLabelBand(lineHeight: 16 * fontScale), barMaxWidth: ControlBarPolicy.androidMaxToolbarWidth)
    }

    private func iosMetrics(tileLine: Double, pillLine: Double) -> StageReactionSlotMetrics {
        StageReactionSlotMetrics(
            defaultBottomInset: StageReactionPolicy.layerBottomInset(barReserve: 64, labelLineHeight: tileLine, defaultLabelLineHeight: 15.5),
            layerLeading: Self.iosLandscape.insetLeading, layerBottom: Self.iosSafeBottom,
            slotHeight: StageReactionPolicy.reducedSlotHeight(pillLineHeight: pillLine),
            labelBand: StageReactionPolicy.tileLabelBand(lineHeight: tileLine), barMaxWidth: 0)
    }

    private func slotRects(_ placement: StageReactionSlotPlacement, viewport: StageViewport, metrics: StageReactionSlotMetrics) -> [StageFrame] {
        let bottom = viewport.height - metrics.layerBottom - placement.bottomInset
        var rects: [StageFrame] = []
        for lane in 0..<StageReactionPolicy.laneCount {
            let x = metrics.layerLeading + StageReactionPolicy.leadingInset
                + StageReactionPolicy.slotOffsetX(lane: lane, reduceMotion: true, shape: placement.shape)
            let lift = StageReactionPolicy.slotOffsetY(lane: lane, shape: placement.shape, slotHeight: metrics.slotHeight)
            rects.append(StageFrame(slotId: "slot" + String(lane), x: x, y: bottom - lift - metrics.slotHeight,
                                    width: StageReactionPolicy.reducedSlotWidth, height: metrics.slotHeight))
        }
        return rects
    }

    private func tileLabels(viewport: StageViewport, layout: StageLayoutSnapshot, frames: [StageFrame], line: Double) -> [StageFrame] {
        var labels: [StageFrame] = []
        for slot in layout.slots where StageViewportPolicy.carriesNameTag(slot.role) {
            guard let frame = StageLayoutPolicy.find(slot.id, in: frames) else { continue }
            let insets = StageViewportPolicy.tileInsets(kind: layout.kind, role: slot.role, viewport: viewport)
            let height = 2 * 4.0 + max(16.0, line)
            for inset in [8.0, 4.0] {
                let bottom = frame.maxY - insets.bottom - inset
                labels.append(StageFrame(slotId: slot.id, x: frame.x + insets.leading + inset, y: bottom - height,
                                         width: frame.width - insets.leading - insets.trailing - 2 * inset, height: height))
            }
        }
        return labels
    }

    private func coveredArea(_ rects: [StageFrame], labels: [StageFrame]) -> Double {
        var total = 0.0
        for rect in rects {
            for label in labels {
                let width = min(rect.maxX, label.maxX) - max(rect.x, label.x)
                let height = min(rect.maxY, label.maxY) - max(rect.y, label.y)
                if width > 0 && height > 0 { total += width * height }
            }
        }
        return total
    }

    private func expectClear(viewport: StageViewport, layout: StageLayoutSnapshot, frames: [StageFrame], metrics: StageReactionSlotMetrics,
                             line: Double, _ name: String) -> StageReactionSlotPlacement {
        let placement = StageReactionPolicy.reducedPlacement(viewport: viewport, kind: layout.kind, slots: layout.slots, frames: frames,
                                                             metrics: metrics)
        let labels = tileLabels(viewport: viewport, layout: layout, frames: frames, line: line)
        #expect(!labels.isEmpty, "\(name)")
        for rect in slotRects(placement, viewport: viewport, metrics: metrics) {
            for label in labels {
                #expect(!StageLayoutPolicy.overlaps(rect, label), "\(name) \(rect.slotId) covers the \(label.slotId) label")
            }
            #expect(rect.y >= viewport.insetTop - 0.001, "\(name) \(rect.slotId) rises into the top chrome")
            #expect(rect.maxY <= viewport.height - metrics.layerBottom + 0.001, "\(name) \(rect.slotId) leaves the layer")
            #expect(rect.x >= viewport.insetLeading + StageReactionPolicy.leadingInset - 0.001, "\(name) \(rect.slotId) leaves the safe area")
        }
        return placement
    }

    private func expectClear(_ stage: StagePresenter, metrics: StageReactionSlotMetrics, line: Double, _ name: String) -> StageReactionSlotPlacement {
        expectClear(viewport: stage.viewport, layout: stage.layout, frames: stage.currentFrames(), metrics: metrics, line: line, name)
    }

    @Test func reducedSlotsNeverSitOverATileLabelInATwoByThreeLandscapeGrid() {
        let android = burstStage(Self.androidLandscape)
        let frames = android.currentFrames()
        #expect(android.layout.kind == .grid && frames.count == 6)
        #expect(Set(frames.map { Int($0.x.rounded()) }).count == 3 && Set(frames.map { Int($0.y.rounded()) }).count == 2)

        let androidDefault = expectClear(android, metrics: androidMetrics(fontScale: 1.0), line: 16, "android default")
        #expect(androidDefault.shape == .column)
        #expect(abs(androidDefault.bottomInset - 71.0) < 0.01)
        let androidLarge = expectClear(android, metrics: androidMetrics(fontScale: 2.0), line: 32, "android font 2.0")
        #expect(androidLarge.shape == .column)
        #expect(abs(androidLarge.bottomInset - 47.0) < 0.01)
        for placement in [androidDefault, androidLarge] {
            let column = slotRects(placement, viewport: Self.androidLandscape, metrics: androidMetrics(fontScale: 1.0))
            for rect in column {
                #expect(frames.allSatisfy { rect.maxX <= $0.x }, "the stacked slots stay in the margin beside the grid")
            }
        }

        let ios = burstStage(Self.iosLandscape)
        #expect(ios.layout.kind == .grid && ios.currentFrames().count == 6)
        let iosDefault = expectClear(ios, metrics: iosMetrics(tileLine: 15.5, pillLine: 13.13), line: 15.5, "ios default")
        #expect(iosDefault.shape == .row && iosDefault.bottomInset != 128)
        let iosLarge = expectClear(ios, metrics: iosMetrics(tileLine: 22.7, pillLine: 20.29), line: 22.7, "ios AX5")
        #expect(iosLarge.shape == .row && abs(iosLarge.bottomInset - 135.2) > 1)
    }

    @Test func whenNeitherARowNorAColumnClearsTheLabelsTheSlotsTakeAMarginBlock() {
        let viewport = Self.androidGestureLandscape
        let stage = burstStage(viewport, count: 7)
        let frames = stage.currentFrames()
        #expect(stage.layout.kind == .grid && frames.count == 7)
        #expect(Set(frames.map { Int($0.y.rounded()) }).count == 2)
        for scale in [1.0, 2.0] {
            let metrics = androidMetrics(fontScale: scale, viewport: viewport, safeBottom: Self.androidGestureSafeBottom)
            let resting = StageReactionSlotPlacement(bottomInset: metrics.defaultBottomInset, shape: .row)
            let labels = tileLabels(viewport: viewport, layout: stage.layout, frames: frames, line: 16 * scale)
            #expect(coveredArea(slotRects(resting, viewport: viewport, metrics: metrics), labels: labels) > 0,
                    "the 2c060c7a row covers a label here at font \(scale)")
            let placement = expectClear(stage, metrics: metrics, line: 16 * scale, "seven tiles font \(scale)")
            #expect(placement.shape == .block, "font \(scale)")
            #expect(abs(placement.bottomInset - (scale == 1.0 ? 34.0 : 18.0)) < 0.01, "font \(scale)")
        }
    }

    @Test func whenNothingClearsTheSlotsTakeTheLeastCoveredPlaceNotTheRestingRow() {
        let viewport = Self.androidGestureLandscape
        let stage = burstStage(viewport, count: 8)
        let frames = stage.currentFrames()
        #expect(stage.layout.kind == .grid && frames.count == 8)
        let metrics = androidMetrics(fontScale: 2.0, viewport: viewport, safeBottom: Self.androidGestureSafeBottom)
        let resting = StageReactionSlotPlacement(bottomInset: metrics.defaultBottomInset, shape: .row)
        let placement = StageReactionPolicy.reducedPlacement(viewport: viewport, kind: stage.layout.kind, slots: stage.layout.slots,
                                                             frames: frames, metrics: metrics)
        #expect(placement != resting)
        let labels = tileLabels(viewport: viewport, layout: stage.layout, frames: frames, line: 32)
        let restingCover = coveredArea(slotRects(resting, viewport: viewport, metrics: metrics), labels: labels)
        let placedCover = coveredArea(slotRects(placement, viewport: viewport, metrics: metrics), labels: labels)
        #expect(placedCover < restingCover / 10, "covered \(placedCover) against \(restingCover) at rest")
        for rect in slotRects(placement, viewport: viewport, metrics: metrics) {
            #expect(rect.y >= viewport.insetTop - 0.001 && rect.maxY <= viewport.height - metrics.layerBottom + 0.001)
        }
    }

    @Test func theShortLandscapePhoneKeepsOneRowOfTilesAndTheSlotsClearItsLabels() {
        let viewport = Self.androidShortLandscape
        let stage = burstStage(viewport)
        let frames = stage.currentFrames()
        #expect(stage.layout.kind == .grid && frames.count == 4)
        #expect(stage.layout.slots.contains { $0.role == .overflow })
        #expect(Set(frames.map { Int($0.y.rounded()) }).count == 1)
        for scale in [1.0, 2.0] {
            let metrics = androidMetrics(fontScale: scale, viewport: viewport, safeBottom: Self.androidGestureSafeBottom)
            let placement = expectClear(stage, metrics: metrics, line: 16 * scale, "800 by 360 font \(scale)")
            #expect(placement.shape == .row, "font \(scale)")
        }
    }

    @Test func aLeadingCutoutMovesTheSlotsWithTheGrid() {
        let viewport = Self.androidCutoutLandscape
        let stage = burstStage(viewport)
        let frames = stage.currentFrames()
        #expect(frames.count == 6 && frames.allSatisfy { $0.x >= viewport.insetLeading })
        for scale in [1.0, 2.0] {
            let metrics = androidMetrics(fontScale: scale, viewport: viewport)
            #expect(metrics.layerLeading == 32)
            let placement = expectClear(stage, metrics: metrics, line: 16 * scale, "cutout font \(scale)")
            #expect(placement.shape == .column, "font \(scale)")
            for rect in slotRects(placement, viewport: viewport, metrics: metrics) {
                #expect(abs(rect.x - 44) < 0.001, "the column starts at the cutout plus 12")
            }
        }
    }

    @Test func aRotationWithTheSameSlotsPlacesTheSlotsFromTheLayersOwnLandscapeGeometry() throws {
        let portrait = StageViewport(width: 411.4, height: 914.3, insetTop: 84.2, insetBottom: 100.2, insetLeading: 0, insetTrailing: 0,
                                     widthClass: StageSizeClass.compact, heightClass: StageSizeClass.medium, placement: .bottomBar)
        let stage = burstStage(portrait)
        let layout = stage.layout
        #expect(layout.kind == .grid && layout.slots.count == 6)
        let metrics = androidMetrics(fontScale: 1.0)
        let stale = StageReactionPolicy.reducedPlacement(viewport: stage.viewport, kind: layout.kind, slots: layout.slots,
                                                         frames: stage.currentFrames(), metrics: metrics)
        #expect(stale == StageReactionSlotPlacement(bottomInset: metrics.defaultBottomInset, shape: .row))
        let landscapeFrames = StageLayoutPolicy.frames(viewport: Self.androidLandscape, kind: layout.kind, slots: layout.slots,
                                                       selfCorner: layout.selfCorner)
        let labels = tileLabels(viewport: Self.androidLandscape, layout: layout, frames: landscapeFrames, line: 16)
        #expect(coveredArea(slotRects(stale, viewport: Self.androidLandscape, metrics: metrics), labels: labels) > 0,
                "the portrait placement would cover a label after the rotation")
        let rotated = expectClear(viewport: Self.androidLandscape, layout: layout, frames: landscapeFrames, metrics: metrics, line: 16, "rotated")
        #expect(rotated.shape == .column)
    }

    @Test func portraitAndClearLandscapeStagesKeepTheRestingReducedLayer() {
        let portrait = StageViewport(width: 411.4, height: 914.3, insetTop: 84.2, insetBottom: 100.2, insetLeading: 0, insetTrailing: 0,
                                     widthClass: StageSizeClass.compact, heightClass: StageSizeClass.medium, placement: .bottomBar)
        for scale in [1.0, 2.0] {
            let metrics = androidMetrics(fontScale: scale)
            let stage = burstStage(portrait)
            let placement = StageReactionPolicy.reducedPlacement(viewport: portrait, kind: stage.layout.kind, slots: stage.layout.slots,
                                                                 frames: stage.currentFrames(), metrics: metrics)
            #expect(placement == StageReactionSlotPlacement(bottomInset: metrics.defaultBottomInset, shape: .row), "portrait \(scale)")
        }
        let empty = StageReactionPolicy.reducedPlacement(viewport: .zero, kind: .grid, slots: [], frames: [], metrics: androidMetrics(fontScale: 1.0))
        #expect(empty == StageReactionSlotPlacement(bottomInset: 140, shape: .row))

        let oneOnOne = burstStage(Self.androidLandscape, count: 2)
        #expect(oneOnOne.layout.kind == .oneOnOne)
        for scale in [1.0, 2.0] {
            let metrics = androidMetrics(fontScale: scale)
            let placement = expectClear(oneOnOne, metrics: metrics, line: 16 * scale, "android one on one \(scale)")
            #expect(placement == StageReactionSlotPlacement(bottomInset: metrics.defaultBottomInset, shape: .row))
        }
        let iosOneOnOne = burstStage(Self.iosLandscape, count: 2)
        let iosPlacement = expectClear(iosOneOnOne, metrics: iosMetrics(tileLine: 22.7, pillLine: 20.29), line: 22.7, "ios one on one")
        #expect(iosPlacement == StageReactionSlotPlacement(bottomInset: 135.2, shape: .row))
    }

    @Test func theReducedSlotGeometryMirrorsTheRenderedBubbleAndTileLabel() throws {
        #expect(StageReactionPolicy.reducedSlotGap == StageReactionPolicy.reducedLaneOffset - StageReactionPolicy.reducedSlotWidth)
        #expect(StageReactionPolicy.reducedSlotHeight(pillLineHeight: 16) == 72)
        #expect(StageReactionPolicy.reducedSlotHeight(pillLineHeight: 24) == 80)
        #expect(StageReactionPolicy.tileLabelBand(lineHeight: 16) == 32)
        #expect(StageReactionPolicy.tileLabelBand(lineHeight: 32) == 48)
        #expect(StageReactionPolicy.tileLabelBand(lineHeight: 15.5) == 32)
        #expect(StageReactionPolicy.labelClearance == 8)
        #expect(StageReactionPolicy.reducedShapes == [.row, .column, .block])
        #expect(StageReactionPolicy.shapeWidth(.row) == 208 && StageReactionPolicy.shapeWidth(.column) == 64
                && StageReactionPolicy.shapeWidth(.block) == 136)
        #expect(StageReactionPolicy.shapeHeight(.row, slotHeight: 72) == 72 && StageReactionPolicy.shapeHeight(.column, slotHeight: 72) == 232
                && StageReactionPolicy.shapeHeight(.block, slotHeight: 72) == 152)
        let blockX: [Double] = [0, 72, 0]
        let blockY: [Double] = [0, 0, 80]
        for lane in 0..<StageReactionPolicy.laneCount {
            for shape in StageReactionSlotShape.allCases {
                #expect(StageReactionPolicy.slotOffsetX(lane: lane, reduceMotion: false, shape: shape) == Double(lane) * StageReactionPolicy.laneOffset)
            }
            #expect(StageReactionPolicy.slotOffsetX(lane: lane, reduceMotion: true, shape: .row) == Double(lane) * StageReactionPolicy.reducedLaneOffset)
            #expect(StageReactionPolicy.slotOffsetX(lane: lane, reduceMotion: true, shape: .column) == 0)
            #expect(StageReactionPolicy.slotOffsetX(lane: lane, reduceMotion: true, shape: .block) == blockX[lane])
            #expect(StageReactionPolicy.slotOffsetY(lane: lane, shape: .row, slotHeight: 72) == 0)
            #expect(StageReactionPolicy.slotOffsetY(lane: lane, shape: .column, slotHeight: 72) == Double(lane) * 80)
            #expect(StageReactionPolicy.slotOffsetY(lane: lane, shape: .block, slotHeight: 72) == blockY[lane])
        }
        for shape in StageReactionSlotShape.allCases {
            let rects = slotRects(StageReactionSlotPlacement(bottomInset: 0, shape: shape), viewport: Self.androidLandscape,
                                  metrics: androidMetrics(fontScale: 1.0))
            for first in 0..<rects.count {
                for second in (first + 1)..<rects.count {
                    #expect(!StageLayoutPolicy.overlaps(rects[first], rects[second]), "\(shape) lanes \(first) and \(second) overlap")
                }
            }
        }
    }
}
#endif
