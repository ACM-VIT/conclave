import Foundation

/// S20 SL15 (RR3): what the stage actually shows, computed from the laid-out frames. The per-platform reporter calls
/// this after layout and hands the result to `StagePresenter.reportVisibility(_:)` debounced by 150 ms. A slot counts
/// when its frame intersects the canvas, it hosts a renderer, the stage is not fully covered by a panel, and it is not
/// hidden (the minimized self view keeps its renderer attached at opacity 0; the landscape share strip hides with
/// chrome, S20 8 a).
enum StageVisibilityPolicy {
    static let debounceMillis = 150.0
    static let coverageNone = "none"
    static let coveragePartial = "partial"
    static let coverageFull = "full"

    static func report(frames: [StageFrame], slots: [StageSlot], viewport: StageViewport, kind: StageKind, coverage: String,
                       chromeHidden: Bool, isInPip: Bool, pipTarget: PipTargetFrame?) -> StageVisibilityReport {
        var visible: [String] = []
        var share = ""
        if isInPip {
            // PiP shows only its target (S20 13 d).
            if let target = pipTarget {
                for slot in slots {
                    if slot.id == target.slotId && !slot.userId.isEmpty {
                        if slot.id.hasPrefix("share:") { share = slot.userId } else { visible.append(slot.userId) }
                    }
                }
            }
            return StageVisibilityReport(visibleUserIds: visible, visibleShareUserId: share, coverage: coverage, isInPip: true,
                                         pipTarget: pipTarget)
        }
        if coverage != coverageFull {
            let stripHidden = chromeHidden && kind == StageKind.presentation && StageLayoutPolicy.isCompactHeight(viewport)
            for slot in slots {
                if !slot.role.hostsRenderer || slot.userId.isEmpty { continue }
                if slot.role == StageSlotRole.selfMinimized { continue }
                if slot.role == StageSlotRole.rail && stripHidden { continue }
                guard let frame = StageLayoutPolicy.find(slot.id, in: frames) else { continue }
                if !isOnCanvas(frame, viewport: viewport) { continue }
                if slot.id.hasPrefix("share:") {
                    share = slot.userId
                } else if !visible.contains(slot.userId) {
                    visible.append(slot.userId)
                }
            }
        }
        return StageVisibilityReport(visibleUserIds: visible, visibleShareUserId: share, coverage: coverage, isInPip: false,
                                     pipTarget: pipTarget)
    }

    /// Intersects the canvas with at least one point of overlap in each direction.
    static func isOnCanvas(_ frame: StageFrame, viewport: StageViewport) -> Bool {
        let left = max(0.0, frame.x)
        let top = max(0.0, frame.y)
        let right = min(viewport.width, frame.maxX)
        let bottom = min(viewport.height, frame.maxY)
        return right - left >= 1.0 && bottom - top >= 1.0
    }
}

enum StageConsumerKind: String, CaseIterable, Equatable {
    case audio, video, screen
}

enum StageConsumerAction: String, CaseIterable, Equatable {
    /// Leave the consumer as it is (every audio consumer, always).
    case keep
    case resume
    case pause
}

struct StageConsumerInput: Equatable {
    let consumerId: String
    let userId: String
    let kind: StageConsumerKind
    let isPaused: Bool
}

struct StageConsumerDecision: Equatable {
    let consumerId: String
    let userId: String
    let kind: StageConsumerKind
    let action: StageConsumerAction
}

/// S20 SC6 (RR2, RR4, D16): the consumer policy reads `StageVisibilityReport` instead of layout-independent snapshots.
/// Video follows what is visible; audio consumers are NEVER paused or closed by visibility, tile hiding or layout, so a
/// hidden camera-off speaker stays audible (the #177 class of bug: hiding a camera-off tile must not silence its
/// person). The view model's bandwidth policy calls `visibleVideoUserIds` for its visible set; WP3 keeps the decoding
/// and simulcast-layer mechanics.
enum StageConsumerVisibilityPolicy {
    /// The user ids whose camera or share should decode: visible slots plus the visible share's presenter.
    static func visibleVideoUserIds(_ report: StageVisibilityReport) -> [String] {
        var ids: [String] = []
        for id in report.visibleUserIds {
            if !ids.contains(id) { ids.append(id) }
        }
        if !report.visibleShareUserId.isEmpty && !ids.contains(report.visibleShareUserId) {
            ids.append(report.visibleShareUserId)
        }
        return ids
    }

    static func decisions(consumers: [StageConsumerInput], report: StageVisibilityReport, receiveVideo: Bool) -> [StageConsumerDecision] {
        var result: [StageConsumerDecision] = []
        for consumer in consumers {
            let action: StageConsumerAction
            switch consumer.kind {
            case .audio:
                action = StageConsumerAction.keep
            case .video:
                let wanted = receiveVideo && report.visibleUserIds.contains(consumer.userId)
                action = actionFor(wanted: wanted, isPaused: consumer.isPaused)
            case .screen:
                let wanted = receiveVideo && report.visibleShareUserId == consumer.userId
                action = actionFor(wanted: wanted, isPaused: consumer.isPaused)
            }
            result.append(StageConsumerDecision(consumerId: consumer.consumerId, userId: consumer.userId, kind: consumer.kind,
                                                action: action))
        }
        return result
    }

    static func actionFor(wanted: Bool, isPaused: Bool) -> StageConsumerAction {
        if wanted { return isPaused ? StageConsumerAction.resume : StageConsumerAction.keep }
        return isPaused ? StageConsumerAction.keep : StageConsumerAction.pause
    }
}

/// S20 1 i: the "Raised Hands" and "Speaking" rotors list tiles in slot order.
enum StageRotorPolicy {
    static func raisedHandSlotIds(slots: [StageSlot], models: [TileChromeModel]) -> [String] {
        var result: [String] = []
        for slot in slots {
            if !slot.id.hasPrefix("p:") { continue }
            for model in models {
                if model.userId == slot.userId && model.isHandRaised {
                    result.append(slot.id)
                    break
                }
            }
        }
        return result
    }

    static func speakingSlotIds(slots: [StageSlot], speakerUserId: String) -> [String] {
        var result: [String] = []
        if speakerUserId.isEmpty { return result }
        for slot in slots {
            if slot.id.hasPrefix("p:") && slot.userId == speakerUserId { result.append(slot.id) }
        }
        return result
    }
}
