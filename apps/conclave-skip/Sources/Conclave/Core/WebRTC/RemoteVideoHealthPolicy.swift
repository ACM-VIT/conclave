import Foundation

struct RemoteVideoHealthDecision: Equatable {
    let isStalled: Bool
    let requestKeyFrame: Bool
}

struct RemoteVideoHealthTracker {
    private var lastFrames: Double?
    private var lastBytes: Double?
    private var lastProgressAtMs: Double?
    private var lastKeyFrameRequestAtMs: Double?

    mutating func sample(
        framesDecoded: Double?, nowMs: Double, isPaused: Bool,
        isScreenShare: Bool = false, bytesReceived: Double? = nil
    ) -> RemoteVideoHealthDecision {
        if isPaused {
            lastFrames = nil
            lastBytes = nil
            lastProgressAtMs = nil
            lastKeyFrameRequestAtMs = nil
            return RemoteVideoHealthDecision(isStalled: !isScreenShare, requestKeyFrame: false)
        }
        if lastProgressAtMs == nil { lastProgressAtMs = nowMs }
        if isScreenShare {
            if bytesReceived == nil || lastBytes == nil || (bytesReceived ?? 0.0) - (lastBytes ?? 0.0) < 8_000 {
                lastProgressAtMs = nowMs
            }
            lastBytes = bytesReceived
        }
        if let framesDecoded, framesDecoded.isFinite, framesDecoded >= 0 {
            if framesDecoded > 0 && (lastFrames == nil || framesDecoded != lastFrames) {
                lastProgressAtMs = nowMs
                lastKeyFrameRequestAtMs = nil
            }
            lastFrames = framesDecoded
        }
        let stalledForMs = max(0.0, nowMs - (lastProgressAtMs ?? nowMs))
        let requestKeyFrame = stalledForMs >= 2_000 &&
            (lastKeyFrameRequestAtMs == nil || nowMs - (lastKeyFrameRequestAtMs ?? nowMs) >= 6_000)
        if requestKeyFrame { lastKeyFrameRequestAtMs = nowMs }
        return RemoteVideoHealthDecision(isStalled: !isScreenShare && stalledForMs >= 4_000, requestKeyFrame: requestKeyFrame)
    }
}
