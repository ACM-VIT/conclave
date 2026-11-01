import Foundation

enum ConclaveComposerMaterial: String, CaseIterable {

    case glass

    case opaque
}

enum ConclaveComposerMaterialPolicy {

    static func material(glassAvailable: Bool, reduceTransparency: Bool, forceOpaque: Bool,
                         prefersReducedResourceUsage: Bool) -> ConclaveComposerMaterial {
        if glassAvailable && !reduceTransparency && !forceOpaque && !prefersReducedResourceUsage { return .glass }
        return .opaque
    }

    static func glassShapeCount(_ material: ConclaveComposerMaterial, hasAttach: Bool) -> Int {
        if material != .glass { return 0 }
        return hasAttach ? 2 : 1
    }
}

enum ConclaveComposerMetrics {

    static let glassCornerRadius = 22.0

    static let opaqueCornerRadius = DesignTokens.radiusBubble

    static let androidCornerRadius = DesignTokens.radiusBubbleAndroid

    static let clusterSpacing = 8.0
    static let attachDiameter = 44.0
    static let fieldHorizontalPadding = 12.0
    static let fieldVerticalPadding = 8.0

    static let fieldTrailingGap = 4.0
    static let minimumFieldHeight = 44.0
    static let maximumLines = 6

    static let stackSpacing = DesignTokens.space8
    static let stackHorizontalPadding = DesignTokens.space16
    static let stackVerticalPadding = DesignTokens.space8

    static let replyBarWidth = 3.0
    static let attachmentThumbnail = 40.0
}

enum ConclaveComposerCounterPolicy {

    static func visibleFrom(limit: Int) -> Int {
        if limit <= 0 { return 0 }
        return (limit * 9 + 9) / 10
    }

    static func isVisible(count: Int, limit: Int, alwaysVisible: Bool) -> Bool {
        if limit <= 0 { return false }
        return alwaysVisible || count >= visibleFrom(limit: limit)
    }

    static func overflow(count: Int, limit: Int) -> Int {
        if limit <= 0 || count <= limit { return 0 }
        return count - limit
    }

    static func band(count: Int, limit: Int, visibleFrom: Int) -> ConclaveCounterBand {
        if count < visibleFrom { return .hidden }
        if overflow(count: count, limit: limit) > 0 { return .over }
        return .near
    }

    static func announces(previous: ConclaveCounterBand, next: ConclaveCounterBand) -> Bool {
        return next != previous && next != .hidden
    }
}

enum ConclaveCounterBand: String, CaseIterable {
    case hidden, near, over
}

enum ConclaveAttachmentPhase: String, CaseIterable {
    case preparing, uploading, ready, failed

    var blocksSend: Bool { self != .ready }

    var showsProgress: Bool { self == .preparing || self == .uploading }

    var offersRetry: Bool { self == .failed }
}

struct ConclaveSearchItem: Equatable, Identifiable {
    let id: String
    let text: String
}

enum ConclaveSearchPolicy {

    static let announcementDelayMillis = 1000

    static func normalized(_ query: String) -> String {
        return query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func isSearching(_ query: String) -> Bool {
        return !normalized(query).isEmpty
    }

    static func terms(_ query: String) -> [String] {
        let words = normalized(query).components(separatedBy: " ")
        return words.filter { !$0.isEmpty }
    }

    static func matches(_ text: String, query: String) -> Bool {
        return matchesTerms(text.lowercased(), terms: terms(query))
    }

    static func filter(_ items: [ConclaveSearchItem], query: String) -> [String] {
        let words = terms(query)
        var ids: [String] = []
        for item in items {
            if matchesTerms(item.text.lowercased(), terms: words) { ids.append(item.id) }
        }
        return ids
    }

    private static func matchesTerms(_ haystack: String, terms: [String]) -> Bool {
        for term in terms {
            if !haystack.contains(term) { return false }
        }
        return true
    }
}

struct ConclaveSegmentModel: Equatable, Identifiable {
    let id: String
    let title: String
    let isEnabled: Bool
}

enum ConclaveSegmentedFallback: String, CaseIterable {

    case rows

    case menu
}

enum ConclaveSegmentedPolicy {
    static let maximumSegments = 4

    static let androidFallbackFontScale = 1.5

    static func iosUsesRows(isAccessibilitySize: Bool, segmentCount: Int) -> Bool {
        return isAccessibilitySize || segmentCount > maximumSegments
    }

    static func androidUsesFallback(fontScale: Double, segmentCount: Int) -> Bool {
        return fontScale >= androidFallbackFontScale || segmentCount > maximumSegments
    }
}

enum ConclaveBubbleTone: String, CaseIterable {

    case own

    case peer

    case privateMessage

    case answer

    var usesCoralFill: Bool { self == .own }
    var hasBorder: Bool { self == .privateMessage }
}

struct ConclaveBubbleCorners: Equatable {
    let topStart: Double
    let topEnd: Double
    let bottomEnd: Double
    let bottomStart: Double
}

enum ConclaveBubbleGeometry {

    static let iosCornerRadius = DesignTokens.radiusBubble
    static let androidCornerRadius = DesignTokens.radiusBubbleAndroid

    static let androidTailRadius = DesignTokens.radiusBubbleTailAndroid

    static let horizontalPadding = DesignTokens.space12
    static let verticalPadding = DesignTokens.space8

    static let maxWidthFraction = 0.8

    static let quoteBarWidth = 3.0
    static let quoteCornerRadius = DesignTokens.radiusSmall

    static let onCoralQuoteBarOpacity = 0.7
    static let onCoralQuoteFillOpacity = 0.12

    static func maxWidth(listWidth: Double) -> Double {
        return listWidth * maxWidthFraction
    }

    static func androidCorners(isOwn: Bool, isFollowUp: Bool, hasFollower: Bool) -> ConclaveBubbleCorners {
        let full = androidCornerRadius
        let top = isFollowUp ? androidTailRadius : full
        let bottom = hasFollower ? androidTailRadius : full
        if isOwn {
            return ConclaveBubbleCorners(topStart: full, topEnd: top, bottomEnd: bottom, bottomStart: full)
        }
        return ConclaveBubbleCorners(topStart: top, topEnd: full, bottomEnd: full, bottomStart: bottom)
    }
}

struct ConclaveReactionChipModel: Equatable, Identifiable {

    let id: String
    let emoji: String
    let count: Int
    let isMine: Bool

    let canToggle: Bool
    let accessibilityLabel: String
}

enum ConclaveReactionChipPolicy {
    static let iosVisualHeight = 28.0
    static let androidVisualHeight = 32.0
    static let iosTarget = 44.0
    static let androidTarget = 48.0
    static let horizontalPadding = 8.0
    static let spacing = DesignTokens.space4

    static func tapAdds(_ chip: ConclaveReactionChipModel) -> Bool {
        return chip.canToggle && !chip.isMine
    }

    static func feedback(_ chip: ConclaveReactionChipModel) -> FeedbackKind {
        return tapAdds(chip) ? .reactionSent : .none
    }
}

enum OneTimeTipID: String, CaseIterable {
    case gifPicker
}

enum OneTimeTipContentState: String, CaseIterable {
    case ready, loading, empty, error
}

enum OneTimeTipPolicy {
    static let storePrefix = "conclave.tip."

    static func storeKey(_ rawID: String) -> String {
        return storePrefix + rawID
    }

    static func isEligible(isDismissed: Bool, isPanelPresented: Bool, isOtherTipShown: Bool,
                           contentState: OneTimeTipContentState) -> Bool {
        return !isDismissed && isPanelPresented && !isOtherTipShown && contentState == .ready
    }
}

enum ConclaveTextEntryKind: String, CaseIterable {

    case name

    case number

    case text

    case multiline
}

struct ConclaveTextEntryDialogModel: Equatable {
    let kind: ConclaveTextEntryKind
    let title: String
    let message: String
    let fieldLabel: String
    let confirmTitle: String
    let limit: Int
    let counterFrom: Int
}

enum ConclaveTextEntryPolicy {
    static let multilineMinLines = 4
    static let multilineMaxLines = 8

    static func capped(_ text: String, limit: Int) -> String {
        if limit > 0 && text.count > limit { return String(text.prefix(limit)) }
        return text
    }

    static func canConfirm(_ text: String, isPending: Bool) -> Bool {
        return !isPending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func showsCounter(count: Int, model: ConclaveTextEntryDialogModel) -> Bool {
        return model.limit > 0 && model.counterFrom > 0 && count >= model.counterFrom
    }
}
