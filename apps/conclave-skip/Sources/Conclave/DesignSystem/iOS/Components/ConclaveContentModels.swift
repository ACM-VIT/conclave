import Foundation

// Shared (transpiled) value types and pure policies behind the FND-3 content components (F00 C19 to C21, C23 to
// C25; S40 0.7 CL1 to CL3, R40-6; S50 0.7 PL10; S60 0.7 R6-8; RECONCILE R32, R35, R39, owner OQ2). Like
// ConclaveComponentModels.swift this file has no platform guard: the iOS components (`+iOS.swift`) and the
// handwritten Compose components (`K/ui/components/`) take the same inputs, and the host tests check the policies.
// Screens own their copy and data; these types carry only what the components draw.
//
// Skip Lite rules: String raw-value enums, scalar structs and arrays of structs, no associated values, no tuples.

// MARK: Composer (F00 C19; S40 6, CL3, R40-6, R40-10; RECONCILE R32; owner OQ2)

/// The material of the one composer component (Chat, Transcript Ask, Q&A).
enum ConclaveComposerMaterial: String, CaseIterable {
    /// iOS 26 and later: the attach circle and the field container in one glass container.
    case glass
    /// The R32 opaque bordered field: Reduce Transparency, iOS 17 to 25, the Debug force flag, iOS 27 reduced
    /// resource usage, and every Android composer.
    case opaque
}

enum ConclaveComposerMaterialPolicy {
    /// F00 4 branch condition plus the iOS 27 resource rule: glass only when the OS offers it, Reduce Transparency
    /// is off, no Debug force is set and the system does not prefer reduced resource usage.
    static func material(glassAvailable: Bool, reduceTransparency: Bool, forceOpaque: Bool,
                         prefersReducedResourceUsage: Bool) -> ConclaveComposerMaterial {
        if glassAvailable && !reduceTransparency && !forceOpaque && !prefersReducedResourceUsage { return .glass }
        return .opaque
    }

    /// Glass shapes in one cluster (F00 C19 l): the field container always, the attach circle when the composer
    /// has one (Chat). Transcript Ask and Q&A have no attach control, so their cluster holds one shape.
    static func glassShapeCount(_ material: ConclaveComposerMaterial, hasAttach: Bool) -> Int {
        if material != .glass { return 0 }
        return hasAttach ? 2 : 1
    }
}

/// Composer geometry in points (iOS) or dp (Android).
enum ConclaveComposerMetrics {
    /// The glass field container keeps this continuous radius at every height up to six lines (a capsule radius
    /// would clip multi-line text).
    static let glassCornerRadius = 22.0
    /// The R32 opaque field (iOS radiusBubble).
    static let opaqueCornerRadius = DesignTokens.radiusBubble
    /// The Android TextField container (radiusBubbleAndroid).
    static let androidCornerRadius = DesignTokens.radiusBubbleAndroid
    /// The spacing of the composer's one glass container and the gap between the attach control and the field.
    static let clusterSpacing = 8.0
    static let attachDiameter = 44.0
    static let fieldHorizontalPadding = 12.0
    static let fieldVerticalPadding = 8.0
    /// The gap between the text and the Send target inside the field container (T3 borrow P5). The 12 by 8 padding
    /// wraps the text only, so one line is one 44 pt row, the 44 pt Send target fills the row at the trailing edge and
    /// the Send glyph sits concentric with the container's 22 pt trailing corner.
    static let fieldTrailingGap = 4.0
    static let minimumFieldHeight = 44.0
    static let maximumLines = 6
    /// The composer column: accessory rows, the field row, then the counter.
    static let stackSpacing = DesignTokens.space8
    static let stackHorizontalPadding = DesignTokens.space16
    static let stackVerticalPadding = DesignTokens.space8
    /// The reply bar's leading rule (S40 6 e).
    static let replyBarWidth = 3.0
    static let attachmentThumbnail = 40.0
}

/// S40 6 f and F00 C19 f: the counter shows from 90% of the limit (900 of 1,000; 450 of 500) and always in voice
/// mode. Counts are the caller's (chat counts UTF-16 units through ChatComposerPolicy, CH20).
enum ConclaveComposerCounterPolicy {
    /// 90% of the limit, rounded up.
    static func visibleFrom(limit: Int) -> Int {
        if limit <= 0 { return 0 }
        return (limit * 9 + 9) / 10
    }

    static func isVisible(count: Int, limit: Int, alwaysVisible: Bool) -> Bool {
        if limit <= 0 { return false }
        return alwaysVisible || count >= visibleFrom(limit: limit)
    }

    /// Characters over the limit; 0 at or under it.
    static func overflow(count: Int, limit: Int) -> Int {
        if limit <= 0 || count <= limit { return 0 }
        return count - limit
    }

    /// The counter band (S40 6 i; T3 borrow P9): hidden below `visibleFrom` (exactly where the counter is not drawn),
    /// over when `overflow` is above 0, near otherwise. With limit 1,000 and visibleFrom 900: 899 is hidden, 900 and
    /// 1,000 are near, 1,001 is over.
    static func band(count: Int, limit: Int, visibleFrom: Int) -> ConclaveCounterBand {
        if count < visibleFrom { return .hidden }
        if overflow(count: count, limit: limit) > 0 { return .over }
        return .near
    }

    /// An opted-in counter speaks once when it enters a visible band: hidden to near, hidden to over, and every
    /// crossing between near and over. Leaving for hidden and staying inside a band say nothing.
    static func announces(previous: ConclaveCounterBand, next: ConclaveCounterBand) -> Bool {
        return next != previous && next != .hidden
    }
}

/// Where a counter stands against its limit (T3 borrow P9). Only the band, never the count, decides when an opted-in
/// counter is announced, so typing inside a band never speaks.
enum ConclaveCounterBand: String, CaseIterable {
    case hidden, near, over
}

/// The attachment chip phases (S40 6 f; CH6 prepare and upload). The presenter maps its attachment state here.
enum ConclaveAttachmentPhase: String, CaseIterable {
    case preparing, uploading, ready, failed

    /// Send stays disabled until the photo is ready.
    var blocksSend: Bool { self != .ready }
    /// The system linear indicator shows while preparing or uploading.
    var showsProgress: Bool { self == .preparing || self == .uploading }
    /// A failed photo offers Try Again.
    var offersRetry: Bool { self == .failed }
}

// MARK: Search (F00 C20)

/// One searchable row of an immutable snapshot: its id and the text the query matches against.
struct ConclaveSearchItem: Equatable, Identifiable {
    let id: String
    let text: String
}

/// Filtering runs on the cached row snapshot, never per keystroke over the network (F00 C20 j, k).
enum ConclaveSearchPolicy {
    /// The result count is announced politely once typing pauses for this long (F00 C20 i).
    static let announcementDelayMillis = 1000

    static func normalized(_ query: String) -> String {
        return query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func isSearching(_ query: String) -> Bool {
        return !normalized(query).isEmpty
    }

    /// The query's words, lowercased; every word must appear in a match.
    static func terms(_ query: String) -> [String] {
        let words = normalized(query).components(separatedBy: " ")
        return words.filter { !$0.isEmpty }
    }

    static func matches(_ text: String, query: String) -> Bool {
        return matchesTerms(text.lowercased(), terms: terms(query))
    }

    /// The ids of the matching items in snapshot order; an empty query keeps every item.
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

// MARK: Segmented control (F00 C21; S60 R6-8)

/// One segment: two to four mutually exclusive options that change a view in place.
struct ConclaveSegmentModel: Equatable, Identifiable {
    let id: String
    let title: String
    let isEnabled: Bool
}

/// What a segmented control becomes when its labels cannot fit.
enum ConclaveSegmentedFallback: String, CaseIterable {
    /// C09 selectable rows (F00 C21 c, d): panels and pages with room below.
    case rows
    /// A menu picker in the same row (S60 R6-8): setup and settings rows, so a page's Start never drops below the
    /// fold. iOS `ViewThatFits(in: .horizontal) { segmented; Picker(.menu) }`; Android a dropdown.
    case menu
}

enum ConclaveSegmentedPolicy {
    static let maximumSegments = 4
    /// Android falls back at font scale 1.5 and up (F00 C21 d).
    static let androidFallbackFontScale = 1.5

    /// iOS: at accessibility sizes the rows fallback replaces the segments (F00 C21 c).
    static func iosUsesRows(isAccessibilitySize: Bool, segmentCount: Int) -> Bool {
        return isAccessibilitySize || segmentCount > maximumSegments
    }

    static func androidUsesFallback(fontScale: Double, segmentCount: Int) -> Bool {
        return fontScale >= androidFallbackFontScale || segmentCount > maximumSegments
    }
}

// MARK: Chat bubble (F00 C23 = S40 CL1; F00 2.6 A10; S60 6 e)

/// The fill and ink of one bubble.
enum ConclaveBubbleTone: String, CaseIterable {
    /// Own public message: the coral content fill with onCoral ink (the second coral use, F00 2.6 A10).
    case own
    /// A peer's public message: the neutral fill.
    case peer
    /// Every private message, sent or received: the neutral fill plus a 1 pt / 1 dp border, so privacy never rests
    /// on hue (S40 Q9).
    case privateMessage
    /// A Conclave AI answer in Transcript Ask (S60 6 e): neutral on iOS, secondaryContainer on Android.
    case answer

    var usesCoralFill: Bool { self == .own }
    var hasBorder: Bool { self == .privateMessage }
}

/// Android corner radii in layout-direction terms (start and end follow the reading direction).
struct ConclaveBubbleCorners: Equatable {
    let topStart: Double
    let topEnd: Double
    let bottomEnd: Double
    let bottomStart: Double
}

enum ConclaveBubbleGeometry {
    /// iOS: one continuous rounded rectangle for every bubble, no tails (grouping shows through spacing).
    static let iosCornerRadius = DesignTokens.radiusBubble
    static let androidCornerRadius = DesignTokens.radiusBubbleAndroid
    /// Android: the sender-side corner between grouped bubbles (Google Messages grouping).
    static let androidTailRadius = DesignTokens.radiusBubbleTailAndroid
    /// Text rows pad 12 by 8; media rows have no padding.
    static let horizontalPadding = DesignTokens.space12
    static let verticalPadding = DesignTokens.space8
    /// Bubbles never exceed 80% of the timeline width.
    static let maxWidthFraction = 0.8
    /// The reply quote inside the bubble top (S40 3 c).
    static let quoteBarWidth = 3.0
    static let quoteCornerRadius = DesignTokens.radiusSmall
    /// On a coral bubble the quote bar is ink at 70% and the quote inset ink at 12%.
    static let onCoralQuoteBarOpacity = 0.7
    static let onCoralQuoteFillOpacity = 0.12

    static func maxWidth(listWidth: Double) -> Double {
        return listWidth * maxWidthFraction
    }

    /// The sender side is the end for your own messages and the start for everyone else's. Between grouped bubbles
    /// that side's top corner tightens for a follow-up and its bottom corner when another bubble follows.
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

// MARK: Reaction chip (F00 C24 = S40 CL2)

/// One message reaction chip. The presenter builds the spoken label ("You and Avery reacted with thumbs up").
struct ConclaveReactionChipModel: Equatable, Identifiable {
    /// The emoji wire value.
    let id: String
    let emoji: String
    let count: Int
    let isMine: Bool
    /// False draws plain text (private, local or unacknowledged rows, and rooms with reactions off for guests).
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

    /// A tap adds a reaction only on a chip that is not yours yet.
    static func tapAdds(_ chip: ConclaveReactionChipModel) -> Bool {
        return chip.canToggle && !chip.isMine
    }

    /// S40 3 h: `reactionSent` plays only when the toggle adds a reaction.
    static func feedback(_ chip: ConclaveReactionChipModel) -> FeedbackKind {
        return tapAdds(chip) ? .reactionSent : .none
    }
}

// MARK: One-time tip (F00 C25; RECONCILE R39)

/// Tip identifiers. The only v1 tip is the GIF picker tip (S40 7 c); stage and bar anchors stay deferred.
enum OneTimeTipID: String, CaseIterable {
    case gifPicker
}

/// What the hosting panel shows right now; a tip hides unless the content is ready.
enum OneTimeTipContentState: String, CaseIterable {
    case ready, loading, empty, error
}

enum OneTimeTipPolicy {
    static let storePrefix = "conclave.tip."

    /// The persisted dismissal key: the TipKit tip id on iOS and the Android preference key.
    static func storeKey(_ rawID: String) -> String {
        return storePrefix + rawID
    }

    /// F00 C25 f: not dismissed, its panel presented, no other tip in this presentation, content ready.
    static func isEligible(isDismissed: Bool, isPanelPresented: Bool, isOtherTipShown: Bool,
                           contentState: OneTimeTipContentState) -> Bool {
        return !isDismissed && isPanelPresented && !isOtherTipShown && contentState == .ready
    }
}

// MARK: Short text-entry dialog (S50 0.7 PL10, an F00 C18 variant)

/// What the dialog's one field holds.
enum ConclaveTextEntryKind: String, CaseIterable {
    /// Change Name: words capitalized, name content type.
    case name
    /// Max attendees: the number keyboard.
    case number
    /// Short free text.
    case text
    /// Android only: Answer in Writing (4 to 8 lines). iOS alerts host single-line fields, so iOS screens use a
    /// pushed page for multi-line entry (S50 PL15).
    case multiline
}

/// One short text-entry dialog. `message` is the rules or helper line shown when there is no refusal and no
/// counter; `limit` 0 means uncapped; `counterFrom` 0 hides the counter.
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

    /// Input stops at the cap (the SFU cap for names, S50 PL10).
    static func capped(_ text: String, limit: Int) -> String {
        if limit > 0 && text.count > limit { return String(text.prefix(limit)) }
        return text
    }

    /// Confirm needs non-blank text and no pending request.
    static func canConfirm(_ text: String, isPending: Bool) -> Bool {
        return !isPending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func showsCounter(count: Int, model: ConclaveTextEntryDialogModel) -> Bool {
        return model.limit > 0 && model.counterFrom > 0 && count >= model.counterFrom
    }
}
