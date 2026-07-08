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

/// A run of consecutive captions from the same speaker, rendered as one block.
struct TranscriptGroup: Identifiable, Equatable {
    let id: String
    let speakerUserId: String
    let speakerDisplayName: String
    /// Wall-clock of the group's first caption - the header timestamp,
    /// matching the web panel's per-group time.
    let firstStartMs: Double
    private(set) var text: String
    private(set) var isFinal: Bool
    private(set) var lastStartMs: Double

    init(segment: TranscriptSegmentModel) {
        self.id = "\(segment.speakerUserId)-\(segment.sequence)-\(segment.itemId)"
        self.speakerUserId = segment.speakerUserId
        self.speakerDisplayName = segment.speakerDisplayName
        self.firstStartMs = segment.startMs
        self.text = segment.text
        self.isFinal = segment.isFinal
        self.lastStartMs = segment.startMs
    }

    mutating func append(_ segment: TranscriptSegmentModel) {
        let trimmed = segment.text.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty {
            text = text.isEmpty ? trimmed : "\(text) \(trimmed)"
        }
        isFinal = isFinal && segment.isFinal
        lastStartMs = segment.startMs
    }
}

enum TranscriptPresentationPolicy {
    static func orderedSegments(
        finals: [TranscriptSegmentModel],
        partials: [String: TranscriptSegmentModel]
    ) -> [TranscriptSegmentModel] {
        var combined = finals
        combined.append(contentsOf: partials.values)
        return combined.sorted { left, right in
            if left.sequence != right.sequence { return left.sequence < right.sequence }
            if left.startMs != right.startMs { return left.startMs < right.startMs }
            return left.itemId < right.itemId
        }
    }

    static func groupedSegments(from segments: [TranscriptSegmentModel]) -> [TranscriptGroup] {
        var groups: [TranscriptGroup] = []
        for segment in segments {
            if var last = groups.last,
               last.speakerUserId == segment.speakerUserId,
               segment.startMs - last.lastStartMs < 90_000 {
                last.append(segment)
                groups[groups.count - 1] = last
            } else {
                groups.append(TranscriptGroup(segment: segment))
            }
        }
        return groups
    }

    static func scrollTrigger(for segments: [TranscriptSegmentModel]) -> String {
        guard let last = segments.last else { return "\(segments.count)" }
        return "\(segments.count)-\(last.itemId)-\(last.text.count)"
    }

    /// A lull long enough that a quiet time marker helps you scan back later
    /// (mirrors the web's TRANSCRIPT_PAUSE_MARKER_MS).
    static let pauseMarkerMs: Double = 180_000

    static func showsPauseMarker(previous: TranscriptGroup?, next: TranscriptGroup) -> Bool {
        guard let previous else { return false }
        return next.firstStartMs - previous.lastStartMs >= pauseMarkerMs
    }

    /// Ids of groups that follow a long lull - cached alongside the groups so
    /// the panel's ForEach stays a plain pass over presentation state.
    static func pauseMarkerGroupIds(for groups: [TranscriptGroup]) -> Set<String> {
        var ids = Set<String>()
        var previous: TranscriptGroup?
        for group in groups {
            if showsPauseMarker(previous: previous, next: group) {
                ids.insert(group.id)
            }
            previous = group
        }
        return ids
    }

    /// Shared formatter: allocating one per timestamp measurably hurts the
    /// live-update render path.
    private static let clockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

    /// Clock-style timestamp for group headers and exports, matching the web's
    /// `formatTranscriptTimestamp` (hour:minute:second).
    static func clockTimestamp(fromMs ms: Double) -> String {
        clockFormatter.string(from: Date(timeIntervalSince1970: ms / 1000.0))
    }

    /// Markdown export of everything currently on screen, matching the web's
    /// `exportTranscriptMarkdown` line shape.
    static func exportMarkdown(roomId: String, segments: [TranscriptSegmentModel]) -> String {
        var lines: [String] = ["# Conclave transcript - \(roomId)", ""]
        for segment in segments {
            let text = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            lines.append("- \(clockTimestamp(fromMs: segment.startMs)) \(segment.speakerDisplayName): \(text)")
        }
        return lines.joined(separator: "\n")
    }
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
    private(set) var orderedSegments: [TranscriptSegmentModel] = []
    private(set) var groupedSegments: [TranscriptGroup] = []
    private(set) var pauseMarkerIds: Set<String> = []
    private(set) var scrollTrigger: String = "0"

    var isLive: Bool { sessionStatus == "live" }
    var isBusy: Bool { sessionStatus == "starting" || sessionStatus == "stopping" }

    func applyPartial(_ segment: TranscriptSegmentModel) {
        if partials[segment.itemId] == segment { return }
        partials[segment.itemId] = segment
        rebuildPresentation()
    }

    func applyFinal(_ segment: TranscriptSegmentModel) {
        let removedPartial = partials.removeValue(forKey: segment.itemId) != nil
        var changedFinal = false
        if let index = finals.firstIndex(where: { $0.itemId == segment.itemId }) {
            if finals[index] != segment {
                finals[index] = segment
                changedFinal = true
            }
        } else {
            finals.append(segment)
            changedFinal = true
        }
        guard removedPartial || changedFinal else { return }
        rebuildPresentation()
    }

    func resetPartials() {
        guard !partials.isEmpty else { return }
        partials = [:]
        rebuildPresentation()
    }

    func replaceSnapshot(finals: [TranscriptSegmentModel], partials: [TranscriptSegmentModel]) {
        self.finals = finals
        var map: [String: TranscriptSegmentModel] = [:]
        for segment in partials {
            map[segment.itemId] = segment
        }
        self.partials = map
        rebuildPresentation()
    }

    func clearSegments() {
        guard !finals.isEmpty || !partials.isEmpty || !orderedSegments.isEmpty || !groupedSegments.isEmpty else { return }
        finals = []
        partials = [:]
        rebuildPresentation()
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

    private func rebuildPresentation() {
        let nextOrderedSegments = TranscriptPresentationPolicy.orderedSegments(
            finals: finals,
            partials: partials
        )
        orderedSegments = nextOrderedSegments
        groupedSegments = TranscriptPresentationPolicy.groupedSegments(from: nextOrderedSegments)
        pauseMarkerIds = TranscriptPresentationPolicy.pauseMarkerGroupIds(for: groupedSegments)
        scrollTrigger = TranscriptPresentationPolicy.scrollTrigger(for: nextOrderedSegments)
    }
}
