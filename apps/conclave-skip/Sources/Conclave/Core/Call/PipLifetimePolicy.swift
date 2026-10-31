import Foundation

enum PipScenePhase: String, CaseIterable, Equatable {
    case active, inactive, background
}

enum PipLifetimeAction: String, CaseIterable, Equatable {

    case createController

    case updateSource

    case retargetSink

    case resizeContent

    case attachSink

    case detachSink

    case disableAutomaticStart
    case stopPictureInPicture

    case releaseController

    case restoreCall

    case suspendFeedback

    case resumeFeedback
}

enum PipLifetimePolicy {

    static func suspendsFeedback(isInPictureInPicture: Bool, isTransitioningToPip: Bool) -> Bool {
        isInPictureInPicture || isTransitioningToPip
    }

    static func keepsController(_ phase: CallPresencePhase) -> Bool {
        phase != .ending && phase != .idle
    }
}

final class PipLifetimeMachine {
    private(set) var hasController = false
    private(set) var isSinkAttached = false
    private(set) var isPictureInPictureActive = false

    private(set) var isStopping = false
    private(set) var scene = PipScenePhase.active
    private(set) var phase = CallPresencePhase.idle
    private(set) var targetSlotId = ""
    private(set) var videoWidth = 0
    private(set) var videoHeight = 0
    private(set) var anchorRevision = 0

    private(set) var constructions = 0
    private(set) var releases = 0
    private(set) var stopRequests = 0
    private(set) var restores = 0
    private(set) var sinkSwaps = 0

    func presenceChanged(phase: CallPresencePhase, targetSlotId: String, videoWidth: Int, videoHeight: Int,
                         anchorRevision: Int) -> [PipLifetimeAction] {
        let anchorChanged = anchorRevision != self.anchorRevision
        self.phase = phase
        self.anchorRevision = anchorRevision
        if hasController && !PipLifetimePolicy.keepsController(phase) {
            self.targetSlotId = targetSlotId
            return releaseActions()
        }
        var actions: [PipLifetimeAction] = []
        var created = false
        if !hasController && PipParamsPolicy.isEligiblePhase(phase) && anchorRevision > 0 {
            hasController = true
            created = true
            constructions += 1
            actions.append(PipLifetimeAction.createController)
            if scene == .inactive {

                isSinkAttached = true
                actions.append(PipLifetimeAction.attachSink)
            }
        } else if hasController && anchorChanged && anchorRevision > 0 {
            actions.append(PipLifetimeAction.updateSource)
        }
        if targetSlotId != self.targetSlotId {
            self.targetSlotId = targetSlotId
            if hasController && isSinkAttached && !created {
                sinkSwaps += 1
                actions.append(PipLifetimeAction.retargetSink)
            }
        }

        var resized = false
        if videoWidth > 0 && videoHeight > 0 && (videoWidth != self.videoWidth || videoHeight != self.videoHeight) {
            self.videoWidth = videoWidth
            self.videoHeight = videoHeight
            resized = true
        }
        if hasController && (resized || (created && self.videoWidth > 0 && self.videoHeight > 0)) {
            actions.append(PipLifetimeAction.resizeContent)
        }
        return actions
    }

    func sceneChanged(_ next: PipScenePhase) -> [PipLifetimeAction] {
        var actions: [PipLifetimeAction] = []
        scene = next
        switch next {
        case .inactive:
            if hasController && PipParamsPolicy.isEligiblePhase(phase) && !isSinkAttached {
                isSinkAttached = true
                actions.append(PipLifetimeAction.attachSink)
            }
        case .active:
            if isPictureInPictureActive {

                if !isStopping {

                    isStopping = true
                    stopRequests += 1
                    restores += 1
                    actions.append(PipLifetimeAction.stopPictureInPicture)
                    actions.append(PipLifetimeAction.restoreCall)
                }
            } else if isSinkAttached {
                isSinkAttached = false
                actions.append(PipLifetimeAction.detachSink)
            }
        case .background:
            break
        }
        return actions
    }

    func pictureInPictureStarted() -> [PipLifetimeAction] {
        if isPictureInPictureActive { return [] }
        isPictureInPictureActive = true
        isStopping = false
        return [PipLifetimeAction.suspendFeedback]
    }

    func pictureInPictureWillStop() {
        if isPictureInPictureActive { isStopping = true }
    }

    func pictureInPictureStopped() -> [PipLifetimeAction] {
        var actions: [PipLifetimeAction] = []
        isStopping = false
        if isPictureInPictureActive {
            isPictureInPictureActive = false
            actions.append(PipLifetimeAction.resumeFeedback)
        }
        if isSinkAttached {
            isSinkAttached = false
            actions.append(PipLifetimeAction.detachSink)
        }
        return actions
    }

    func restoreRequested() -> [PipLifetimeAction] {
        if isPictureInPictureActive { isStopping = true }
        restores += 1
        return [PipLifetimeAction.restoreCall]
    }

    func pictureInPictureFailedToStart() -> [PipLifetimeAction] {
        isStopping = false
        if !isPictureInPictureActive { return [] }
        isPictureInPictureActive = false
        return [PipLifetimeAction.resumeFeedback]
    }

    private func releaseActions() -> [PipLifetimeAction] {
        var actions: [PipLifetimeAction] = [PipLifetimeAction.disableAutomaticStart]
        isStopping = false
        if isPictureInPictureActive {
            isPictureInPictureActive = false
            stopRequests += 1
            actions.append(PipLifetimeAction.stopPictureInPicture)
            actions.append(PipLifetimeAction.resumeFeedback)
        }
        if isSinkAttached {
            isSinkAttached = false
            actions.append(PipLifetimeAction.detachSink)
        }
        actions.append(PipLifetimeAction.releaseController)
        hasController = false
        releases += 1
        videoWidth = 0
        videoHeight = 0
        return actions
    }
}
