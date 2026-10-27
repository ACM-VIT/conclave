#if os(iOS) && !SKIP
import SwiftUI

// S50 2 (PPL-1): the iOS person row (F00 C10 with the PL1 deltas), the waiting row, section headers and footers, and
// the row copy. The row reads only its `PersonRowEntry`; the speaking glyph and the "Speaking" value are leaves on the
// S20 `TileSpeakingState`, so a speaker change re-evaluates the leaf, never the row (S50 2 k). The info part is the
// WP1-2b `ConclavePersonRow` (one combined element) with the C07 avatar in its leading slot; the trailing control is
// its own element. PPL-2 passes the row `Menu` through `trailing`; PPL-3 replaces the name-only waiting row with Deny
// and Admit.

/// Row and section copy (S50 1 g, 2 g): Apple title case for titles and headers, sentence case for values.
enum PeopleText {
    /// The middle-dot separator of the sub line (S50 2 c, U+00B7).
    static let separator = " \u{00B7} "

    static func displayName(_ model: PersonRowModel) -> String {
        if model.name.isEmpty { return model.isSelf ? ConclaveStrings.text("You") : "" }
        return model.name
    }

    /// The role word (the F00 C06 tag string, R50-5). Attendees are never roster rows (PH12); the attendee hand-queue
    /// rows and their F00 C10 "Attendee" detail arrive with PPL-5.
    static func roleWord(_ role: PersonRole) -> String? {
        switch role {
        case .host: return ConclaveStrings.text("Host")
        case .coHost: return ConclaveStrings.text("Co-Host")
        case .participant, .attendee: return nil
        }
    }

    static func detailWord(_ detail: PersonDetail) -> String? {
        switch detail {
        case .none: return nil
        case .presenting: return ConclaveStrings.text("Presenting")
        case .reconnecting: return ConclaveStrings.text("Reconnecting")
        case .stageInvited: return ConclaveStrings.text("Invited on stage")
        case .attendee: return nil
        }
    }

    /// "You · Host", "Co-Host · Presenting"; an unnamed you shows "You" as the name, never "You · You" (S50 2 f).
    static func subLine(_ model: PersonRowModel) -> String? {
        var parts: [String] = []
        if model.isSelf && !model.name.isEmpty { parts.append(ConclaveStrings.text("You")) }
        if let role = roleWord(model.role) { parts.append(role) }
        if let detail = detailWord(model.detail) { parts.append(detail) }
        if model.messagesHidden { parts.append(ConclaveStrings.text("Messages hidden")) }
        return parts.isEmpty ? nil : parts.joined(separator: separator)
    }

    /// One element per row: the name with the role folded in ("Avery Lee, Co-Host", S50 2 i).
    static func label(_ model: PersonRowModel) -> String {
        var parts = [displayName(model)]
        if model.isSelf && !model.name.isEmpty { parts.append(ConclaveStrings.text("You")) }
        if let role = roleWord(model.role) { parts.append(role) }
        return parts.joined(separator: ", ")
    }

    /// The value in fixed order after "Speaking" (S50 2 i): Hand Raised, the queue position in Raised Hands,
    /// Presenting, Camera Off, Muted, Reconnecting; only present states.
    static func valueParts(_ model: PersonRowModel, queueCount: Int, showsQueue: Bool) -> [String] {
        var parts: [String] = []
        if model.isHandRaised {
            parts.append(ConclaveStrings.text("Hand Raised"))
            if showsQueue && model.handOrder > 0 {
                parts.append(ConclaveStrings.format("%lld of %lld in queue", model.handOrder, queueCount))
            }
        }
        if model.isPresenting { parts.append(ConclaveStrings.text("Presenting")) }
        if model.isCameraOff { parts.append(ConclaveStrings.text("Camera Off")) }
        if model.isMuted { parts.append(ConclaveStrings.text("Muted")) }
        if model.isReconnecting { parts.append(ConclaveStrings.text("Reconnecting")) }
        return parts
    }

    static func sectionTitle(_ id: String) -> String {
        switch PeopleSectionID(rawValue: id) {
        case .waiting: return ConclaveStrings.text("Waiting")
        case .raisedHands: return ConclaveStrings.text("Raised Hands")
        case .inMeeting: return ConclaveStrings.text("In This Meeting")
        case .panelists: return ConclaveStrings.text("Panelists")
        case .attendees: return ConclaveStrings.text("Attendees")
        case nil: return ""
        }
    }

    static func accessSummary(_ raw: String) -> String {
        switch PeopleAccessSummary(rawValue: raw) {
        case .locked: return ConclaveStrings.text("Locked")
        case .signedInOnly: return ConclaveStrings.text("Signed-in only")
        case .open, nil: return ConclaveStrings.text("Open to all")
        }
    }

    static func footer(_ kind: PeopleFooterKind) -> String? {
        switch kind {
        case .none: return nil
        case .alone: return ConclaveStrings.text("You\u{2019}re the only one here.")
        case .recovering: return ConclaveStrings.text("Host actions are unavailable while reconnecting.")
        case .offline: return ConclaveStrings.text("You\u{2019}re offline. Host actions return when you reconnect.")
        }
    }
}

enum PeopleRowMetrics {
    /// Status glyph spacing (S50 2 c).
    static let glyphSpacing: CGFloat = 6
    /// The trailing control target (44 pt, S50 2 i).
    static let trailingTarget: CGFloat = 44
}

/// One person (S50 2 c). `trailing` is the row's own element after the info (PPL-2's `Menu`); while an action is
/// pending a system spinner replaces it.
struct PeopleRowView<Trailing: View>: View {
    let entry: PersonRowEntry
    let speaking: TileSpeakingState
    /// `PeopleSectionID` raw value: Raised Hands shows the queue number before the hand.
    let sectionId: String
    /// The Raised Hands count, for "1 of 3 in queue".
    let queueCount: Int
    let probe: PeopleRecomposeLedger?
    let trailing: (PersonRowModel) -> Trailing
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var avatarIndent = ConclaveRowMetrics.avatarDiameter + 12

    init(entry: PersonRowEntry, speaking: TileSpeakingState, sectionId: String, queueCount: Int, probe: PeopleRecomposeLedger?,
         @ViewBuilder trailing: @escaping (PersonRowModel) -> Trailing) {
        self.entry = entry
        self.speaking = speaking
        self.sectionId = sectionId
        self.queueCount = queueCount
        self.probe = probe
        self.trailing = trailing
    }

    var body: some View {
        let model = entry.model
        // people.recompose.<section>:<rowId> (PL12): the fixture ledger counts row evaluations; production passes none.
        let _ = probe?.record(sectionId + ":" + model.id)
        let showsQueue = sectionId == PeopleSectionID.raisedHands.rawValue
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                // The glyph cluster moves under the name and is never truncated (S50 2 c).
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 12) {
                        info(model, showsQueue: showsQueue)
                        trailingSlot(model)
                    }
                    PeopleStatusGlyphs(model: model, speaking: speaking, showsQueue: showsQueue)
                        .padding(.leading, avatarIndent)
                }
            } else {
                HStack(spacing: 12) {
                    info(model, showsQueue: showsQueue)
                    PeopleStatusGlyphs(model: model, speaking: speaking, showsQueue: showsQueue)
                    trailingSlot(model)
                }
            }
        }
    }

    private func info(_ model: PersonRowModel, showsQueue: Bool) -> some View {
        ConclavePersonRow(name: PeopleText.displayName(model), detail: PeopleText.subLine(model), lineLimit: 2,
                          identifier: "people.row." + sectionId + "." + model.id) {
            ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(model.avatarSeed), size: .row)
        }
        .accessibilityLabel(PeopleText.label(model))
        .modifier(PeopleRowValue(parts: PeopleText.valueParts(model, queueCount: queueCount, showsQueue: showsQueue),
                                 speaking: speaking))
    }

    @ViewBuilder
    private func trailingSlot(_ model: PersonRowModel) -> some View {
        if !model.pendingAction.isEmpty {
            ProgressView()
                .frame(width: PeopleRowMetrics.trailingTarget, height: PeopleRowMetrics.trailingTarget)
                .accessibilityLabel(PeopleText.displayName(model))
                .accessibilityValue(ConclaveStrings.text("In Progress"))
                .accessibilityIdentifier("people.row." + sectionId + "." + model.id + ".pending")
        } else {
            trailing(model)
        }
    }
}

extension PeopleRowView where Trailing == EmptyView {
    /// A row with no trailing control (PPL-1: rows carry no actions until PPL-2's policy).
    init(entry: PersonRowEntry, speaking: TileSpeakingState, sectionId: String, queueCount: Int, probe: PeopleRecomposeLedger?) {
        self.init(entry: entry, speaking: speaking, sectionId: sectionId, queueCount: queueCount, probe: probe) { _ in EmptyView() }
    }
}

/// The value modifier alone reads the speaking state, so "Speaking" joins the value without re-evaluating the row
/// (the F00 C08 tile pattern).
private struct PeopleRowValue: ViewModifier {
    let parts: [String]
    let speaking: TileSpeakingState

    func body(content: Content) -> some View {
        var all: [String] = []
        if speaking.isSpeaking { all.append(ConclaveStrings.text("Speaking")) }
        all.append(contentsOf: parts)
        return content.accessibilityValue(all.joined(separator: ", "))
    }
}

/// Status glyphs, only for notable states, in the S50 2 c order: speaking (leaf), raised hand in the warning color
/// with the queue number before it in Raised Hands, presenting, camera off, muted, reconnecting. Decorative: the value
/// carries the states.
private struct PeopleStatusGlyphs: View {
    let model: PersonRowModel
    let speaking: TileSpeakingState
    let showsQueue: Bool

    var body: some View {
        HStack(spacing: PeopleRowMetrics.glyphSpacing) {
            PeopleSpeakingGlyph(speaking: speaking)
            if model.isHandRaised {
                HStack(spacing: 2) {
                    if showsQueue && model.handOrder > 0 {
                        Text(model.handOrder, format: .number)
                            .font(.subheadline)
                            .monospacedDigit()
                    }
                    Image(systemName: ConclaveSymbols.handRaisedFill)
                }
                .foregroundStyle(HostingTheme.statusWarning)
            }
            if model.isPresenting { glyph(ConclaveSymbols.rectangleOnRectangle) }
            if model.isCameraOff { glyph(ConclaveSymbols.videoSlashFill) }
            if model.isMuted { glyph(ConclaveSymbols.micSlashFill) }
            if model.isReconnecting { glyph(ConclaveSymbols.wifiExclamationmark) }
        }
        .imageScale(.small)
        .accessibilityHidden(true)
    }

    private func glyph(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .foregroundStyle(HostingTheme.secondaryText)
    }
}

/// The only hot read of a row (S50 2 k): a static glyph that appears and disappears, no animation (S50 2 h).
private struct PeopleSpeakingGlyph: View {
    let speaking: TileSpeakingState

    var body: some View {
        if speaking.isSpeaking {
            Image(systemName: ConclaveSymbols.waveform)
                .foregroundStyle(HostingTheme.secondaryText)
        }
    }
}

/// PPL-1 waiting row: the name and avatar under Waiting. PPL-3 adds Deny (borderless, secondary tint) and the tonal
/// Admit with the leading Admit swipe (S50 PL2, 4 c).
struct PeopleWaitingRowView: View {
    let entry: WaitingRowEntry
    let probe: PeopleRecomposeLedger?

    var body: some View {
        let model = entry.model
        let _ = probe?.record(PeopleSectionID.waiting.rawValue + ":" + model.id)
        ConclavePersonRow(name: model.name, lineLimit: 2, identifier: "people.row." + model.id) {
            ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(model.avatarSeed), size: .row)
        }
    }
}

/// The section heading: title and count combined into one header element (F00 C11, S50 1 c). Header actions (Admit
/// All, Lower All, Mute All) join with PPL-3 and PPL-4 as separate buttons after it.
struct PeopleSectionHeader: View {
    let section: PeopleSection

    var body: some View {
        ConclaveSectionHeader(PeopleText.sectionTitle(section.id), count: section.count,
                              identifier: "people.section." + section.id + ".header")
            .textCase(nil)
    }
}
#endif
