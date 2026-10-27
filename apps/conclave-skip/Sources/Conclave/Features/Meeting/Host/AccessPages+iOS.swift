#if os(iOS) && !SKIP
import SwiftUI

// S50 7 (PPL-4): the meeting access pages on iOS. Field text is view state seeded once from `host.drafts` and written
// back on change (7 c), so validity and the button state derive from the local draft and the draft survives pushes;
// PH15: a field clears only after its acknowledgement. Remove Code and Block confirm from their buttons (S50 3 j).
// Failures render inline under the field or button (PL14); "Code saved" shows inline for 2 s (F00 C13, R50-10).

/// Invite Code (S50 7 c): the status, the new code field, Save Code, and Remove Code when one is set. The current code
/// is never shown (the server returns only whether one is set).
struct InviteCodePage: View {
    let people: PeoplePresenter
    @State private var draft = ""
    @State private var didSeed = false
    @State private var showsSaved = false
    @State private var savedToken = 0

    var body: some View {
        let host = people.host
        let snapshot = host.snapshot
        let saving = snapshot.inviteCodePhase == HostFieldPhase.sending
        let blocked = snapshot.blockedReason != MeetingBlockedReason.none.rawValue
        Form {
            Section {
                LabeledContent(ConclaveStrings.text("Status"), value: HostText.onOff(snapshot.access.requiresCode))
            }
            Section {
                TextField(ConclaveStrings.text("New Code"), text: $draft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit { save() }
                    .disabled(saving || blocked)
                    .accessibilityIdentifier("host.inviteCode.field")
                HostInlineFailureLine(people: people, sourceKey: HostFieldID.inviteCode)
            } footer: {
                Text(ConclaveStrings.text("People need this code to join. Share it with the meeting link."))
            }
            Section {
                Button {
                    save()
                } label: {
                    HStack(spacing: 8) {
                        Text(ConclaveStrings.text("Save Code"))
                        Spacer(minLength: 0)
                        if saving { ProgressView().accessibilityHidden(true) }
                    }
                }
                .disabled(!HostControlsPolicy.canSaveInviteCode(draft, isPending: saving, isBlocked: blocked))
                .accessibilityIdentifier("host.inviteCode.save")
                if showsSaved {
                    Label(ConclaveStrings.text("Code saved"), systemImage: ConclaveSymbols.checkmark)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("host.inviteCode.saved")
                }
                if snapshot.access.requiresCode {
                    Button(ConclaveStrings.text("Remove Code\u{2026}"), role: .destructive) {
                        host.requestClearMeetingInviteCode()
                    }
                    .disabled(saving || blocked)
                    .modifier(HostRowConfirmation(people: people, kinds: [PeopleConfirmationKind.clearInviteCode]))
                    .accessibilityIdentifier("host.inviteCode.remove")
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(ConclaveStrings.text("Invite Code"))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            // Seeded once per page instance (a guarded write, so a re-fired callback is a no-op).
            if !didSeed {
                didSeed = true
                draft = host.drafts.meetingCode
            }
        }
        .onChange(of: draft) { _, value in
            host.drafts.meetingCode = value
        }
        .onChange(of: snapshot.inviteCodeSavedSerial) { _, _ in
            // PH15: the presenter cleared the draft on the acknowledgement; the field follows.
            draft = host.drafts.meetingCode
            showsSaved = true
            savedToken += 1
            AccessibilityNotification.Announcement(ConclaveStrings.text("Code saved")).post()
        }
        .task(id: savedToken) {
            guard savedToken > 0 else { return }
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { showsSaved = false }
        }
        .accessibilityIdentifier("host.page.inviteCode")
    }

    private func save() {
        people.host.setMeetingInviteCode(draft)
    }
}

/// Access List (S50 7 c): Allow and Block by user key or email, the allowed and blocked lists with swipe Revoke and
/// Unblock, and the toolbar refresh whose spinner shows exactly while `access.isRefreshing` (no `.refreshable`: the
/// refresh is fire and forget, so a pull would end at once). Lists refresh once on appear.
struct AccessListPage: View {
    let people: PeoplePresenter
    @State private var keyDraft = ""
    @State private var didSeed = false

    var body: some View {
        let host = people.host
        let snapshot = host.snapshot
        let access = snapshot.access
        let blocked = snapshot.blockedReason != MeetingBlockedReason.none.rawValue
        let valid = HostControlsPolicy.normalizedAccessKey(keyDraft) != nil
        List {
            Section {
                TextField(ConclaveStrings.text("User Key or Email"), text: $keyDraft)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit { if valid { host.allow(keyDraft) } }
                    .disabled(blocked)
                    .accessibilityIdentifier("host.access.field")
                if HostControlsPolicy.showsInvalidAccessKey(keyDraft) {
                    Text(ConclaveStrings.text("Enter a valid user key or email."))
                        .font(.footnote)
                        .foregroundStyle(Color(uiColor: .systemRed))
                        .accessibilityIdentifier("host.access.invalid")
                }
                HStack(spacing: 12) {
                    Button(ConclaveStrings.text("Allow")) { host.allow(keyDraft) }
                        .buttonStyle(.bordered)
                        .tint(.primary)
                        .disabled(!valid || blocked)
                        .accessibilityIdentifier("host.access.allow")
                    Button(ConclaveStrings.text("Block\u{2026}")) { host.requestBlock(keyDraft) }
                        .buttonStyle(.bordered)
                        .tint(Color(uiColor: .systemRed))
                        .disabled(!valid || blocked)
                        .modifier(HostRowConfirmation(people: people, kinds: [PeopleConfirmationKind.block]))
                        .accessibilityIdentifier("host.access.block")
                }
                HostInlineFailureLine(people: people, sourceKey: HostFieldID.accessKey)
            } footer: {
                Text(ConclaveStrings.text("Allowed people skip the waiting room, even when the meeting is locked. Blocked people can\u{2019}t join and are removed if they\u{2019}re here."))
            }
            Section {
                if access.allowed.isEmpty {
                    Text(ConclaveStrings.text("No one is on the allow list."))
                        .foregroundStyle(.secondary)
                }
                ForEach(access.allowed, id: \.self) { key in
                    HStack(spacing: 8) {
                        LabeledContent {
                            if access.lockedAllowed.contains(key) {
                                Text(ConclaveStrings.text("Also while locked"))
                            }
                        } label: {
                            Text(key).textSelection(.enabled)
                        }
                        if snapshot.pendingAccessKeys.contains(key) { ProgressView().accessibilityHidden(true) }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(ConclaveStrings.text("Revoke"), role: .destructive) { host.revoke(key) }
                    }
                    .contextMenu {
                        Button(ConclaveStrings.text("Revoke"), role: .destructive) { host.revoke(key) }
                    }
                    .accessibilityAction(named: Text(ConclaveStrings.text("Revoke"))) { host.revoke(key) }
                }
            } header: {
                ConclaveSectionHeader(ConclaveStrings.text("Allowed"), count: access.allowedCount,
                                      identifier: "host.access.allowed.header")
                    .textCase(nil)
            }
            Section {
                if access.blocked.isEmpty {
                    Text(ConclaveStrings.text("No one is blocked."))
                        .foregroundStyle(.secondary)
                }
                ForEach(access.blocked, id: \.self) { key in
                    HStack(spacing: 8) {
                        Text(key).textSelection(.enabled)
                        Spacer(minLength: 0)
                        if snapshot.pendingAccessKeys.contains(key) { ProgressView().accessibilityHidden(true) }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(ConclaveStrings.text("Unblock")) { host.unblock(key) }
                            .tint(Color(uiColor: .systemGray))
                    }
                    .contextMenu {
                        Button(ConclaveStrings.text("Unblock")) { host.unblock(key) }
                    }
                    .accessibilityAction(named: Text(ConclaveStrings.text("Unblock"))) { host.unblock(key) }
                }
            } header: {
                ConclaveSectionHeader(ConclaveStrings.text("Blocked"), count: access.blockedCount,
                                      identifier: "host.access.blocked.header")
                    .textCase(nil)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(ConclaveStrings.text("Access List"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if access.isRefreshing {
                    ProgressView()
                } else {
                    Button {
                        host.refreshAccessLists()
                    } label: {
                        Label(ConclaveStrings.text("Refresh Access List"), systemImage: HostAccessSymbols.refresh)
                    }
                    .accessibilityIdentifier("host.access.refresh")
                }
            }
        }
        .onAppear {
            if !didSeed {
                didSeed = true
                keyDraft = host.drafts.accessKey
            }
        }
        .onChange(of: keyDraft) { _, value in
            host.drafts.accessKey = value
        }
        .onChange(of: snapshot.pendingAccessKeys) { _, _ in
            // PH15: the presenter clears the draft only after an Allow or Block succeeds.
            if host.drafts.accessKey != keyDraft { keyDraft = host.drafts.accessKey }
        }
        .task {
            host.refreshAccessLists()
        }
        .accessibilityIdentifier("host.page.accessList")
    }
}

/// `arrow.clockwise` is a system symbol the manifest has no concept for yet (S50 7 c names it directly).
enum HostAccessSymbols {
    static let refresh = "arrow.clockwise"
}
#endif
