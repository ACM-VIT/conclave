#if os(iOS) && !SKIP
import SwiftUI

enum HostText {
    static func policyTitle(_ id: HostPolicyID?) -> String {
        guard let id else { return ConclaveStrings.text("Host Controls") }
        switch id {
        case .lockMeeting: return ConclaveStrings.text("Lock Meeting")
        case .allowGuests: return ConclaveStrings.text("Allow Guests")
        case .allowUnmute: return ConclaveStrings.text("Allow Participants to Unmute")
        case .allowVideo: return ConclaveStrings.text("Allow Participants to Turn On Video")
        case .allowChat: return ConclaveStrings.text("Allow Chat")
        case .directMessages: return ConclaveStrings.text("Private Messages")
        case .photos: return ConclaveStrings.text("Photos in Chat")
        case .readAloud: return ConclaveStrings.text("Voice Messages")
        case .reactions: return ConclaveStrings.text("Reactions")
        case .webinarMode: return ConclaveStrings.text("Webinar Mode")
        case .webinarPublic: return ConclaveStrings.text("Public Access")
        case .webinarLocked: return ConclaveStrings.text("Lock Attendees")
        case .webinarQa: return ConclaveStrings.text("Attendee Q&A")
        }
    }

    static func bulkTitle(_ row: HostBulkRow) -> String {
        if row.isPending {
            switch row.bulk {
            case .muteAll: return ConclaveStrings.text("Muting Everyone\u{2026}")
            case .camerasOff: return ConclaveStrings.text("Turning Off Cameras\u{2026}")
            case .stopAllShares: return ConclaveStrings.text("Stopping Shares\u{2026}")
            case .lowerAllHands: return ConclaveStrings.text("Lowering Hands\u{2026}")
            }
        }
        switch row.bulk {
        case .muteAll: return ConclaveStrings.text("Mute Everyone\u{2026}")
        case .camerasOff: return ConclaveStrings.text("Turn Off Everyone\u{2019}s Camera\u{2026}")
        case .stopAllShares: return ConclaveStrings.text("Stop All Screen Shares\u{2026}")
        case .lowerAllHands: return ConclaveStrings.text("Lower All Hands")
        }
    }

    static func reason(_ raw: String) -> String? {
        switch raw {
        case PeopleActionReason.reconnecting, PeopleActionReason.notJoined:
            return ConclaveStrings.text("Unavailable while reconnecting")
        case PeopleActionReason.offline:
            return ConclaveStrings.text("Unavailable while offline")
        default:
            return nil
        }
    }

    static func onOff(_ on: Bool) -> String {
        on ? ConclaveStrings.text("On") : ConclaveStrings.text("Off")
    }

    static func accessSummary(_ access: HostAccessSummary) -> String {
        if access.allowedCount == 0 && access.blockedCount == 0 { return ConclaveStrings.text("None") }
        return ConclaveStrings.format("%lld allowed, %lld blocked", access.allowedCount, access.blockedCount)
    }
}

struct HostPolicyToggleRow: View {
    let people: PeoplePresenter
    let policy: HostPolicyID

    var body: some View {
        let row = people.host.snapshot.policy(policy)
        let pending = row?.isPending ?? false
        VStack(alignment: .leading, spacing: 6) {
            Toggle(isOn: Binding(get: { people.host.snapshot.policy(policy)?.shownOn ?? false },
                                 set: { people.host.setPolicy(policy, on: $0) })) {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(HostText.policyTitle(policy))
                        if let reason = HostText.reason(row?.reason ?? PeopleActionReason.none) {
                            Text(reason)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                    if pending {
                        ProgressView()
                            .accessibilityHidden(true)
                    }
                }
            }
            .disabled(!(row?.isEnabled ?? false))
            .accessibilityValue(pending ? ConclaveStrings.text("Updating") : "")
            .accessibilityIdentifier("host.policy." + policy.rawValue)
            HostInlineFailureLine(people: people, sourceKey: policy.rawValue)
        }
    }
}

struct HostInlineFailureLine: View {
    let people: PeoplePresenter
    let sourceKey: String

    var body: some View {
        if let failure = people.lastFailure, failure.sourceKey == sourceKey,
           failure.placement == HostFailurePlacement.panelInline.rawValue {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: ConclaveSymbols.exclamationmarkTriangleFill)
                    .foregroundStyle(Color(uiColor: .systemRed))
                    .accessibilityHidden(true)
                Text(PeopleActionText.failure(failure))
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button(ConclaveStrings.text("Retry")) {
                    people.retry(failureId: failure.id)
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("host.failure." + sourceKey + ".retry")
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("host.failure." + sourceKey)
        }
    }
}

struct HostBulkRowView: View {
    let people: PeoplePresenter
    let row: HostBulkRow

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                people.host.requestBulk(row.bulk)
            } label: {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(HostText.bulkTitle(row))
                        if let reason = HostText.reason(row.reason) {
                            Text(reason)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                    if row.isPending {
                        ProgressView()
                            .accessibilityHidden(true)
                    }
                }
            }
            .disabled(!row.isEnabled)
            .accessibilityIdentifier("host.bulk." + row.bulk.rawValue)
            .modifier(HostRowConfirmation(people: people, kinds: HostRowConfirmation.kinds(for: row.bulk)))
            HostInlineFailureLine(people: people, sourceKey: row.bulk.rawValue)
        }
    }
}

struct HostRowConfirmation: ViewModifier {
    let people: PeoplePresenter
    let kinds: [PeopleConfirmationKind]

    static func kinds(for bulk: HostBulkID) -> [PeopleConfirmationKind] {
        if let kind = HostControlsPolicy.confirmationKind(bulk) { return [kind] }
        return []
    }

    private func matching() -> PeopleConfirmation? {
        guard let current = people.confirmation, current.source == PeopleActionSource.hostControls,
              kinds.contains(current.kind) else { return nil }
        return current
    }

    func body(content: Content) -> some View {
        let mine = matching()
        content.confirmationDialog(mine.map { PeopleActionText.dialog($0).title } ?? "",
                                   isPresented: Binding(get: { mine != nil }, set: { shown in
                                       if !shown, let open = people.confirmation, open.source == PeopleActionSource.hostControls,
                                          kinds.contains(open.kind) {
                                           people.cancelConfirmation(id: open.id)
                                       }
                                   }),
                                   titleVisibility: .visible, presenting: mine) { confirmation in
            PeopleDialogButtons(people: people, confirmation: confirmation)
        } message: { confirmation in
            Text(PeopleActionText.dialog(confirmation).message)
        }
    }
}
#endif
