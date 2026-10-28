#if os(iOS) && !SKIP
import SwiftUI

// S50 2 (PPL-1): the iOS person row (F00 C10 with the PL1 deltas), the waiting row, section headers and footers, and
// the row copy. The row reads only its `PersonRowEntry`; the speaking glyph and the "Speaking" value are leaves on the
// S20 `TileSpeakingState`, so a speaker change re-evaluates the leaf, never the row (S50 2 k). The info part is the
// WP1-2b `ConclavePersonRow` (one combined element) with the C07 avatar in its leading slot; the trailing control is
// its own element. PPL-2 passes the row `Menu` through `trailing` and the accessibility actions through `onAction`
// (PeopleActions+iOS.swift); PPL-3 (S50 4, 5) adds the waiting row's Deny and Admit with the Admit swipe and the
// section headers' host actions (Admit All and Deny All, Lower All, Mute All...), with the section-header dialogs.

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
        case .attendee: return ConclaveStrings.text("Attendee")
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
        case .openToAll, nil: return ConclaveStrings.text("Open to all")
        }
    }

    /// The waiting row's value (S50 4 f, 4 i): the reason while its buttons are unavailable, else nothing.
    static func waitingValue(_ model: WaitingRowModel) -> String {
        if !model.pendingAction.isEmpty || model.isEnabled { return "" }
        return reason(model.reason)
    }

    /// A header action's value: "In Progress" while in flight, the reason while recovering or offline.
    static func headerValue(pending: Bool, reason raw: String) -> String {
        if pending { return ConclaveStrings.text("In Progress") }
        return reason(raw)
    }

    /// The unavailable reasons a waiting row or header action can carry (S50 4 f).
    static func reason(_ raw: String) -> String {
        switch raw {
        case PeopleActionReason.reconnecting, PeopleActionReason.notJoined:
            return ConclaveStrings.text("Unavailable while reconnecting")
        case PeopleActionReason.offline: return ConclaveStrings.text("Unavailable while offline")
        case PeopleActionReason.pending: return ConclaveStrings.text("In Progress")
        default: return ""
        }
    }

    /// Sections whose header can carry host actions (S50 1 c).
    static func headerCanHaveActions(_ id: String) -> Bool {
        id == PeopleSectionID.waiting.rawValue || id == PeopleSectionID.raisedHands.rawValue
            || id == PeopleSectionID.inMeeting.rawValue || id == PeopleSectionID.panelists.rawValue
    }

    /// The dialog a header presents (S50 3 j).
    static func headerConfirmationKind(_ id: String) -> PeopleConfirmationKind? {
        if id == PeopleSectionID.waiting.rawValue { return PeopleConfirmationKind.denyAll }
        if id == PeopleSectionID.inMeeting.rawValue || id == PeopleSectionID.panelists.rawValue {
            return PeopleConfirmationKind.muteAll
        }
        return nil
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
    /// PPL-2 (AX4): every available menu item is a named action on the row's one element.
    let onAction: ((PersonActionID) -> Void)?
    let trailing: (PersonRowModel) -> Trailing
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var avatarIndent = ConclaveRowMetrics.avatarDiameter + 12

    init(entry: PersonRowEntry, speaking: TileSpeakingState, sectionId: String, queueCount: Int, probe: PeopleRecomposeLedger?,
         onAction: ((PersonActionID) -> Void)? = nil, @ViewBuilder trailing: @escaping (PersonRowModel) -> Trailing) {
        self.entry = entry
        self.speaking = speaking
        self.sectionId = sectionId
        self.queueCount = queueCount
        self.probe = probe
        self.onAction = onAction
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
        .modifier(PeopleRowAccessibilityActions(model: model, onAction: onAction))
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
        self.init(entry: entry, speaking: speaking, sectionId: sectionId, queueCount: queueCount, probe: probe, onAction: nil) { _ in
            EmptyView()
        }
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

/// One waiting request (S50 PL2, 4 c): avatar and name, then Deny (`.borderless` with the secondary tint, mirroring
/// Android's TextButton) and the tonal Admit (C01 `.bordered` `.tint(.primary)`, never a coral fill), both at least
/// 44 pt tall; at accessibility sizes the buttons move under the name. Swipe: leading Admit (full swipe, gray, 3 c),
/// trailing Deny. While its own action is in flight the two buttons become one spinner with "In Progress";
/// recovering, offline or a bulk admission disables them with the reason as the row's value. Reads only its entry.
struct PeopleWaitingRowView: View {
    let people: PeoplePresenter
    let entry: WaitingRowEntry
    let probe: PeopleRecomposeLedger?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let model = entry.model
        let _ = probe?.record(PeopleSectionID.waiting.rawValue + ":" + model.id)
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) {
                    info(model)
                    buttons(model)
                }
            } else {
                HStack(spacing: 12) {
                    info(model)
                    buttons(model)
                }
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if model.isEnabled {
                Button {
                    perform(PersonActionID.admit, model, source: PeopleActionSource.swipe)
                } label: {
                    Label(ConclaveStrings.text("Admit"), systemImage: ConclaveSymbols.checkmark)
                }
                .tint(.gray)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if model.isEnabled {
                Button(role: .destructive) {
                    perform(PersonActionID.deny, model, source: PeopleActionSource.swipe)
                } label: {
                    Label(ConclaveStrings.text("Deny"), systemImage: ConclaveSymbols.xmark)
                }
            }
        }
    }

    private func info(_ model: WaitingRowModel) -> some View {
        // The name exactly as the server sent it (a raw key stays a raw key, S50 4 f).
        ConclavePersonRow(name: model.name, lineLimit: 2, identifier: "people.row." + model.id) {
            ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(model.avatarSeed), size: .row)
        }
        .accessibilityValue(PeopleText.waitingValue(model))
    }

    @ViewBuilder
    private func buttons(_ model: WaitingRowModel) -> some View {
        if !model.pendingAction.isEmpty {
            ProgressView()
                .frame(minWidth: PeopleRowMetrics.trailingTarget, minHeight: PeopleRowMetrics.trailingTarget)
                .accessibilityLabel(model.name)
                .accessibilityValue(ConclaveStrings.text("In Progress"))
                .accessibilityIdentifier("people.row." + model.id + ".pending")
        } else {
            HStack(spacing: 8) {
                Button {
                    perform(PersonActionID.deny, model, source: PeopleActionSource.rowMenu)
                } label: {
                    Text(ConclaveStrings.text("Deny"))
                        .frame(minHeight: PeopleRowMetrics.trailingTarget)
                }
                .buttonStyle(.borderless)
                .tint(.secondary)
                .accessibilityLabel(ConclaveStrings.format("Deny %@", model.name))
                .accessibilityIdentifier("people.row." + model.id + ".deny")
                Button {
                    perform(PersonActionID.admit, model, source: PeopleActionSource.rowMenu)
                } label: {
                    Text(ConclaveStrings.text("Admit"))
                        .frame(minHeight: PeopleRowMetrics.trailingTarget)
                }
                .buttonStyle(.bordered)
                .tint(.primary)
                .accessibilityLabel(ConclaveStrings.format("Admit %@", model.name))
                .accessibilityIdentifier("people.row." + model.id + ".admit")
            }
            .controlSize(.regular)
            .disabled(!model.isEnabled)
        }
    }

    private func perform(_ action: PersonActionID, _ model: WaitingRowModel, source: String) {
        people.perform(action, rowId: model.id, source: source)
    }
}

/// The section heading (F00 C11, S50 1 c): title and count combined into one header element; for hosts, header actions
/// follow as separate buttons (Admit All and the Deny All overflow on Waiting, Lower All on Raised Hands, Mute All...
/// on the roster). Header actions hide while a search query is active, because they act on everyone, not the matches.
struct PeopleSectionHeader: View {
    let people: PeoplePresenter
    let section: PeopleSection
    let showsActions: Bool

    var body: some View {
        if showsActions && PeopleText.headerCanHaveActions(section.id) {
            PeopleSectionHeaderWithActions(people: people, section: section)
        } else {
            ConclaveSectionHeader(PeopleText.sectionTitle(section.id), count: section.count,
                                  identifier: "people.section." + section.id + ".header")
                .textCase(nil)
        }
    }
}

/// The only reader of `people.headerActions` (and of the section-header dialog, S50 3 j), so a pending Admit All
/// re-evaluates this header and nothing else (S50 4 k).
private struct PeopleSectionHeaderWithActions: View {
    let people: PeoplePresenter
    let section: PeopleSection
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let actions = people.headerActions
        if actions.hasActions(section.id) {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    // The actions sit under the heading at accessibility sizes (S50 1 c, the ViewThatFits fallback).
                    VStack(alignment: .leading, spacing: 4) {
                        PeopleHeaderTitle(section: section)
                        HStack(spacing: 8) {
                            PeopleHeaderButtons(people: people, sectionId: section.id, actions: actions)
                        }
                    }
                } else {
                    HStack(spacing: 8) {
                        PeopleHeaderTitle(section: section)
                        Spacer(minLength: 8)
                        PeopleHeaderButtons(people: people, sectionId: section.id, actions: actions)
                    }
                }
            }
            .textCase(nil)
            .modifier(PeopleHeaderConfirmation(people: people, kind: PeopleText.headerConfirmationKind(section.id)))
        } else {
            ConclaveSectionHeader(PeopleText.sectionTitle(section.id), count: section.count,
                                  identifier: "people.section." + section.id + ".header")
                .textCase(nil)
        }
    }
}

/// "Waiting, 3": the title and count as one header element; the actions stay separate buttons (S50 4 c, 4 i).
private struct PeopleHeaderTitle: View {
    let section: PeopleSection

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(PeopleText.sectionTitle(section.id))
                .fixedSize(horizontal: false, vertical: true)
            Text(section.count, format: .number)
                .monospacedDigit()
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("people.section." + section.id + ".header")
    }
}

/// The header buttons for one section, every target at least 44 x 44 pt (gallery `header.waiting`).
private struct PeopleHeaderButtons: View {
    let people: PeoplePresenter
    let sectionId: String
    let actions: PeopleHeaderActions

    var body: some View {
        if sectionId == PeopleSectionID.waiting.rawValue {
            waitingButtons
        } else if sectionId == PeopleSectionID.raisedHands.rawValue {
            textAction(title: ConclaveStrings.text("Lower All"), pending: actions.lowerAllPending,
                       isEnabled: actions.isLowerAllEnabled, identifier: "people.section.raisedHands.lowerAll") {
                people.lowerAllHands()
            }
        } else {
            textAction(title: ConclaveStrings.text("Mute All…"), pending: actions.muteAllPending,
                       isEnabled: actions.isMuteAllEnabled, identifier: "people.section." + sectionId + ".muteAll") {
                people.requestMuteAll()
            }
        }
    }

    /// Admit All is this screen's one coral fill (F00 C10 e) with the ink label (C01, Q12); the overflow Menu holds
    /// Deny All... (S50 4 c).
    private var waitingButtons: some View {
        HStack(spacing: 4) {
            Button {
                people.admitAll()
            } label: {
                HStack(spacing: 6) {
                    if actions.admitAllPending {
                        ProgressView()
                            .tint(HostingTheme.onCoral)
                            .accessibilityHidden(true)
                    }
                    Text(actions.admitAllPending ? ConclaveStrings.text("Admitting…") : ConclaveStrings.text("Admit All"))
                        .foregroundStyle(HostingTheme.onCoral)
                }
                .frame(minHeight: PeopleRowMetrics.trailingTarget)
            }
            .buttonStyle(.borderedProminent)
            .tint(HostingTheme.coralFill)
            .controlSize(.regular)
            .contentShape(Rectangle())
            .disabled(!actions.isAdmitAllEnabled)
            .accessibilityValue(PeopleText.headerValue(pending: actions.admitAllPending, reason: actions.reason))
            .accessibilityIdentifier("people.section.waiting.admitAll")
            Menu {
                Button(ConclaveStrings.text("Deny All…"), role: .destructive) {
                    people.requestDenyAll()
                }
                .accessibilityIdentifier("people.section.waiting.denyAll")
            } label: {
                Image(systemName: ConclaveSymbols.ellipsis)
                    .frame(width: PeopleRowMetrics.trailingTarget, height: PeopleRowMetrics.trailingTarget)
                    .contentShape(Rectangle())
            }
            .disabled(!actions.isDenyAllEnabled)
            .accessibilityLabel(ConclaveStrings.text("More Waiting Actions"))
            .accessibilityIdentifier("people.section.waiting.more")
        }
    }

    /// Lower All and Mute All...: C01 text style (`.borderless`, `coralText`), a spinner while in flight.
    private func textAction(title: String, pending: Bool, isEnabled: Bool, identifier: String,
                            action: @escaping () -> Void) -> some View {
        Button {
            action()
        } label: {
            Group {
                if pending {
                    ProgressView()
                } else {
                    Text(title)
                        .foregroundStyle(HostingTheme.coralText)
                }
            }
            .frame(minWidth: PeopleRowMetrics.trailingTarget, minHeight: PeopleRowMetrics.trailingTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(!isEnabled)
        .accessibilityLabel(title)
        .accessibilityValue(PeopleText.headerValue(pending: pending, reason: actions.reason))
        .accessibilityIdentifier(identifier)
    }
}

/// The section-header dialogs (S50 3 j): Deny All from the Waiting header, Mute All... from the roster header, each
/// presented by its header and filtered by kind.
private struct PeopleHeaderConfirmation: ViewModifier {
    let people: PeoplePresenter
    let kind: PeopleConfirmationKind?

    func body(content: Content) -> some View {
        let current = people.confirmation
        let shown: PeopleConfirmation? = (kind != nil && current?.source == PeopleActionSource.sectionHeader
                                          && current?.kind == kind) ? current : nil
        content.confirmationDialog(shown.map { PeopleActionText.dialog($0).title } ?? "",
                                   isPresented: Binding(get: { shown != nil }, set: { isShown in
                                       if !isShown, let open = people.confirmation,
                                          open.source == PeopleActionSource.sectionHeader, open.kind == kind {
                                           people.cancelConfirmation(id: open.id)
                                       }
                                   }),
                                   titleVisibility: .visible, presenting: shown) { confirmation in
            PeopleDialogButtons(people: people, confirmation: confirmation)
        } message: { confirmation in
            Text(PeopleActionText.dialog(confirmation).message)
        }
    }
}
#endif
