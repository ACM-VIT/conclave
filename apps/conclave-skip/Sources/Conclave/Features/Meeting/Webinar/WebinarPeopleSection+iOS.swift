#if os(iOS) && !SKIP
import SwiftUI

// S50 10 (PPL-5): the webinar host branch of the iOS Participants list. `PeopleSnapshot.sections` carries Raised Hands
// (the attendee queue, `attendee:` keys), Panelists (the roster rows) and Attendees (invited rows); this file draws the
// attendee rows with their inline Bring on Stage (C01 tonal, `.bordered` `.tint(.primary)`, never a coral fill, D4) or
// Cancel Invite (`.borderless`), the leading swipe Bring on Stage (`.tint(.gray)`, no full swipe), the watching count
// row and the section header and footer that read `people.attendeeCount` in their own leaves, so 50 attendee count
// changes publish no People revision (10 k, l).

/// One attendee row (hand queue or invited). Reads only its `PersonRowEntry`.
struct WebinarAttendeeRowView: View {
    let people: PeoplePresenter
    let key: String
    let sectionId: String
    /// The Raised Hands count, for "1 of 2 in queue".
    let queueCount: Int

    var body: some View {
        let entry = people.rows.entry(for: key)
        let model = entry.model
        let _ = people.recompose?.record(sectionId + ":" + model.id)
        let action = model.actions.first
        HStack(spacing: 12) {
            ConclavePersonRow(name: PeopleText.displayName(model), detail: PeopleText.subLine(model), lineLimit: 2,
                              identifier: "people.row." + sectionId + "." + model.id) {
                ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(model.avatarSeed), size: .row)
            }
            .accessibilityLabel(WebinarPeopleText.label(model))
            .accessibilityValue(WebinarPeopleText.value(model, queueCount: queueCount))
            .accessibilityActions {
                if let action, action.isEnabled {
                    Button(WebinarPeopleText.actionLabel(action.action, name: PeopleText.displayName(model))) {
                        people.perform(action.action, rowId: key, source: PeopleActionSource.a11y)
                    }
                }
            }
            if model.isHandRaised && model.handOrder > 0 {
                HStack(spacing: 2) {
                    Text(model.handOrder, format: .number)
                        .font(.subheadline)
                        .monospacedDigit()
                    Image(systemName: ConclaveSymbols.handRaisedFill)
                        .imageScale(.small)
                }
                .foregroundStyle(HostingTheme.statusWarning)
                .accessibilityHidden(true)
            }
            if let action {
                WebinarAttendeeButton(people: people, key: key, model: model, action: action)
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if let action, action.action == PersonActionID.bringOnStage, action.isEnabled {
                Button(ConclaveStrings.text("Bring on Stage")) {
                    people.perform(PersonActionID.bringOnStage, rowId: key, source: PeopleActionSource.swipe)
                }
                .tint(.gray)
            }
        }
    }
}

/// Bring on Stage (tonal) or Cancel Invite (borderless) with the "Inviting..." pending state within one frame (10 l).
private struct WebinarAttendeeButton: View {
    let people: PeoplePresenter
    let key: String
    let model: PersonRowModel
    let action: PersonActionModel

    var body: some View {
        let pending = !model.pendingAction.isEmpty
        let name = PeopleText.displayName(model)
        if action.action == PersonActionID.bringOnStage {
            Button {
                people.perform(PersonActionID.bringOnStage, rowId: key, source: PeopleActionSource.rowMenu)
            } label: {
                HStack(spacing: 6) {
                    if pending { ProgressView().accessibilityHidden(true) }
                    Text(pending ? ConclaveStrings.text("Inviting\u{2026}") : ConclaveStrings.text("Bring on Stage"))
                }
            }
            .buttonStyle(.bordered)
            .tint(.primary)
            .disabled(!action.isEnabled)
            .frame(minHeight: PeopleRowMetrics.trailingTarget)
            .accessibilityLabel(ConclaveStrings.format("Bring %@ on Stage", name))
            .accessibilityIdentifier("people.row." + model.id + ".bringOnStage")
        } else {
            Button {
                people.perform(PersonActionID.cancelStageInvite, rowId: key, source: PeopleActionSource.rowMenu)
            } label: {
                HStack(spacing: 6) {
                    if pending { ProgressView().accessibilityHidden(true) }
                    Text(ConclaveStrings.text("Cancel Invite"))
                }
            }
            .buttonStyle(.borderless)
            .disabled(!action.isEnabled)
            .frame(minHeight: PeopleRowMetrics.trailingTarget)
            .accessibilityLabel(ConclaveStrings.format("Cancel Invite for %@", name))
            .accessibilityIdentifier("people.row." + model.id + ".cancelInvite")
        }
    }
}

/// "%lld watching" (10 c): reads `people.attendeeCount` only.
struct WebinarWatchingRow: View {
    let people: PeoplePresenter

    var body: some View {
        LabeledContent {
            EmptyView()
        } label: {
            Text(ConclaveStrings.format("%lld watching", people.attendeeCount))
                .monospacedDigit()
        }
        .accessibilityIdentifier("people.attendees.watching")
    }
}

/// The Attendees header with the watching count in its own leaf (10 b), one header element (F00 C11).
struct WebinarAttendeesHeader: View {
    let people: PeoplePresenter

    var body: some View {
        ConclaveSectionHeader(PeopleText.sectionTitle(PeopleSectionID.attendees.rawValue), count: people.attendeeCount,
                              identifier: "people.section.attendees.header")
            .textCase(nil)
    }
}

/// The Attendees footer (10 f): nobody watching shows the empty copy with a Share Webinar Link row; otherwise the quiet
/// footer; a host promoted mid-webinar sees "Earlier raised hands appear when the queue next updates." Reads
/// `people.attendeeCount` in this leaf only.
struct WebinarAttendeesFooter: View {
    let people: PeoplePresenter
    let snapshot: PeopleSnapshot

    var body: some View {
        let queue = snapshot.section(PeopleSectionID.raisedHands)?.count ?? 0
        let invited = snapshot.section(PeopleSectionID.attendees)?.count ?? 0
        let kind = WebinarPeoplePolicy.footer(attendeeCount: people.attendeeCount, queueCount: queue, invitedCount: invited,
                                              queueKnown: snapshot.webinarQueueKnown)
        VStack(alignment: .leading, spacing: 8) {
            if let text = WebinarPeopleText.footer(kind) {
                ConclaveSectionFooter(text, identifier: "people.section.attendees.footer")
            }
            if kind == WebinarFooterKind.empty {
                WebinarShareLinkButton(people: people, link: snapshot.webinarLink)
            }
        }
    }
}

/// Share Webinar Link from the empty Attendees state: the system share sheet once a link exists, else it generates
/// one through the one owner (R34).
private struct WebinarShareLinkButton: View {
    let people: PeoplePresenter
    let link: String

    var body: some View {
        if let url = URL(string: link), !link.isEmpty {
            ShareLink(item: url) {
                Label(ConclaveStrings.text("Share Webinar Link"), systemImage: ConclaveSymbols.squareAndArrowUp)
            }
            .accessibilityIdentifier("people.attendees.share")
        } else {
            Button {
                Task { _ = await people.host.ensureWebinarLink() }
            } label: {
                Label(ConclaveStrings.text("Share Webinar Link"), systemImage: ConclaveSymbols.squareAndArrowUp)
            }
            .accessibilityIdentifier("people.attendees.share.generate")
        }
    }
}

/// S50 10 g, i copy for the attendee rows (iOS title case; sentence case for footers and values).
enum WebinarPeopleText {
    /// "Priya N., Attendee" (10 i).
    static func label(_ model: PersonRowModel) -> String {
        PeopleText.displayName(model) + ", " + ConclaveStrings.text("Attendee")
    }

    /// "Hand Raised, 1 of 2 in queue" or "Invited on stage".
    static func value(_ model: PersonRowModel, queueCount: Int) -> String {
        if model.detail == PersonDetail.stageInvited { return ConclaveStrings.text("Invited on stage") }
        var parts: [String] = []
        if model.isHandRaised {
            parts.append(ConclaveStrings.text("Hand Raised"))
            if model.handOrder > 0 && queueCount > 0 {
                parts.append(ConclaveStrings.format("%lld of %lld in queue", model.handOrder, queueCount))
            }
        }
        if !model.pendingAction.isEmpty { parts.append(ConclaveStrings.text("In Progress")) }
        return parts.joined(separator: ", ")
    }

    static func actionLabel(_ action: PersonActionID, name: String) -> String {
        action == PersonActionID.bringOnStage ? ConclaveStrings.format("Bring %@ on Stage", name)
            : ConclaveStrings.format("Cancel Invite for %@", name)
    }

    static func footer(_ kind: WebinarFooterKind) -> String? {
        switch kind {
        case .none: return nil
        case .empty: return ConclaveStrings.text("No one is watching yet. Share the webinar link to invite viewers.")
        case .quiet: return ConclaveStrings.text("Attendees watch quietly. Raised hands show up here.")
        case .queuePending: return ConclaveStrings.text("Earlier raised hands appear when the queue next updates.")
        }
    }
}
#endif
