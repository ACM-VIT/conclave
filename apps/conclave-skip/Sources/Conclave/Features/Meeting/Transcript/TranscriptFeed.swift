import Foundation
import Observation

// TRN-2 (S60 C6-11, 6 k, L6-4): the incremental transcript feed. `TranscriptState` owns one `TranscriptFeedEngine`
// and feeds it every final, partial, reset and snapshot; the engine keeps the segments in sequence order (binary
// insertion, never a full sort on a delta) and the speaker groups as pairwise runs, so a final or a partial regroups
// only the group it lands in and its two neighbours. The Transcript panel's `TranscriptFeed` (an observable leaf owned
// by `TranscriptPresenter`) drains the engine's changes and patches one row model per touched group, so a partial
// redraws one row and the list itself redraws only when a row id appears or disappears. Shared (transpiled) Swift:
// String raw-value enums, scalar structs, arrays of structs, final classes, no tuples, no protocols.

/// One speaker group: a run of consecutive segments from the same speaker with less than 90 s between neighbours
/// (the legacy `TranscriptPresentationPolicy.groupedSegments` rule, which only ever compares adjacent segments).
struct TranscriptFeedGroup: Equatable {
    /// The legacy group id formula of its first segment (`speaker-sequence-itemId`), so the live row keeps its id
    /// while it grows (TS:181).
    let id: String
    let speakerUserId: String
    let speakerName: String
    let firstStartMs: Double
    let lastStartMs: Double
    let text: String
    let isFinal: Bool
    /// How many segments the group spans.
    let count: Int
}

/// What one engine operation changed. Indexes are valid right after the operation; a change that moved segments
/// (`shifted`) also flags `structureChanged` when merged with another, so the feed then walks every group.
struct TranscriptFeedChange: Equatable {
    let isFullRebuild: Bool
    let structureChanged: Bool
    let shifted: Bool
    let touchedGroupIds: [String]
    let touchedIndexes: [Int]
    /// The newest segment that became final in this change (the screen reader announcement source); empty id when none.
    let finalizedItemId: String
    let finalizedSpeaker: String
    let finalizedText: String

    static let none = TranscriptFeedChange(isFullRebuild: false, structureChanged: false, shifted: false, touchedGroupIds: [],
                                           touchedIndexes: [], finalizedItemId: "", finalizedSpeaker: "", finalizedText: "")

    var isEmpty: Bool {
        !isFullRebuild && !structureChanged && touchedGroupIds.isEmpty && finalizedItemId.isEmpty
    }

    static func full() -> TranscriptFeedChange {
        TranscriptFeedChange(isFullRebuild: true, structureChanged: true, shifted: true, touchedGroupIds: [], touchedIndexes: [],
                             finalizedItemId: "", finalizedSpeaker: "", finalizedText: "")
    }

    func withFinalized(_ segment: TranscriptSegmentModel) -> TranscriptFeedChange {
        TranscriptFeedChange(isFullRebuild: isFullRebuild, structureChanged: structureChanged, shifted: shifted,
                             touchedGroupIds: touchedGroupIds, touchedIndexes: touchedIndexes, finalizedItemId: segment.itemId,
                             finalizedSpeaker: segment.speakerDisplayName,
                             finalizedText: segment.text.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines))
    }

    /// Two changes before one drain: a shift in either makes the indexes unreliable, so the feed walks every group.
    static func merge(_ first: TranscriptFeedChange, _ second: TranscriptFeedChange) -> TranscriptFeedChange {
        if first.isEmpty { return second }
        if second.isEmpty { return first }
        var ids: [String] = first.touchedGroupIds
        for id in second.touchedGroupIds where !ids.contains(id) {
            ids.append(id)
        }
        var indexes: [Int] = first.touchedIndexes
        for index in second.touchedIndexes where !indexes.contains(index) {
            indexes.append(index)
        }
        let finalizedId = second.finalizedItemId.isEmpty ? first.finalizedItemId : second.finalizedItemId
        let finalizedSpeaker = second.finalizedItemId.isEmpty ? first.finalizedSpeaker : second.finalizedSpeaker
        let finalizedText = second.finalizedItemId.isEmpty ? first.finalizedText : second.finalizedText
        return TranscriptFeedChange(isFullRebuild: first.isFullRebuild || second.isFullRebuild,
                                    structureChanged: first.structureChanged || second.structureChanged || first.shifted || second.shifted,
                                    shifted: first.shifted || second.shifted, touchedGroupIds: ids, touchedIndexes: indexes,
                                    finalizedItemId: finalizedId, finalizedSpeaker: finalizedSpeaker, finalizedText: finalizedText)
    }
}

/// The incremental grouping engine (C6-11). Not observable: `TranscriptState` mutates it and notifies its listener;
/// the feed reads it on the main actor.
final class TranscriptFeedEngine {
    /// Same-speaker segments closer than this merge into one group (legacy `groupedSegments`).
    static let groupGapMillis = 90_000.0

    /// Every segment (finals and partials) in sequence, then start time, then item id order.
    private(set) var segments: [TranscriptSegmentModel] = []
    private(set) var groups: [TranscriptFeedGroup] = []
    /// The segment index each group starts at (parallel to `groups`).
    private(set) var starts: [Int] = []
    private(set) var finalCount = 0
    /// `transcript.rebuilds` (S60 L6-12): whole-feed rebuilds (a snapshot, a clear). A delta never rebuilds.
    private(set) var fullRebuildCount = 0
    /// Sorts performed (only a snapshot sorts; a delta inserts by binary search).
    private(set) var sortCount = 0
    /// Groups the last operation touched (C6-11 test: a partial touches at most 3).
    private(set) var lastTouchedGroupCount = 0
    private var byItemId: [String: TranscriptSegmentModel] = [:]
    private var pending = TranscriptFeedChange.none

    init() {}

    var isEmpty: Bool { segments.isEmpty }

    /// The finals in order (export and copy read only these, S60 C6-11).
    var finals: [TranscriptSegmentModel] {
        var result: [TranscriptSegmentModel] = []
        for segment in segments where segment.isFinal {
            result.append(segment)
        }
        return result
    }

    func segment(itemId: String) -> TranscriptSegmentModel? {
        byItemId[itemId]
    }

    /// The changes since the last drain (the feed calls this from the state's notification).
    func drainChanges() -> TranscriptFeedChange {
        let change = pending
        pending = TranscriptFeedChange.none
        return change
    }

    /// True when a pause marker sits before the group at `index` (a lull of at least 3 minutes; legacy
    /// `TranscriptPresentationPolicy.showsPauseMarker`).
    func hasMarker(before index: Int) -> Bool {
        if index <= 0 || index >= groups.count { return false }
        return groups[index].firstStartMs - groups[index - 1].lastStartMs >= TranscriptPresentationPolicy.pauseMarkerMs
    }

    // MARK: Operations

    /// A final or a partial (same item id replaces): an insert by binary search or an in-place patch, then a regroup
    /// limited to the neighbours.
    func upsert(_ segment: TranscriptSegmentModel) {
        if let old = byItemId[segment.itemId] {
            if old == segment { return }
            let index = indexOf(old)
            byItemId[segment.itemId] = segment
            if TranscriptFeedEngine.sameKey(old, segment) && index >= 0 {
                if old.isFinal != segment.isFinal { finalCount += segment.isFinal ? 1 : -1 }
                segments[index] = segment
                record(regroupInPlace(index), finalized: segment, wasFinal: old.isFinal)
                return
            }
            if index >= 0 {
                if old.isFinal { finalCount -= 1 }
                record(removeAt(index), finalized: nil, wasFinal: false)
            }
            if segment.isFinal { finalCount += 1 }
            record(insertNew(segment), finalized: segment, wasFinal: old.isFinal)
            return
        }
        byItemId[segment.itemId] = segment
        if segment.isFinal { finalCount += 1 }
        record(insertNew(segment), finalized: segment, wasFinal: false)
    }

    /// Removes one segment (a reset partial). Returns false when it was not there.
    @discardableResult
    func remove(itemId: String) -> Bool {
        guard let old = byItemId[itemId] else { return false }
        let index = indexOf(old)
        byItemId[itemId] = nil
        if index < 0 { return false }
        if old.isFinal { finalCount -= 1 }
        record(removeAt(index), finalized: nil, wasFinal: false)
        return true
    }

    /// `partials.reset`: every open partial goes, one local regroup each (partials are few).
    func removePartials() {
        var ids: [String] = []
        for segment in segments where !segment.isFinal {
            ids.append(segment.itemId)
        }
        for id in ids {
            remove(itemId: id)
        }
    }

    /// A worker snapshot: the one sort, then one grouping pass (a whole-feed rebuild).
    func replaceAll(_ next: [TranscriptSegmentModel]) {
        var map: [String: TranscriptSegmentModel] = [:]
        for segment in next {
            map[segment.itemId] = segment
        }
        // One entry per item id (the last one wins, as the dictionary keeps it); the order comes from the sort.
        var unique: [TranscriptSegmentModel] = []
        for segment in map.values {
            unique.append(segment)
        }
        segments = unique.sorted { left, right in TranscriptFeedEngine.precedes(left, right) }
        sortCount += 1
        byItemId = map
        var finals = 0
        for segment in segments where segment.isFinal {
            finals += 1
        }
        finalCount = finals
        rebuildGroups()
    }

    /// Clears everything (a new call, `clearSegments`).
    func removeAll() {
        if segments.isEmpty && groups.isEmpty { return }
        segments = []
        groups = []
        starts = []
        byItemId = [:]
        finalCount = 0
        fullRebuildCount += 1
        lastTouchedGroupCount = 0
        pending = TranscriptFeedChange.merge(pending, TranscriptFeedChange.full())
    }

    // MARK: Ordering and grouping rules

    /// Sequence, then start time, then item id (legacy `orderedSegments`).
    static func precedes(_ left: TranscriptSegmentModel, _ right: TranscriptSegmentModel) -> Bool {
        if left.sequence != right.sequence { return left.sequence < right.sequence }
        if left.startMs != right.startMs { return left.startMs < right.startMs }
        return left.itemId < right.itemId
    }

    static func sameKey(_ left: TranscriptSegmentModel, _ right: TranscriptSegmentModel) -> Bool {
        left.sequence == right.sequence && left.startMs == right.startMs && left.itemId == right.itemId
    }

    /// The pairwise group rule: `next` joins `previous`'s group.
    static func continues(previous: TranscriptSegmentModel, next: TranscriptSegmentModel) -> Bool {
        previous.speakerUserId == next.speakerUserId && next.startMs - previous.startMs < groupGapMillis
    }

    static func groupId(_ first: TranscriptSegmentModel) -> String {
        first.speakerUserId + "-" + String(first.sequence) + "-" + first.itemId
    }

    /// The first index whose segment does not precede `segment` (binary search).
    static func insertionIndex(of segment: TranscriptSegmentModel, in list: [TranscriptSegmentModel]) -> Int {
        var low = 0
        var high = list.count
        while low < high {
            let mid = (low + high) / 2
            if precedes(list[mid], segment) {
                low = mid + 1
            } else {
                high = mid
            }
        }
        return low
    }

    // MARK: Private

    private func indexOf(_ segment: TranscriptSegmentModel) -> Int {
        let index = TranscriptFeedEngine.insertionIndex(of: segment, in: segments)
        if index < segments.count && segments[index].itemId == segment.itemId { return index }
        var scan = 0
        while scan < segments.count {
            if segments[scan].itemId == segment.itemId { return scan }
            scan += 1
        }
        return -1
    }

    /// The group whose run contains segment `index` (binary search over `starts`).
    private func groupIndex(containing index: Int) -> Int {
        var low = 0
        var high = starts.count - 1
        var found = 0
        while low <= high {
            let mid = (low + high) / 2
            if starts[mid] <= index {
                found = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        return found
    }

    private func groupEnd(_ groupIndex: Int) -> Int {
        starts[groupIndex] + groups[groupIndex].count
    }

    private func insertNew(_ segment: TranscriptSegmentModel) -> TranscriptFeedChange {
        let position = TranscriptFeedEngine.insertionIndex(of: segment, in: segments)
        if groups.isEmpty {
            segments.insert(segment, at: position)
            let fresh = buildGroups(from: 0, to: segments.count)
            return replaceGroups(first: 0, last: -1, with: fresh, windowStart: 0, shift: 1)
        }
        let oldCount = segments.count
        let first = groupIndex(containing: max(position - 1, 0))
        let last = groupIndex(containing: min(position, oldCount - 1))
        let windowStart = starts[first]
        let windowEnd = groupEnd(last)
        segments.insert(segment, at: position)
        let fresh = buildGroups(from: windowStart, to: windowEnd + 1)
        return replaceGroups(first: first, last: last, with: fresh, windowStart: windowStart, shift: 1)
    }

    private func removeAt(_ position: Int) -> TranscriptFeedChange {
        let oldCount = segments.count
        let first = groupIndex(containing: max(position - 1, 0))
        let last = groupIndex(containing: min(position + 1, oldCount - 1))
        let windowStart = starts[first]
        let windowEnd = groupEnd(last)
        segments.remove(at: position)
        let fresh = windowEnd - 1 > windowStart ? buildGroups(from: windowStart, to: windowEnd - 1) : []
        return replaceGroups(first: first, last: last, with: fresh, windowStart: windowStart, shift: -1)
    }

    private func regroupInPlace(_ position: Int) -> TranscriptFeedChange {
        let first = groupIndex(containing: max(position - 1, 0))
        let last = groupIndex(containing: min(position + 1, segments.count - 1))
        let windowStart = starts[first]
        let windowEnd = groupEnd(last)
        let fresh = buildGroups(from: windowStart, to: windowEnd)
        return replaceGroups(first: first, last: last, with: fresh, windowStart: windowStart, shift: 0)
    }

    /// Groups for segments `[low, high)` by the pairwise rule. The window always starts and ends on an unchanged
    /// boundary, so the groups outside it stay valid.
    private func buildGroups(from low: Int, to high: Int) -> [TranscriptFeedGroup] {
        var result: [TranscriptFeedGroup] = []
        var index = low
        while index < high {
            let first = segments[index]
            var text = first.text
            var isFinal = first.isFinal
            var previous = first
            var count = 1
            var next = index + 1
            while next < high && TranscriptFeedEngine.continues(previous: previous, next: segments[next]) {
                let segment = segments[next]
                let trimmed = segment.text.trimmingCharacters(in: CharacterSet.whitespaces)
                if !trimmed.isEmpty {
                    text = text.isEmpty ? trimmed : text + " " + trimmed
                }
                isFinal = isFinal && segment.isFinal
                previous = segment
                count += 1
                next += 1
            }
            result.append(TranscriptFeedGroup(id: TranscriptFeedEngine.groupId(first), speakerUserId: first.speakerUserId,
                                              speakerName: first.speakerDisplayName, firstStartMs: first.startMs,
                                              lastStartMs: previous.startMs, text: text, isFinal: isFinal, count: count))
            index = next
        }
        return result
    }

    /// Swaps groups `first...last` (none when `last < first`) for `fresh` and shifts the later starts.
    private func replaceGroups(first: Int, last: Int, with fresh: [TranscriptFeedGroup], windowStart: Int, shift: Int) -> TranscriptFeedChange {
        var old: [TranscriptFeedGroup] = []
        var index = first
        while index <= last {
            old.append(groups[index])
            index += 1
        }
        var removed = 0
        while removed < old.count {
            groups.remove(at: first)
            starts.remove(at: first)
            removed += 1
        }
        var start = windowStart
        var offset = 0
        for group in fresh {
            groups.insert(group, at: first + offset)
            starts.insert(start, at: first + offset)
            start += group.count
            offset += 1
        }
        if shift != 0 {
            var later = first + fresh.count
            while later < starts.count {
                starts[later] = starts[later] + shift
                later += 1
            }
        }
        var structure = old.count != fresh.count
        if !structure {
            var check = 0
            while check < old.count {
                if old[check].id != fresh[check].id { structure = true }
                check += 1
            }
        }
        var touchedIds: [String] = []
        var touchedIndexes: [Int] = []
        var position = 0
        for group in fresh {
            var same = false
            for previous in old where previous == group {
                same = true
            }
            if !same {
                touchedIds.append(group.id)
                touchedIndexes.append(first + position)
            }
            position += 1
        }
        lastTouchedGroupCount = touchedIds.count
        return TranscriptFeedChange(isFullRebuild: false, structureChanged: structure, shifted: shift != 0,
                                    touchedGroupIds: touchedIds, touchedIndexes: touchedIndexes, finalizedItemId: "",
                                    finalizedSpeaker: "", finalizedText: "")
    }

    private func rebuildGroups() {
        groups = buildGroups(from: 0, to: segments.count)
        var next: [Int] = []
        var start = 0
        for group in groups {
            next.append(start)
            start += group.count
        }
        starts = next
        fullRebuildCount += 1
        lastTouchedGroupCount = groups.count
        pending = TranscriptFeedChange.merge(pending, TranscriptFeedChange.full())
    }

    private func record(_ change: TranscriptFeedChange, finalized: TranscriptSegmentModel?, wasFinal: Bool) {
        var next = change
        if let segment = finalized, segment.isFinal && !wasFinal {
            next = change.withFinalized(segment)
        }
        pending = TranscriptFeedChange.merge(pending, next)
    }
}

/// One Transcript row (S60 6 j `TranscriptGroupModel`): a speaker group or the pause marker before it. Each row is its
/// own observable, so a partial redraws only its row (6 k); `revision` grows with every visible change.
@MainActor
@Observable
final class TranscriptRowModel {
    let id: String
    let isPauseMarker: Bool
    private(set) var revision: Int = 0
    private(set) var speakerName: String = ""
    private(set) var speakerUserId: String = ""
    private(set) var isYou: Bool = false
    /// The group's first segment (epoch milliseconds); for a marker, the time the talk resumed.
    private(set) var startMillis: Double = 0.0
    private(set) var text: String = ""
    private(set) var isFinal: Bool = true

    init(id: String, isPauseMarker: Bool) {
        self.id = id
        self.isPauseMarker = isPauseMarker
    }

    /// Equality guarded per field; returns true when something visible changed (the revision grew).
    @discardableResult
    func update(speakerName: String, speakerUserId: String, isYou: Bool, startMillis: Double, text: String, isFinal: Bool) -> Bool {
        var changed = false
        if self.speakerName != speakerName {
            self.speakerName = speakerName
            changed = true
        }
        if self.speakerUserId != speakerUserId {
            self.speakerUserId = speakerUserId
            changed = true
        }
        if self.isYou != isYou {
            self.isYou = isYou
            changed = true
        }
        if self.startMillis != startMillis {
            self.startMillis = startMillis
            changed = true
        }
        if self.text != text {
            self.text = text
            changed = true
        }
        if self.isFinal != isFinal {
            self.isFinal = isFinal
            changed = true
        }
        if changed { revision += 1 }
        return changed
    }
}

/// A finalized line for the screen reader announcer (6 i): never a partial.
struct TranscriptFinalizedLine: Equatable {
    let serial: Int
    let speakerName: String
    let text: String

    static let none = TranscriptFinalizedLine(serial: 0, speakerName: "", text: "")
}

/// The Transcript list's observable leaf (S60 0.5 hot leaves, 6 k). The list reads `rowIds` (changes only when a row
/// appears, merges or splits); each row reads its `TranscriptRowModel`; only the follow leaf reads `newestId` and
/// `newestRevision`; only the announcer reads `finalized`.
@MainActor
@Observable
final class TranscriptFeed {
    private(set) var rowIds: [String] = []
    private(set) var newestId: String = ""
    private(set) var newestRevision: Int = 0
    private(set) var finalized: TranscriptFinalizedLine = TranscriptFinalizedLine.none

    @ObservationIgnored private var rows: [String: TranscriptRowModel] = [:]
    @ObservationIgnored private var markerGroupIds: Set<String> = []
    @ObservationIgnored private var localUserId = ""
    /// `transcript.rebuilds`: whole-feed rebuilds (a snapshot or a clear); 0 during a partial stream.
    @ObservationIgnored private(set) var rebuildCount = 0
    /// Row updates and id-list rebuilds (diagnostics).
    @ObservationIgnored private(set) var patchCount = 0
    @ObservationIgnored private(set) var idRebuildCount = 0
    /// Groups the last applied change touched.
    @ObservationIgnored private(set) var lastTouchedCount = 0
    @ObservationIgnored private var finalizedSerial = 0

    init() {}

    var isEmpty: Bool { rowIds.isEmpty }

    /// The row for `id`; a detached empty row when it is gone (a row view that outlives its id draws nothing new).
    func row(_ id: String) -> TranscriptRowModel {
        if let existing = rows[id] { return existing }
        return TranscriptRowModel(id: id, isPauseMarker: id.hasPrefix(TranscriptFeed.markerPrefix))
    }

    static let markerPrefix = "marker:"

    /// "You" rows follow the local user id (S60 6 g own speaker); a change refreshes every row once.
    func setLocalUserId(_ id: String, engine: TranscriptFeedEngine) {
        if id == localUserId { return }
        localUserId = id
        rebuildIds(engine)
    }

    /// Applies the engine's changes: a whole rebuild only after a snapshot or a clear, an id-list pass when a group
    /// appeared, merged or split (or a pause marker moved), else one row patch per touched group.
    func apply(_ change: TranscriptFeedChange, engine: TranscriptFeedEngine) {
        if change.isEmpty { return }
        lastTouchedCount = change.touchedGroupIds.count
        if !change.finalizedItemId.isEmpty {
            finalizedSerial += 1
            finalized = TranscriptFinalizedLine(serial: finalizedSerial, speakerName: change.finalizedSpeaker, text: change.finalizedText)
        }
        if change.isFullRebuild {
            rebuildCount += 1
            rebuildIds(engine)
            return
        }
        var needsIds = change.structureChanged
        if !needsIds {
            for index in change.touchedIndexes {
                if index < 0 || index >= engine.groups.count {
                    needsIds = true
                    continue
                }
                if markerChanged(engine, at: index) || markerChanged(engine, at: index + 1) { needsIds = true }
            }
        }
        if needsIds {
            rebuildIds(engine)
            return
        }
        for index in change.touchedIndexes {
            patch(engine.groups[index])
        }
        publishNewest()
    }

    /// A new call or a cleared transcript: no rows.
    func reset() {
        rows = [:]
        markerGroupIds = []
        if !rowIds.isEmpty { rowIds = [] }
        if !newestId.isEmpty { newestId = "" }
        if newestRevision != 0 { newestRevision = 0 }
        finalized = TranscriptFinalizedLine.none
        finalizedSerial = 0
    }

    // MARK: Private

    private func markerChanged(_ engine: TranscriptFeedEngine, at index: Int) -> Bool {
        if index <= 0 || index >= engine.groups.count { return false }
        return engine.hasMarker(before: index) != markerGroupIds.contains(engine.groups[index].id)
    }

    private func patch(_ group: TranscriptFeedGroup) {
        guard let model = rows[group.id] else { return }
        if model.update(speakerName: group.speakerName, speakerUserId: group.speakerUserId,
                        isYou: !localUserId.isEmpty && group.speakerUserId == localUserId, startMillis: group.firstStartMs,
                        text: group.text, isFinal: group.isFinal) {
            patchCount += 1
        }
    }

    /// One pass over the groups (O(groups), no sort): ids with their markers, new models, equality-guarded updates.
    private func rebuildIds(_ engine: TranscriptFeedEngine) {
        idRebuildCount += 1
        var ids: [String] = []
        var markers: Set<String> = []
        var next: [String: TranscriptRowModel] = [:]
        var index = 0
        for group in engine.groups {
            if engine.hasMarker(before: index) {
                let markerId = TranscriptFeed.markerPrefix + group.id
                let marker = rows[markerId] ?? TranscriptRowModel(id: markerId, isPauseMarker: true)
                marker.update(speakerName: "", speakerUserId: "", isYou: false, startMillis: group.firstStartMs, text: "", isFinal: true)
                next[markerId] = marker
                ids.append(markerId)
                markers.insert(group.id)
            }
            let model = rows[group.id] ?? TranscriptRowModel(id: group.id, isPauseMarker: false)
            if model.update(speakerName: group.speakerName, speakerUserId: group.speakerUserId,
                            isYou: !localUserId.isEmpty && group.speakerUserId == localUserId, startMillis: group.firstStartMs,
                            text: group.text, isFinal: group.isFinal) {
                patchCount += 1
            }
            next[group.id] = model
            ids.append(group.id)
            index += 1
        }
        rows = next
        markerGroupIds = markers
        if ids != rowIds { rowIds = ids }
        publishNewest()
    }

    private func publishNewest() {
        let newest = rowIds.last ?? ""
        if newest != newestId { newestId = newest }
        let revision = newest.isEmpty ? 0 : (rows[newest]?.revision ?? 0)
        if revision != newestRevision { newestRevision = revision }
    }
}
