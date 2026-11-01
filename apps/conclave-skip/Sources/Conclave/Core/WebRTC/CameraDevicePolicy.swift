import Foundation

enum CameraCandidatePosition: String, CaseIterable, Equatable {
    case front, back, unspecified
}

enum CameraCandidateKind: String, CaseIterable, Equatable {
    case builtInWide, builtIn, attached, continuity, deskView, other
}

struct CameraCandidate: Equatable {
    let id: String
    let position: CameraCandidatePosition
    let kind: CameraCandidateKind
}

struct CameraFormatCandidate: Equatable {
    let width: Int
    let height: Int
}

struct CameraFrameRateRange: Equatable {
    let minimum: Double
    let maximum: Double
}

enum CameraDeviceSelectionPolicy {

    static func select(_ candidates: [CameraCandidate], wanted: CameraCandidatePosition,
                       systemPreferredId: String = "") -> CameraCandidate? {
        let usable = candidates.filter { $0.kind != CameraCandidateKind.deskView }
        if wanted != CameraCandidatePosition.unspecified {
            if let exact = firstRanked(usable.filter { $0.position == wanted }, systemPreferredId: "") {
                return exact
            }
            if wanted == CameraCandidatePosition.back { return nil }
        }
        let unplaced = usable.filter { $0.position == CameraCandidatePosition.unspecified }
        if let mac = firstRanked(unplaced, systemPreferredId: systemPreferredId) {
            return mac
        }
        return firstRanked(usable, systemPreferredId: systemPreferredId)
    }

    static func canSwitch(_ candidates: [CameraCandidate], systemPreferredId: String = "") -> Bool {
        guard let front = select(candidates, wanted: CameraCandidatePosition.front, systemPreferredId: systemPreferredId),
              let back = select(candidates, wanted: CameraCandidatePosition.back, systemPreferredId: systemPreferredId) else {
            return false
        }
        return front.id != back.id
    }

    static func rank(_ kind: CameraCandidateKind) -> Int {
        switch kind {
        case .builtInWide: return 0
        case .builtIn: return 1
        case .attached: return 2
        case .continuity: return 3
        case .other: return 4
        case .deskView: return 5
        }
    }

    private static func firstRanked(_ candidates: [CameraCandidate], systemPreferredId: String) -> CameraCandidate? {
        if !systemPreferredId.isEmpty, let preferred = candidates.first(where: { $0.id == systemPreferredId }) {
            return preferred
        }
        var best: CameraCandidate? = nil
        for candidate in candidates {
            guard let current = best else {
                best = candidate
                continue
            }
            if rank(candidate.kind) < rank(current.kind) {
                best = candidate
            }
        }
        return best
    }
}

enum CameraFormatSelectionPolicy {

    static func selectIndex(_ formats: [CameraFormatCandidate], targetWidth: Int, targetHeight: Int) -> Int? {
        if formats.isEmpty { return nil }
        let wantsLandscape = targetWidth >= targetHeight
        var matching: [Int] = []
        var index = 0
        while index < formats.count {
            let format = formats[index]
            if (format.width >= format.height) == wantsLandscape {
                matching.append(index)
            }
            index += 1
        }
        var pool = matching
        if pool.isEmpty {
            var all = 0
            while all < formats.count {
                pool.append(all)
                all += 1
            }
        }
        var selected = pool[0]
        var minimumDiff = Int.max
        for candidate in pool {
            let format = formats[candidate]
            let diff = abs(format.width - targetWidth) + abs(format.height - targetHeight)
            if diff < minimumDiff {
                minimumDiff = diff
                selected = candidate
            }
        }
        return selected
    }
}

enum CameraFrameRatePolicy {

    static func select(target: Double, ranges: [CameraFrameRateRange]) -> Double? {
        let valid = ranges.filter { $0.maximum >= 1 }
        if valid.isEmpty { return nil }
        var best = 0.0
        var bestDiff = -1.0
        for range in valid {
            let low = max(1.0, range.minimum)
            let high = max(low, range.maximum)
            let clamped = min(max(target, low), high)
            let diff = abs(clamped - target)
            if bestDiff < 0 || diff < bestDiff || (diff == bestDiff && clamped > best) {
                bestDiff = diff
                best = clamped
            }
        }
        return max(1.0, best)
    }

    static func captureFps(_ selected: Double, ranges: [CameraFrameRateRange]) -> Int {
        let truncated = max(1, Int(selected))
        if supports(Double(truncated), ranges: ranges) { return truncated }
        let raised = truncated + 1
        if supports(Double(raised), ranges: ranges) { return raised }
        return truncated
    }

    static func supports(_ fps: Double, ranges: [CameraFrameRateRange]) -> Bool {
        for range in ranges {
            if fps >= range.minimum && fps <= range.maximum { return true }
        }
        return false
    }
}
