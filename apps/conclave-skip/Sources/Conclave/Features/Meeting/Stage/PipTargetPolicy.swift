import Foundation
import Observation

struct PipTargetChoice: Equatable {
    let slotId: String
    let userId: String
    let isShare: Bool

    static let none = PipTargetChoice(slotId: "", userId: "", isShare: false)

    var isEmpty: Bool { slotId.isEmpty }
}

struct RendererFrameSize: Equatable {
    let width: Int
    let height: Int

    static let zero = RendererFrameSize(width: 0, height: 0)
}

enum PipTargetPolicy {

    static func choose(inputs: StageInputs, layout: StageLayoutSnapshot) -> PipTargetChoice {
        let local = inputs.localUserId
        let share = inputs.screenShareUserId
        if !share.isEmpty && share != local && !inputs.isLocalScreenSharing {
            if let presenter = inputs.participant(share), !presenter.isLocal {
                return PipTargetChoice(slotId: StageSlot.shareId(share), userId: share, isShare: true)
            }
        }
        if inputs.isWebinarAttendee && !inputs.webinarSpeakerUserId.isEmpty && inputs.webinarSpeakerUserId != local {
            return person(inputs.webinarSpeakerUserId)
        }
        let pinned = layout.pinnedUserId.isEmpty ? inputs.pinnedUserId : layout.pinnedUserId
        if !pinned.isEmpty && pinned != local, let row = inputs.participant(pinned), !row.isLocal {
            return person(pinned)
        }
        let featured = layout.featuredUserId
        if !featured.isEmpty && featured != local, let row = inputs.participant(featured), !row.isLocal, hasVideo(row) {
            return person(featured)
        }
        let remotes = remotesInJoinOrder(inputs, localUserId: local)
        for row in remotes {
            if hasVideo(row) { return person(row.userId) }
        }
        if let first = remotes.first {
            return person(first.userId)
        }
        return PipTargetChoice.none
    }

    static func hasVideo(_ row: StageParticipantInput) -> Bool {
        !row.isCameraOff && !row.videoKey.isEmpty
    }

    static func frame(choice: PipTargetChoice, frames: [StageFrame], canvasWidth: Double, originX: Double, originY: Double,
                      scale: Double, isRightToLeft: Bool, frameSize: RendererFrameSize) -> PipTargetFrame? {
        if choice.isEmpty { return nil }
        guard let slot = StageLayoutPolicy.find(choice.slotId, in: frames) else {
            return PipTargetFrame(slotId: choice.slotId, left: 0, top: 0, right: 0, bottom: 0,
                                  videoWidth: frameSize.width, videoHeight: frameSize.height)
        }
        let leading = isRightToLeft ? canvasWidth - slot.maxX : slot.x
        let left = originX + leading * scale
        let top = originY + slot.y * scale
        return PipTargetFrame(slotId: choice.slotId, left: left, top: top, right: left + slot.width * scale,
                              bottom: top + slot.height * scale, videoWidth: frameSize.width, videoHeight: frameSize.height)
    }

    private static func person(_ userId: String) -> PipTargetChoice {
        PipTargetChoice(slotId: StageSlot.participantId(userId), userId: userId, isShare: false)
    }

    private static func remotesInJoinOrder(_ inputs: StageInputs, localUserId: String) -> [StageParticipantInput] {
        var remotes: [StageParticipantInput] = []
        for row in inputs.presentParticipants {
            if !row.isLocal && row.userId != localUserId { remotes.append(row) }
        }
        return remotes.sorted { $0.joinSerial < $1.joinSerial }
    }
}

@MainActor
@Observable
final class RendererFrameSizeStore {
    private(set) var revision = 0
    @ObservationIgnored private var sizes: [String: RendererFrameSize] = [:]
    @ObservationIgnored private(set) var reportCount = 0

    static let stageKeyPrefix = "stage:"

    @discardableResult
    func report(slotId: String, width: Int, height: Int) -> Bool {
        if slotId.isEmpty || width <= 0 || height <= 0 { return false }
        let next = RendererFrameSize(width: width, height: height)
        if sizes[slotId] == next { return false }
        sizes[slotId] = next
        reportCount += 1
        revision += 1
        return true
    }

    func size(slotId: String) -> RendererFrameSize {
        sizes[slotId] ?? RendererFrameSize.zero
    }

    func remove(slotId: String) {
        if sizes[slotId] == nil { return }
        sizes.removeValue(forKey: slotId)
        revision += 1
    }

    func removeAll() {
        if sizes.isEmpty { return }
        sizes = [:]
        revision += 1
    }

    static func slotId(rendererKey: String) -> String {
        if !rendererKey.hasPrefix(stageKeyPrefix) { return "" }
        return String(rendererKey.dropFirst(stageKeyPrefix.count))
    }
}
