#if os(iOS) && !SKIP
import SwiftUI

// S50 3 (PPL-2): the iOS row actions. One shared action table (PeopleActionPolicy, PL7) feeds the trailing row `Menu`,
// the row `contextMenu` with a row preview (unavailable items hidden, HIG), the trailing swipe (Mute, Remove) and the
// named accessibility actions (AX4); confirmations are system dialogs anchored to the row for the row sources (3 j),
// the stage hosts the tile-menu ones in the in-call theme (R50-9, RECONCILE R19); Change Name is the PL10 alert that
// re-presents with the draft on a refusal (3 c); Participants row failures render once in a C12 banner pinned at the
// top of the List (PL14). Copy: S50 3 g is the single source for every people item on every surface.

/// S50 3 g, 6 g, 7 g copy for the action surfaces (Apple title case for items, titles and buttons; sentence case for
/// messages and failures).
enum PeopleActionText {
    static func titles(name: String) -> PeopleActionTitles {
        PeopleActionTitles(
            pin: ConclaveStrings.text("Pin"),
            unpin: ConclaveStrings.text("Unpin"),
            sendPrivateMessage: ConclaveStrings.text("Send Private Message"),
            hideMessages: ConclaveStrings.format("Hide Messages from %@", name),
            showMessages: ConclaveStrings.format("Show Messages from %@", name),
            changeName: ConclaveStrings.text("Change Name\u{2026}"),
            lowerHand: ConclaveStrings.text("Lower Hand"),
            mute: ConclaveStrings.text("Mute"),
            turnOffCamera: ConclaveStrings.text("Turn Off Camera"),
            stopScreenShare: ConclaveStrings.text("Stop Screen Share"),
            stopScreenAudio: ConclaveStrings.text("Stop Screen Audio"),
            makeCoHost: ConclaveStrings.text("Make Co-Host\u{2026}"),
            makeHost: ConclaveStrings.text("Make Host\u{2026}"),
            moveToAudience: ConclaveStrings.text("Move to Audience\u{2026}"),
            remove: ConclaveStrings.text("Remove from Meeting\u{2026}"),
            reasonReconnecting: ConclaveStrings.text("Unavailable while reconnecting"),
            reasonOffline: ConclaveStrings.text("Unavailable while offline"),
            reasonNotJoined: ConclaveStrings.text("Unavailable while reconnecting"),
            reasonPending: ConclaveStrings.text("In Progress"),
            reasonRenameDisabled: ConclaveStrings.text("Name changes are turned off for this meeting.")
        )
    }

    static func displayName(_ model: PersonRowModel) -> String {
        PeopleText.displayName(model)
    }

    /// "Actions for %@" on the trailing Menu (S50 2 i).
    static func menuLabel(_ model: PersonRowModel) -> String {
        ConclaveStrings.format("Actions for %@", displayName(model))
    }

    /// The menu symbol for a manifest concept (F00 7.3); R50-4 concepts have none yet, so their groups are icon-free.
    static func symbol(_ item: MenuItemModel) -> String? {
        ConclaveMenuSymbols.symbol(for: item.concept)
    }

    // MARK: Confirmations (S50 3 g, 6 g, 7 g)

    struct DialogCopy {
        let title: String
        let message: String
        let confirm: String
        let isDestructive: Bool
        /// "Remove and Block" when the core knows the key (PH13, Q7).
        let blockTitle: String?
    }

    static func dialog(_ confirmation: PeopleConfirmation) -> DialogCopy {
        let name = confirmation.targetName
        switch confirmation.kind {
        case .remove:
            var message = ConclaveStrings.format("%@ will leave the meeting. They can join again with the link unless you block them.", name)
            if confirmation.canBlock && confirmation.isGuest {
                message += " " + ConclaveStrings.text("A blocked guest can still join from another device.")
            }
            return DialogCopy(title: ConclaveStrings.format("Remove %@?", name), message: message,
                              confirm: ConclaveStrings.text("Remove"), isDestructive: true,
                              blockTitle: confirmation.canBlock ? ConclaveStrings.text("Remove and Block") : nil)
        case .makeCoHost:
            return DialogCopy(title: ConclaveStrings.format("Make %@ a Co-Host?", name),
                              message: ConclaveStrings.text("Co-hosts can admit people, mute or remove participants and change meeting settings. This lasts until the meeting ends."),
                              confirm: ConclaveStrings.text("Make Co-Host"), isDestructive: false, blockTitle: nil)
        case .makeHost:
            return DialogCopy(title: ConclaveStrings.format("Make %@ the Host?", name),
                              message: ConclaveStrings.format("%@ becomes the host. You stay in the meeting as a co-host.", name),
                              confirm: ConclaveStrings.text("Make Host"), isDestructive: false, blockTitle: nil)
        case .moveToAudience:
            return DialogCopy(title: ConclaveStrings.format("Move %@ to the Audience?", name),
                              message: ConclaveStrings.format("%@ leaves the stage and keeps watching as an attendee. They can\u{2019}t rejoin as a panelist while webinar mode is on.", name),
                              confirm: ConclaveStrings.text("Move to Audience"), isDestructive: true, blockTitle: nil)
        case .denyAll:
            return DialogCopy(title: ConclaveStrings.format("Deny %lld People?", confirmation.count),
                              message: ConclaveStrings.text("They won\u{2019}t join this meeting. They can ask to join again."),
                              confirm: ConclaveStrings.text("Deny All"), isDestructive: true, blockTitle: nil)
        case .muteAll:
            return DialogCopy(title: ConclaveStrings.text("Mute Everyone?"),
                              message: ConclaveStrings.text("Everyone except hosts is muted. People can unmute again unless unmuting is turned off."),
                              confirm: ConclaveStrings.text("Mute Everyone"), isDestructive: false, blockTitle: nil)
        case .camerasOff:
            return DialogCopy(title: ConclaveStrings.text("Turn Off Everyone\u{2019}s Camera?"),
                              message: ConclaveStrings.text("Everyone except hosts stops sending video. People can turn their camera back on unless video is turned off."),
                              confirm: ConclaveStrings.text("Turn Off Cameras"), isDestructive: false, blockTitle: nil)
        case .stopAllShares:
            return DialogCopy(title: ConclaveStrings.text("Stop All Screen Shares?"),
                              message: ConclaveStrings.text("Everyone who is presenting stops sharing."),
                              confirm: ConclaveStrings.text("Stop All Shares"), isDestructive: false, blockTitle: nil)
        case .clearInviteCode, .clearAttendeeCode:
            return DialogCopy(title: ConclaveStrings.text("Remove Invite Code?"),
                              message: ConclaveStrings.text("People can join without a code. Anyone already waiting stays in the waiting room."),
                              confirm: ConclaveStrings.text("Remove Code"), isDestructive: true, blockTitle: nil)
        case .block:
            return DialogCopy(title: ConclaveStrings.format("Block %@?", name),
                              message: ConclaveStrings.text("They can\u{2019}t join this meeting. If they\u{2019}re here, they\u{2019}re removed now."),
                              confirm: ConclaveStrings.text("Block"), isDestructive: true, blockTitle: nil)
        case .rotateWebinarLink:
            return DialogCopy(title: ConclaveStrings.text("Rotate Webinar Link?"),
                              message: ConclaveStrings.text("Anyone with the old link can no longer join. You\u{2019}ll get a new link to share."),
                              confirm: ConclaveStrings.text("Rotate Link"), isDestructive: true, blockTitle: nil)
        }
    }

    // MARK: Failures (PL14 copy, S50 3 g, 6 g, 7 g, 8 g; RECONCILE R17)

    static func failure(_ model: HostActionFailureModel) -> String {
        failure(kind: PeopleFailureCopy.kind(action: model.action, failure: model.failure, sourceKey: model.sourceKey),
                name: model.targetName, sourceKey: model.sourceKey)
    }

    static func failure(kind: String, name: String, sourceKey: String) -> String {
        switch kind {
        case PeopleFailureCopy.cantRemove: return ConclaveStrings.text("This person can\u{2019}t be removed.")
        case PeopleFailureCopy.rateLimited: return ConclaveStrings.text("Too many host actions. Try again in a moment.")
        case PeopleFailureCopy.reconnect: return ConclaveStrings.text("Reconnect to use host controls.")
        case PeopleFailureCopy.alreadyLeft: return ConclaveStrings.text("That person already left.")
        case PeopleFailureCopy.mute: return ConclaveStrings.format("Couldn\u{2019}t mute %@.", name)
        case PeopleFailureCopy.camera: return ConclaveStrings.format("Couldn\u{2019}t turn off %@\u{2019}s camera.", name)
        case PeopleFailureCopy.share, PeopleFailureCopy.shareAudio:
            return ConclaveStrings.format("Couldn\u{2019}t stop %@\u{2019}s screen share.", name)
        case PeopleFailureCopy.remove: return ConclaveStrings.format("Couldn\u{2019}t remove %@.", name)
        case PeopleFailureCopy.coHost: return ConclaveStrings.format("Couldn\u{2019}t make %@ a co-host.", name)
        case PeopleFailureCopy.host: return ConclaveStrings.format("Couldn\u{2019}t make %@ the host.", name)
        case PeopleFailureCopy.audience: return ConclaveStrings.format("Couldn\u{2019}t move %@ to the audience.", name)
        case PeopleFailureCopy.rename: return ConclaveStrings.text("Couldn\u{2019}t change your name.")
        case PeopleFailureCopy.lockMeeting: return ConclaveStrings.text("Couldn\u{2019}t change the meeting lock. Try again.")
        case PeopleFailureCopy.policy:
            return ConclaveStrings.format("Couldn\u{2019}t update %@.", HostText.policyTitle(HostPolicyID(rawValue: sourceKey)))
        case PeopleFailureCopy.muteAll: return ConclaveStrings.text("Couldn\u{2019}t mute everyone.")
        case PeopleFailureCopy.cameras: return ConclaveStrings.text("Couldn\u{2019}t turn off cameras.")
        case PeopleFailureCopy.shares: return ConclaveStrings.text("Couldn\u{2019}t stop screen shares.")
        case PeopleFailureCopy.codeSave: return ConclaveStrings.text("Couldn\u{2019}t save the invite code.")
        case PeopleFailureCopy.codeRemove: return ConclaveStrings.text("Couldn\u{2019}t remove the invite code.")
        case PeopleFailureCopy.access: return ConclaveStrings.text("Couldn\u{2019}t update the access list.")
        case PeopleFailureCopy.notice: return ConclaveStrings.text("Couldn\u{2019}t send the notice.")
        default: return ConclaveStrings.text("That didn\u{2019}t go through. Try again.")
        }
    }

    /// The stage toast for a tile-menu failure (S20 10, PL14 stage placement); the notice carries the action and the
    /// typed failure in its detail.
    static func stageToast(_ notice: MeetingNotice) -> String {
        let kind = PeopleFailureCopy.kind(action: PeopleFailurePlacementPolicy.stageAction(notice.detail),
                                          failure: PeopleFailurePlacementPolicy.stageFailure(notice.detail), sourceKey: notice.userId)
        return failure(kind: kind, name: notice.name, sourceKey: notice.userId)
    }

    // MARK: Rename (S50 3 c, 3 g; RECONCILE R38)

    static func renameRefusal(_ raw: String) -> String {
        switch HostActionFailure(rawValue: raw) {
        case .renameRateLimited: return ConclaveStrings.text("You\u{2019}re changing your name too quickly. Try again in a moment.")
        case .renameDisabled: return ConclaveStrings.text("Name changes are turned off for this meeting.")
        case .renameTooLong: return ConclaveStrings.text("Use 40 characters or fewer.")
        default: return ConclaveStrings.text("Couldn\u{2019}t change your name.")
        }
    }

    static func renameModel(draft: String, refusal: String) -> ConclaveTextEntryDialogModel {
        var message = ConclaveStrings.text("Up to 40 characters. Everyone sees the new name.")
        if !refusal.isEmpty {
            message = renameRefusal(refusal)
        } else if DisplayNamePolicy.isCounterVisible(count: draft.count) {
            message = ConclaveStrings.format("%lld of %lld characters", draft.count, DisplayNamePolicy.limit)
        }
        return ConclaveTextEntryDialogModel(kind: .name, title: ConclaveStrings.text("Change Your Name"), message: message,
                                            fieldLabel: ConclaveStrings.text("Name"), confirmTitle: ConclaveStrings.text("Save"),
                                            limit: DisplayNamePolicy.limit, counterFrom: DisplayNamePolicy.counterThreshold)
    }

    // MARK: Announcements (S50 3 i, 6 f, 8 i; the S20 one-shot channel)

    static func announcement(_ announcement: StageAnnouncement) -> String? {
        switch announcement.kind {
        case PeopleAnnouncementKind.madeCoHost: return ConclaveStrings.format("%@ is now a co-host.", announcement.name)
        case PeopleAnnouncementKind.madeHost: return ConclaveStrings.format("%@ is now the host.", announcement.name)
        case PeopleAnnouncementKind.removed: return ConclaveStrings.format("%@ was removed.", announcement.name)
        case PeopleAnnouncementKind.policyOn:
            return ConclaveStrings.format("%@ turned on by another host.", HostText.policyTitle(HostPolicyID(rawValue: announcement.name)))
        case PeopleAnnouncementKind.policyOff:
            return ConclaveStrings.format("%@ turned off by another host.", HostText.policyTitle(HostPolicyID(rawValue: announcement.name)))
        case PeopleAnnouncementKind.noticeSent: return ConclaveStrings.text("Notice sent")
        default: return nil
        }
    }
}

// MARK: Row surfaces

/// The trailing row `Menu` (S50 3 c): groups as system sections in the PL7 order, unavailable items kept disabled with
/// their reason (R10). Content builds only when the menu opens.
struct PeopleRowMenu: View {
    let people: PeoplePresenter
    let model: PersonRowModel
    let sectionId: String

    var body: some View {
        if !model.actions.isEmpty {
            Menu {
                ConclaveMenuContent(sections: PeopleActionPolicy.menuSections(model.actions,
                                                                              titles: PeopleActionText.titles(name: PeopleActionText.displayName(model))),
                                    symbol: { PeopleActionText.symbol($0) },
                                    onSelect: { item in perform(item) })
            } label: {
                Image(systemName: ConclaveSymbols.ellipsis)
                    .frame(width: PeopleRowMetrics.trailingTarget, height: PeopleRowMetrics.trailingTarget)
                    .contentShape(Rectangle())
            }
            .menuOrder(.fixed)
            .accessibilityLabel(PeopleActionText.menuLabel(model))
            .accessibilityIdentifier("people.row." + sectionId + "." + model.id + ".menu")
        }
    }

    private func perform(_ item: MenuItemModel) {
        guard let action = PersonActionID(rawValue: item.id) else { return }
        people.perform(action, rowId: model.id, source: PeopleActionSource.rowMenu)
    }
}

/// The row's context menu with a row preview (no renderer), the trailing swipe, and the row-anchored confirmation
/// dialog (S50 3 c, 3 j). It reads only this row's entry, so a dialog re-evaluates one row (3 k).
struct PeopleRowActionsModifier: ViewModifier {
    let people: PeoplePresenter
    let entry: PersonRowEntry
    let sectionId: String

    func body(content: Content) -> some View {
        let model = entry.model
        let available = PeopleActionPolicy.availableActions(model.actions)
        let swipes = PeopleActionPolicy.swipeActions(model.actions)
        content
            .contextMenu {
                if !available.isEmpty {
                    ConclaveMenuContent(sections: PeopleActionPolicy.menuSections(available,
                                                                                  titles: PeopleActionText.titles(name: PeopleActionText.displayName(model))),
                                        symbol: { PeopleActionText.symbol($0) },
                                        onSelect: { item in
                                            if let action = PersonActionID(rawValue: item.id) {
                                                people.perform(action, rowId: model.id, source: PeopleActionSource.rowMenu)
                                            }
                                        })
                }
            } preview: {
                PeopleRowPreview(model: model)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                ForEach(swipes) { item in
                    if item.action == PersonActionID.remove {
                        Button(role: .destructive) {
                            people.perform(item.action, rowId: model.id, source: PeopleActionSource.swipe)
                        } label: {
                            Label(ConclaveStrings.text("Remove"), systemImage: ConclaveSymbols.personFillXmark)
                        }
                    } else {
                        Button {
                            people.perform(item.action, rowId: model.id, source: PeopleActionSource.swipe)
                        } label: {
                            Label(ConclaveStrings.text("Mute"), systemImage: ConclaveSymbols.micSlash)
                        }
                        .tint(Color(uiColor: .systemGray))
                    }
                }
            }
            .modifier(PeopleRowConfirmation(people: people, entry: entry))
    }
}

/// The row-anchored system dialog (iOS 26 action sheets originate from their source; a popover on iPad, R09).
private struct PeopleRowConfirmation: ViewModifier {
    let people: PeoplePresenter
    let entry: PersonRowEntry

    func body(content: Content) -> some View {
        let confirmation = entry.confirmation
        let copy = confirmation.map { PeopleActionText.dialog($0) }
        content.confirmationDialog(copy?.title ?? "", isPresented: Binding(get: { entry.confirmation != nil }, set: { shown in
            if !shown, let current = entry.confirmation { people.cancelConfirmation(id: current.id) }
        }), titleVisibility: .visible, presenting: confirmation) { current in
            PeopleDialogButtons(people: people, confirmation: current)
        } message: { current in
            Text(PeopleActionText.dialog(current).message)
        }
    }
}

/// One confirm (destructive in system red for destructive kinds, never coral), "Remove and Block" when offered, Cancel.
struct PeopleDialogButtons: View {
    let people: PeoplePresenter
    let confirmation: PeopleConfirmation

    var body: some View {
        let copy = PeopleActionText.dialog(confirmation)
        Button(copy.confirm, role: copy.isDestructive ? .destructive : nil) {
            people.confirm(id: confirmation.id, block: false)
        }
        .accessibilityIdentifier("people.dialog." + confirmation.kind.rawValue + ".confirm")
        if let blockTitle = copy.blockTitle {
            Button(blockTitle, role: .destructive) {
                people.confirm(id: confirmation.id, block: true)
            }
            .accessibilityIdentifier("people.dialog." + confirmation.kind.rawValue + ".block")
        }
        Button(ConclaveStrings.text("Cancel"), role: .cancel) {
            people.cancelConfirmation(id: confirmation.id)
        }
    }
}

/// The context menu preview: avatar, name and sub line; never a renderer (S50 3 c).
private struct PeopleRowPreview: View {
    let model: PersonRowModel

    var body: some View {
        ConclavePersonRow(name: PeopleText.displayName(model), detail: PeopleText.subLine(model), lineLimit: 2,
                          identifier: "people.row.preview." + model.id) {
            ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(model.avatarSeed), size: .row)
        }
        .padding(16)
        .frame(minWidth: 280, alignment: .leading)
        .accessibilityHidden(true)
    }
}

/// AX4: every available item is a named action on the row's one element.
struct PeopleRowAccessibilityActions: ViewModifier {
    let model: PersonRowModel
    let onAction: ((PersonActionID) -> Void)?

    func body(content: Content) -> some View {
        if let onAction, !model.actions.isEmpty {
            let titles = PeopleActionText.titles(name: PeopleActionText.displayName(model))
            content.accessibilityActions {
                ForEach(PeopleActionPolicy.availableActions(model.actions)) { item in
                    Button(PeopleActionPolicy.title(item.action, titles: titles)) { onAction(item.action) }
                }
            }
        } else {
            content
        }
    }
}

// MARK: Panel leaves

/// PL14 inline placement for Participants row actions: one C12 app banner pinned at the top of the List with Retry and
/// Dismiss; it reads only `people.lastFailure`.
struct PeopleFailureBannerSection: View {
    let people: PeoplePresenter

    var body: some View {
        if let failure = people.lastFailure, failure.placement == HostFailurePlacement.panelInline.rawValue,
           PeopleFailureScope.isRowFailure(failure) {
            Section {
                ConclaveBanner(kind: .error, text: PeopleActionText.failure(failure), surface: .app,
                               actions: [ConclaveBannerAction(title: ConclaveStrings.text("Retry"), identifier: "people.failure.retry",
                                                              action: { people.retry(failureId: failure.id) })],
                               onDismiss: { people.dismissFailure(id: failure.id) }, identifier: "people.failure")
            }
        }
    }
}

/// Which failures the Participants banner shows (row actions and the rename refusal are not host page fields).
enum PeopleFailureScope {
    static func isRowFailure(_ failure: HostActionFailureModel) -> Bool {
        guard let kind = PeopleCommandKind(rawValue: failure.action) else { return false }
        switch kind {
        case .admit, .deny, .admitAll, .denyAll, .mute, .turnOffCamera, .stopScreenShare, .stopScreenAudio, .remove, .block,
             .makeCoHost, .makeHost, .moveToAudience, .bringOnStage, .cancelStageInvite:
            return true
        default:
            return false
        }
    }
}

/// S50 3 c: the Change Name alert (PL10), one per panel. A refusal re-presents it with the draft and the reason; the
/// input stops at 40 and the message shows the counter from 30 (RECONCILE R38).
struct PeopleRenameAlertHost: ViewModifier {
    let people: PeoplePresenter
    @State private var draft = ""

    func body(content: Content) -> some View {
        let rename = people.rename
        let shown = rename.phase == PeopleRenamePhase.editing || rename.phase == PeopleRenamePhase.refused
        content
            .conclaveTextEntryDialog(PeopleActionText.renameModel(draft: draft, refusal: rename.refusal), text: $draft,
                                     isPresented: Binding(get: { shown }, set: { isShown in
                                         if !isShown && (people.rename.phase == PeopleRenamePhase.editing
                                                         || people.rename.phase == PeopleRenamePhase.refused) {
                                             people.cancelRename()
                                         }
                                     }),
                                     identifier: "people.rename",
                                     onConfirm: { people.submitRename(draft) },
                                     onCancel: { people.cancelRename() })
            .onChange(of: rename.id) { _, _ in
                draft = people.rename.draft
            }
    }
}

// MARK: Stage host (R50-9)

extension View {
    /// The tile-menu confirmations (source `tileMenu`) over the stage in the in-call theme (S20 3 j, R50-9, RECONCILE
    /// R19). The native call root attaches it once (HD request B5-T1 R3).
    func peopleStageConfirmations(_ people: PeoplePresenter?) -> some View {
        modifier(PeopleStageConfirmationHost(people: people))
    }
}

private struct PeopleStageConfirmationHost: ViewModifier {
    let people: PeoplePresenter?

    func body(content: Content) -> some View {
        if let people {
            content.modifier(PeopleStageConfirmationDialog(people: people))
        } else {
            content
        }
    }
}

private struct PeopleStageConfirmationDialog: ViewModifier {
    let people: PeoplePresenter

    func body(content: Content) -> some View {
        let current = people.confirmation
        let staged = current?.source == PeopleActionSource.tileMenu ? current : nil
        content.confirmationDialog(staged.map { PeopleActionText.dialog($0).title } ?? "",
                                   isPresented: Binding(get: { staged != nil }, set: { shown in
                                       if !shown, let open = people.confirmation, open.source == PeopleActionSource.tileMenu {
                                           people.cancelConfirmation(id: open.id)
                                       }
                                   }),
                                   titleVisibility: .visible, presenting: staged) { confirmation in
            PeopleDialogButtons(people: people, confirmation: confirmation)
        } message: { confirmation in
            Text(PeopleActionText.dialog(confirmation).message)
        }
    }
}
#endif
