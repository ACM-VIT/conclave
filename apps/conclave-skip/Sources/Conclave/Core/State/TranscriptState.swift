import Foundation
import Observation

/// Lifecycle of the transcript worker WebSocket (distinct from the transcription
/// session status, which is server-driven).
enum TranscriptConnectionStatus: String {
    case idle
    case connecting
    case connected
    case error
}

/// A single transcript line. `itemId` is the stable identity used to merge
/// streaming deltas and finalized segments, matching the web client.
struct TranscriptSegmentModel: Identifiable, Equatable {
    let itemId: String
    let sequence: Int
    let speakerUserId: String
    let speakerDisplayName: String
    let text: String
    let startMs: Double
    let isFinal: Bool

    var id: String { itemId }
}

/// Observable transcript view state. Holds finalized segments plus the in-flight
/// partials map so the panel can render live captions as they stream in.
@MainActor
@Observable
final class TranscriptState {
    var connectionStatus: TranscriptConnectionStatus = .idle
    var sessionStatus: String = "idle"           // idle/starting/live/paused/stopping/error/takeover_needed
    var errorMessage: String?
    var controllerName: String?
    var canStart: Bool = false
    var canStop: Bool = false

    private(set) var finals: [TranscriptSegmentModel] = []
    private(set) var partials: [String: TranscriptSegmentModel] = [:]

    var isLive: Bool { sessionStatus == "live" }
    var isBusy: Bool { sessionStatus == "starting" || sessionStatus == "stopping" }

    /// Finals + partials, ordered the same way the web orders them
    /// (sequence, then startMs, then itemId).
    var orderedSegments: [TranscriptSegmentModel] {
        var combined = finals
        combined.append(contentsOf: partials.values)
        return combined.sorted { left, right in
            if left.sequence != right.sequence { return left.sequence < right.sequence }
            if left.startMs != right.startMs { return left.startMs < right.startMs }
            return left.itemId < right.itemId
        }
    }

    func applyPartial(_ segment: TranscriptSegmentModel) {
        partials[segment.itemId] = segment
    }

    func applyFinal(_ segment: TranscriptSegmentModel) {
        partials.removeValue(forKey: segment.itemId)
        if let index = finals.firstIndex(where: { $0.itemId == segment.itemId }) {
            finals[index] = segment
        } else {
            finals.append(segment)
        }
    }

    func resetPartials() {
        partials = [:]
    }

    func replaceSnapshot(finals: [TranscriptSegmentModel], partials: [TranscriptSegmentModel]) {
        self.finals = finals
        var map: [String: TranscriptSegmentModel] = [:]
        for segment in partials {
            map[segment.itemId] = segment
        }
        self.partials = map
    }

    func clearSegments() {
        finals = []
        partials = [:]
    }

    func resetAll() {
        clearSegments()
        connectionStatus = .idle
        sessionStatus = "idle"
        errorMessage = nil
        controllerName = nil
        canStart = false
        canStop = false
    }
}
